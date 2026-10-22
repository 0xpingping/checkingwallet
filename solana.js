/**
 * Solana watcher. A Helius websocket logsSubscribe({ mentions: [wallet] }) per wallet pushes "something
 * happened"; then getSignaturesForAddress since the last seen signature gives the new txs, and the
 * Helius enhanced-transactions API tells what the wallet gained/lost in each. A 60s poll of every
 * wallet backs up the websocket (reconnects, missed pushes).
 */
import { createHash } from "node:crypto";
import bs58 from "bs58";
import WebSocket from "ws";
import { getState, saveState, solWallets, labelOf, short, wants } from "./store.js";
import { send, esc } from "./telegram.js";
import { buildAlert, titleFor, fmtUnits } from "./format.js";

const KEY = process.env.HELIUS_API_KEY;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const WSS = `wss://mainnet.helius-rpc.com/?api-key=${KEY}`;
const PARSE = `https://api-mainnet.helius-rpc.com/v0/transactions?api-key=${KEY}`;
const POLL_MS = 60_000;
// incoming-only SOL below this is address-poisoning dust, not worth an alert
const MIN_IN = BigInt(Math.round(Number(process.env.SOL_MIN_INCOMING ?? 0.001) * 1e9));

// Jito tip accounts: system-owned like wallets, but a tip is not "sending money to someone"
const JITO_TIPS = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";

// LP programs and their swap instructions (Anchor discriminators). Any other instruction on them —
// add/remove liquidity, open/close position, claim fees — means the tx is LP activity, not a swap.
const anchorId = (s) => createHash("sha256").update(s).digest().subarray(0, 8).toString("hex");
const EVENT_CPI = "e445a52e51cb9a1d"; // Anchor emit_cpi tag: self-call programs make to log an event
const LP_PROGRAMS = Object.fromEntries(
  Object.entries({
    LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: ["swap", "swap2", "swap_exact_out", "swap_exact_out2", "swap_with_price_impact", "swap_with_price_impact2"], // Meteora DLMM
    cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: ["swap", "swap2"], // Meteora DAMM v2
    Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: ["swap"], // Meteora DAMM v1
    whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: ["swap", "swap_v2", "two_hop_swap", "two_hop_swap_v2"], // Orca Whirlpool
    CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: ["swap", "swap_v2", "swap_router_base_in"], // Raydium CLMM
    CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: ["swap_base_input", "swap_base_output"], // Raydium CPMM
    pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: ["buy", "sell", "buy_exact_quote_in"], // PumpSwap
  }).map(([program, names]) => [program, new Set([...names.map((n) => anchorId(`global:${n}`)), EVENT_CPI])]),
);

export function hasLpInstruction(t) {
  for (const ix of (t.instructions || []).flatMap((i) => [i, ...(i.innerInstructions || [])])) {
    const swaps = LP_PROGRAMS[ix.programId];
    if (!swaps) continue;
    let id;
    try {
      id = Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString("hex");
    } catch {
      continue;
    }
    if (!swaps.has(id)) return true;
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

/** Enhanced (parsed) txs by signature; retried briefly because Helius indexes a few seconds behind. */
export async function parseTxs(sigs) {
  const out = new Map();
  for (let attempt = 0; attempt < 4 && out.size < sigs.length; attempt++) {
    if (attempt) await sleep(3000);
    const todo = sigs.filter((s) => !out.has(s));
    for (let i = 0; i < todo.length; i += 100) {
      try {
        const res = await fetch(PARSE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transactions: todo.slice(i, i + 100) }),
          signal: AbortSignal.timeout(20000),
        });
        const arr = await res.json();
        if (Array.isArray(arr)) for (const t of arr) if (t?.signature) out.set(t.signature, t);
      } catch (e) {
        console.warn("[sol] parse failed:", e.message);
      }
    }
  }
  return out;
}

const symbols = new Map();

async function loadSymbols(mints) {
  const missing = [...new Set(mints)].filter((m) => !symbols.has(m));
  if (missing.length) {
    try {
      for (const a of (await rpc("getAssetBatch", { ids: missing })) || []) {
        if (a) symbols.set(a.id, a.token_info?.symbol || a.content?.metadata?.symbol || short(a.id));
      }
    } catch (e) {
      console.warn("[sol] getAssetBatch failed:", e.message);
    }
  }
  return (m) => symbols.get(m) || short(m);
}

/**
 * Whether any recipient is a plain wallet (system-owned) rather than a pool/program account. An account
 * that no longer exists only counts for token recipients (a fresh wallet with 0 SOL); for SOL it is a
 * temp account (e.g. wrapped SOL) created and closed inside the tx.
 */
async function anyWallet(solTo, tokenTo) {
  const addrs = [...new Set([...solTo, ...tokenTo])];
  if (!addrs.length) return false;
  const res = await rpc("getMultipleAccounts", [addrs, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
  return res.value.some((acc, i) => acc?.owner === SYSTEM_PROGRAM || (!acc && tokenTo.has(addrs[i])));
}

const solscanAccount = (a) => `<a href="https://solscan.io/account/${a}">${esc(labelOf(a))}</a>`;

export async function solAlert(addr, t) {
  const signer = t.feePayer === addr;
  const failed = !!t.transactionError;
  if (failed && !signer) return null;

  const fee = signer ? BigInt(t.fee || 0) : 0n;
  let sol = BigInt(t.accountData?.find((x) => x.account === addr)?.nativeBalanceChange ?? 0) + fee;
  const tok = new Map(); // mint -> { amount, decimals }
  for (const ad of t.accountData || []) {
    for (const ch of ad.tokenBalanceChanges || []) {
      if (ch.userAccount !== addr) continue;
      if (ch.mint === WSOL) {
        sol += BigInt(ch.rawTokenAmount.tokenAmount); // wrapped SOL is still the wallet's SOL
        continue;
      }
      const cur = tok.get(ch.mint) || { amount: 0n, decimals: ch.rawTokenAmount.decimals };
      cur.amount += BigInt(ch.rawTokenAmount.tokenAmount);
      tok.set(ch.mint, cur);
    }
  }
  for (const [m, v] of tok) if (v.amount === 0n) tok.delete(m);
  if (!signer && !tok.size && sol < MIN_IN) return null;

  const sym = await loadSymbols([...tok.keys()]);
  const outs = [];
  const ins = [];
  if (sol < 0n) outs.push({ amount: -sol, decimals: 9, symbol: "SOL" });
  if (sol > 0n) ins.push({ amount: sol, decimals: 9, symbol: "SOL" });
  for (const [m, v] of tok) (v.amount < 0n ? outs : ins).push({ amount: v.amount < 0n ? -v.amount : v.amount, decimals: v.decimals, symbol: sym(m) });

  // LP activity, a swap, or money leaving to another wallet (or moved out without the wallet
  // signing); receives and failed txs get no alert
  const lp = /LIQUIDITY|POSITION|DEPOSIT|WITHDRAW|STAKE/.test(t.type || "") || hasLpInstruction(t);
  const sentTo = (list) => new Set(list.filter((x) => x.fromUserAccount === addr && x.toUserAccount && x.toUserAccount !== addr).map((x) => x.toUserAccount));
  const solTo = sentTo((t.nativeTransfers || []).filter((x) => x.amount >= 1e6 && !JITO_TIPS.has(x.toUserAccount)));
  const tokenTo = sentTo(t.tokenTransfers || []);
  let kind = null;
  if (failed) kind = null;
  else if (lp && signer && (outs.length || ins.length)) kind = "lp";
  else if (outs.length && ins.length && !lp) kind = "swap";
  else if (!signer && outs.length && !ins.length) kind = "send";
  else if (signer && outs.length && !lp && (await anyWallet(solTo, tokenTo))) kind = "send";
  if (!kind || !wants(addr, kind)) return null;

  const title = titleFor(kind, { outs, ins, signer });
  const subtitle = [t.type, t.source].filter((x) => x && x !== "UNKNOWN").join(" · ").replaceAll("_", " ");
  const extra = [];
  const to = new Set([...solTo, ...tokenTo]);
  if (kind === "send" && to.size && to.size <= 3) extra.push(`To: ${[...to].map(solscanAccount).join(", ")}`);
  if (signer) extra.push(`Fee: ${fmtUnits(fee, 9)} SOL`);

  return buildAlert({ address: addr, chain: "Solana", title, subtitle, outs, ins, extra, link: `https://solscan.io/tx/${t.signature}` });
}

async function pollNow(addr) {
  const st = getState().sol;
  const last = st[addr];
  const opts = { limit: 50, commitment: "confirmed" };
  if (last) opts.until = last;
  const sigs = await rpc("getSignaturesForAddress", [addr, opts]);
  // first time seeing this wallet: remember where it is now, don't alert its history
  if (last === undefined) {
    st[addr] = sigs[0]?.signature || "";
    saveState();
    return;
  }
  if (!sigs.length) return;

  const list = sigs.reverse(); // oldest first
  const parsed = await parseTxs(list.map((s) => s.signature));
  for (const s of list) {
    const t = parsed.get(s.signature);
    try {
      const msg = t
        ? await solAlert(addr, t)
        : s.err
          ? null
          : buildAlert({ address: addr, chain: "Solana", title: "👀 New transaction", extra: ["Couldn't parse it yet."], link: `https://solscan.io/tx/${s.signature}` });
      if (msg) send(msg);
    } catch (e) {
      console.error(`[sol] alert for ${s.signature} failed: ${e.message}`);
    }
  }
  st[addr] = list[list.length - 1].signature;
  saveState();
  console.log(`[sol] ${short(addr)}: ${list.length} new tx(s)`);
}

// one poll at a time per wallet, so the websocket push and the 60s poll can't double-alert
const locks = new Map();

function poll(addr) {
  const p = (locks.get(addr) || Promise.resolve()).then(() => pollNow(addr)).catch((e) => console.error(`[sol] ${short(addr)}:`, e.message));
  locks.set(addr, p);
  return p;
}

const pending = new Map();

function schedule(addr) {
  if (pending.has(addr)) return;
  pending.set(addr, setTimeout(() => (pending.delete(addr), poll(addr)), 2000));
}

let ws = null;
let subsKey = null;
let reconnectTimer = null;

function connect() {
  const wallets = solWallets().map((w) => w.address);
  subsKey = wallets.join(",");
  if (!wallets.length) return;
  const sock = new WebSocket(WSS);
  ws = sock;
  const byReq = new Map();
  const bySub = new Map();
  let ping;
  sock.on("open", () => {
    wallets.forEach((a, i) => {
      byReq.set(i + 1, a);
      sock.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "logsSubscribe", params: [{ mentions: [a] }, { commitment: "confirmed" }] }));
    });
    ping = setInterval(() => sock.ping(), 30_000);
    console.log(`[sol] websocket subscribed to ${wallets.length} wallet(s)`);
  });
  sock.on("message", (buf) => {
    let m;
    try {
      m = JSON.parse(buf);
    } catch {
      return;
    }
    if (m.id && byReq.has(m.id) && typeof m.result === "number") bySub.set(m.result, byReq.get(m.id));
    else if (m.method === "logsNotification") {
      const a = bySub.get(m.params?.subscription);
      if (a) schedule(a);
    }
  });
  sock.on("error", (e) => console.warn("[sol] websocket:", e.message));
  sock.on("close", () => {
    clearInterval(ping);
    if (ws === sock) ws = null;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 5000);
  });
}

/** Re-subscribe when wallets were added/removed with /add or /remove. */
function resync() {
  if (reconnectTimer) return;
  if (solWallets().map((w) => w.address).join(",") === subsKey) return;
  if (ws) ws.close();
  else connect();
}

export function startSolana() {
  if (!KEY) {
    console.warn("[sol] HELIUS_API_KEY not set, Solana disabled");
    return;
  }
  connect();
  (async () => {
    for (;;) {
      resync();
      for (const w of solWallets()) await poll(w.address);
      await sleep(POLL_MS);
    }
  })();
}
