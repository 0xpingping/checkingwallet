/**
 * EVM watcher, one loop per chain, every EVM_POLL_SECONDS over the new block range:
 *  1. eth_getLogs for Transfer/Approval logs that touch a tracked wallet (swaps, sends, receives,
 *     LP/DeFi deposits, NFTs, approvals) — two calls per range no matter how many wallets.
 *  2. Nonce check: if the wallet sent more txs than step 1 found (plain native send, failed tx, call
 *     with no token movement), bisect eth_getTransactionCount over the range to find those blocks.
 *  3. Balance check: if the native balance changed in a stretch with no known tx (someone sent the
 *     wallet ETH/BNB/MON), bisect eth_getBalance to find it.
 * Then one Telegram alert per (tx, wallet) with what the wallet sent/received in that tx.
 */
import { getState, saveState, evmWallets, labelOf, short, wants } from "./store.js";
import { send, esc } from "./telegram.js";
import { buildAlert, titleFor, fmtUnits } from "./format.js";
import { enabledChains } from "./chains.js";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const UNLIMITED = 1n << 128n;
// add/remove-liquidity events (Uniswap v2/v3/v4 and forks, Aerodrome/Velodrome, Balancer): a tx with
// one of these is an LP deploy / zap, not a swap
const LIQUIDITY = new Set([
  "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f", // v2 Mint
  "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496", // v2 Burn
  "0x5d624aa9c148153ab3446c1b154f660ee7701e549fe9b62dab7171b1c80e6fa2", // Velodrome/Aerodrome Burn
  "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde", // v3 Mint
  "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c", // v3 Burn
  "0x70935338e69775456a85ddef226c395fb668b63fa0115f5f20610b388e6ca9c0", // v3 Collect
  "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f", // IncreaseLiquidity
  "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4", // DecreaseLiquidity
  "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec", // v4 ModifyLiquidity
  "0xe5ce249087ce04f05a957192435400fd97868dba0e6a4b4c049abf8af80dae78", // Balancer PoolBalanceChanged
]);
const POLL_MS = Number(process.env.EVM_POLL_SECONDS || 15) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => "0x" + n.toString(16);
const pad = (a) => "0x" + a.slice(2).padStart(64, "0");
const topicAddr = (t) => "0x" + t.slice(26).toLowerCase();
const lc = (a) => (a || "").toLowerCase();
const word = (data) => (data && data.length >= 66 ? BigInt(data.slice(0, 66)) : 0n);

export class Rpc {
  constructor(name, urls) {
    this.name = name;
    this.urls = urls;
    this.i = 0;
    this.failedAt = 0;
  }

  async call(method, params) {
    return (await this.send([[method, params]]))[0];
  }

  async batch(calls, opts) {
    const out = [];
    for (let i = 0; i < calls.length; i += 20) out.push(...(await this.send(calls.slice(i, i + 20), opts)));
    return out;
  }

  /** settled: per-call errors come back as null instead of failing the whole batch */
  async send(calls, { settled = false } = {}) {
    const body = calls.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params }));
    // after failing over to a backup RPC, go back to the first (free) one after 5 minutes
    if (this.i % this.urls.length && Date.now() - this.failedAt > 300_000) this.i = 0;
    let lastErr;
    for (let attempt = 0; attempt <= 2 * this.urls.length; attempt++) {
      if (attempt) await sleep(500 * attempt); // public RPCs rate-limit bursts (bisect lookups)
      const url = this.urls[this.i % this.urls.length];
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body.length === 1 ? body[0] : body),
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let json = await res.json();
        if (!Array.isArray(json)) json = [json];
        const byId = new Map(json.map((r) => [r.id, r]));
        return body.map((b) => {
          const r = byId.get(b.id);
          if (!r) throw new Error(`no response for ${b.method}`);
          if (r.error) {
            if (settled && !/rate|limit/i.test(r.error.message)) return null;
            throw new Error(`${b.method}: ${r.error.message}`);
          }
          return r.result;
        });
      } catch (e) {
        lastErr = e;
        this.i++;
        this.failedAt = Date.now();
      }
    }
    throw new Error(`[${this.name}] ${lastErr.message}`);
  }
}

// ---------- token + method names ----------

const tokenMeta = new Map(); // `${chain}:${token}` -> { symbol, decimals }

function decodeString(h) {
  if (!h || h.length < 66) return null;
  const b = Buffer.from(h.slice(2), "hex");
  let s;
  if (b.length === 32) s = b.toString("utf8");
  else s = b.subarray(64, 64 + Number(BigInt("0x" + b.subarray(32, 64).toString("hex")))).toString("utf8");
  s = s.replace(/[\u0000-\u001f]/g, "").trim();
  return s ? s.slice(0, 24) : null;
}

async function loadTokenMeta(c, tokens) {
  const missing = [...new Set(tokens)].filter((t) => !tokenMeta.has(`${c.key}:${t}`));
  if (missing.length) {
    const res = await c.rpc.batch(
      missing.flatMap((t) => [
        ["eth_call", [{ to: t, data: "0x95d89b41" }, "latest"]], // symbol()
        ["eth_call", [{ to: t, data: "0x313ce567" }, "latest"]], // decimals()
      ]),
      { settled: true },
    );
    missing.forEach((t, i) => {
      const dec = res[2 * i + 1] && res[2 * i + 1].length >= 66 ? Number(BigInt(res[2 * i + 1].slice(0, 66))) : 18;
      tokenMeta.set(`${c.key}:${t}`, { symbol: decodeString(res[2 * i]) || short(t), decimals: dec <= 36 ? dec : 18 });
    });
  }
  return (t) => tokenMeta.get(`${c.key}:${t}`);
}

const methodNames = new Map();

async function methodName(selector) {
  if (methodNames.has(selector)) return methodNames.get(selector);
  try {
    const res = await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`, {
      signal: AbortSignal.timeout(5000),
    });
    // several signatures can share a selector; the oldest registered one is usually the real one
    const best = (await res.json()).results?.sort((a, b) => a.id - b.id)[0];
    const name = best ? best.text_signature.split("(")[0] : null;
    methodNames.set(selector, name);
    return name;
  } catch {
    return null;
  }
}

// ---------- discovery helpers ----------

/** Blocks in (lo, hi] where f(block) changes, as { block, before, after }. f must be monotonic-ish. */
async function findChanges(lo, hi, vlo, vhi, f, out, budget) {
  if (vlo === vhi) return out;
  if (hi - lo === 1) {
    out.push({ block: hi, before: vlo, after: vhi });
    return out;
  }
  if (budget.n-- <= 0) throw new Error("too many lookups");
  const mid = Math.floor((lo + hi) / 2);
  const vm = await f(mid);
  await findChanges(lo, mid, vlo, vm, f, out, budget);
  await findChanges(mid, hi, vm, vhi, f, out, budget);
  return out;
}

async function loadTxs(c, hashes, txs) {
  const todo = [...new Set(hashes)].filter((h) => !txs.has(h));
  if (!todo.length) return;
  const res = await c.rpc.batch(todo.flatMap((h) => [["eth_getTransactionByHash", [h]], ["eth_getTransactionReceipt", [h]]]));
  todo.forEach((h, i) => {
    if (res[2 * i] && res[2 * i + 1]) txs.set(h, { tx: res[2 * i], receipt: res[2 * i + 1] });
  });
}

function involves(t, a) {
  if (lc(t.tx.from) === a || lc(t.tx.to) === a) return true;
  return t.receipt.logs.some(
    (l) =>
      (l.topics[0] === TRANSFER || l.topics[0] === APPROVAL) &&
      l.topics.length >= 3 &&
      (topicAddr(l.topics[1]) === a || topicAddr(l.topics[2]) === a),
  );
}

// ---------- alerts ----------

/** Plain wallets (EOAs, incl. EIP-7702 delegated ones) as opposed to pools/routers/contracts. */
async function anyWallet(c, addrs) {
  if (!addrs.length) return false;
  const codes = await c.rpc.batch(addrs.map((x) => ["eth_getCode", [x, "latest"]]));
  return codes.some((code) => code === "0x" || code.startsWith("0xef0100"));
}

function addrLink(c, a, walletSet) {
  const name = walletSet.has(a) ? labelOf(a) : short(a);
  return `<a href="${c.explorer}/address/${a}">${esc(name)}</a>`;
}

async function txAlert(c, { tx, receipt }, a, nativeNet, walletSet) {
  const signer = lc(tx.from) === a;
  const failed = receipt.status === "0x0";
  const value = BigInt(tx.value || 0);
  const tokOut = new Map();
  const tokIn = new Map();
  const nftOut = [];
  const nftIn = [];
  const approvals = [];
  const others = new Set();
  const sentTo = new Set();
  const add = (m, k, v) => m.set(k, (m.get(k) || 0n) + v);

  if (!failed) {
    for (const l of receipt.logs) {
      if (l.topics.length < 3) continue;
      const from = topicAddr(l.topics[1]);
      const to = topicAddr(l.topics[2]);
      const token = lc(l.address);
      if (l.topics[0] === TRANSFER && l.topics.length === 4) {
        const id = BigInt(l.topics[3]).toString();
        if (from === a) nftOut.push({ token, id }), others.add(to), sentTo.add(to);
        if (to === a) nftIn.push({ token, id }), others.add(from);
      } else if (l.topics[0] === TRANSFER) {
        const v = word(l.data);
        if (v === 0n) continue; // zero-value transfers are address-poisoning spam
        if (from === a) add(tokOut, token, v), others.add(to), sentTo.add(to);
        if (to === a) add(tokIn, token, v), others.add(from);
      } else if (l.topics[0] === APPROVAL && l.topics.length === 3 && from === a && signer) {
        approvals.push({ token, spender: to, value: word(l.data) });
      }
    }
  }
  // a token that went out and came back in the same tx only counts by its net amount
  for (const [k, v] of [...tokOut]) {
    if (!tokIn.has(k)) continue;
    const net = tokIn.get(k) - v;
    tokOut.delete(k);
    tokIn.delete(k);
    if (net > 0n) tokIn.set(k, net);
    if (net < 0n) tokOut.set(k, -net);
  }

  const fee = signer ? BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? tx.gasPrice ?? 0) + BigInt(receipt.l1Fee ?? 0) : 0n;
  if (nativeNet == null) nativeNet = failed ? 0n : signer ? -value : lc(tx.to) === a ? value : 0n;
  else nativeNet += fee;
  if (signer && value > 0n && !failed) others.add(lc(tx.to)), sentTo.add(lc(tx.to));
  if (!signer && lc(tx.to) === a && value > 0n) others.add(lc(tx.from));
  others.delete(a);

  const meta = await loadTokenMeta(c, [...tokOut.keys(), ...tokIn.keys(), ...nftOut.map((n) => n.token), ...nftIn.map((n) => n.token), ...approvals.map((x) => x.token)]);
  const outs = [];
  const ins = [];
  if (nativeNet < 0n) outs.push({ amount: -nativeNet, decimals: 18, symbol: c.native });
  if (nativeNet > 0n) ins.push({ amount: nativeNet, decimals: 18, symbol: c.native });
  for (const [k, v] of tokOut) outs.push({ amount: v, ...meta(k) });
  for (const [k, v] of tokIn) ins.push({ amount: v, ...meta(k) });
  for (const n of nftOut) outs.push({ nft: `${meta(n.token).symbol} #${n.id}` });
  for (const n of nftIn) ins.push({ nft: `${meta(n.token).symbol} #${n.id}` });

  if (!signer && !outs.length && !ins.length) return null;

  // LP activity, a swap, or money leaving to another wallet (or pulled out without the wallet
  // signing); receives, approvals and failed txs get no alert
  sentTo.delete(a);
  const lp = receipt.logs.some((l) => LIQUIDITY.has(l.topics[0]));
  let kind = null;
  if (failed) kind = null;
  else if (lp && signer && (outs.length || ins.length)) kind = "lp";
  else if (outs.length && ins.length && !lp && !nftIn.length) kind = "swap";
  else if (!signer && outs.length && !ins.length) kind = "send";
  else if (signer && outs.length && !lp && (await anyWallet(c, [...sentTo]))) kind = "send";
  if (!kind || !wants(a, kind)) return null;

  const title = titleFor(kind, { outs, ins, signer });
  const extra = [];
  for (const ap of approvals) {
    const m = meta(ap.token);
    const amt = ap.value >= UNLIMITED || ap.value / 10n ** BigInt(m.decimals) >= 10n ** 15n ? "unlimited" : ap.value === 0n ? "0 (revoked)" : fmtUnits(ap.value, m.decimals);
    extra.push(`🔓 Approved ${amt} ${esc(m.symbol)} to ${addrLink(c, ap.spender, walletSet)}`);
  }
  if (kind === "send" && sentTo.size) extra.push(`To: ${[...sentTo].map((x) => addrLink(c, x, walletSet)).join(", ")}`);
  if (signer && tx.to && tx.input && tx.input.length >= 10) {
    const name = await methodName(tx.input.slice(0, 10));
    extra.push(`Contract: ${addrLink(c, lc(tx.to), walletSet)}${name ? ` · <code>${esc(name)}</code>` : ""}`);
  }
  if (signer) extra.push(`Fee: ${fmtUnits(fee, 18)} ${c.native}`);

  return buildAlert({ address: a, chain: c.name, title, outs, ins, extra, link: `${c.explorer}/tx/${tx.hash}` });
}

// ---------- main loop ----------

export async function processRange(c, from, to, W, prev, snap) {
  const walletSet = new Set(W);
  const txs = new Map();
  const padded = W.map(pad);
  const hashes = [];
  // a failing range is retried in smaller pieces (Alchemy's free plan allows only 10 blocks per call)
  let size = c.logRange;
  for (let s = from; s <= to; ) {
    const e = Math.min(to, s + size - 1);
    const range = { fromBlock: hex(s), toBlock: hex(e) };
    let res;
    try {
      res = await c.rpc.batch([
        ["eth_getLogs", [{ ...range, topics: [[TRANSFER, APPROVAL], padded] }]],
        ["eth_getLogs", [{ ...range, topics: [TRANSFER, null, padded] }]],
      ]);
    } catch (err) {
      if (size <= 10) throw err;
      size = Math.max(10, Math.floor(size / 4));
      continue;
    }
    for (const l of res.flat()) hashes.push(l.transactionHash);
    s = e + 1;
  }
  await loadTxs(c, hashes, txs);

  const fallbacks = []; // { order, msg } for activity found but not resolvable to a tx

  // outgoing txs that left no Transfer/Approval log
  for (const a of W) {
    const sent = [...txs.values()].filter((t) => lc(t.tx.from) === a).length;
    const missing = snap[a].nonce - prev[a].nonce - sent;
    if (missing <= 0) continue;
    try {
      const nonceAt = async (b) => String(Number(await c.rpc.call("eth_getTransactionCount", [a, hex(b)])));
      const changes = await findChanges(from - 1, to, String(prev[a].nonce), String(snap[a].nonce), nonceAt, [], { n: 60 });
      const found = [];
      for (const { block } of changes) {
        const blk = await c.rpc.call("eth_getBlockByNumber", [hex(block), true]);
        for (const tx of blk.transactions) if (lc(tx.from) === a) found.push(tx.hash);
      }
      await loadTxs(c, found, txs);
    } catch (e) {
      console.warn(`[${c.key}] nonce lookup failed for ${a}: ${e.message}`);
      fallbacks.push({
        order: [to, -1],
        msg: buildAlert({
          address: a,
          chain: c.name,
          title: `📤 ${missing} transaction(s) sent`,
          extra: ["Couldn't load the details from the RPC."],
          link: `${c.explorer}/address/${a}`,
          linkText: "Open wallet",
        }),
      });
    }
  }

  // native balance per (wallet, block): before and after each tx, for the native amount moved
  const bal = new Map();
  for (const a of W) {
    bal.set(`${a}:${from - 1}`, prev[a].balance);
    bal.set(`${a}:${to}`, snap[a].balance);
  }
  const pairsOf = () => [...txs.values()].flatMap((t) => W.filter((a) => involves(t, a)).map((a) => ({ t, a })));
  const loadBalances = async (pairs) => {
    const keys = [...new Set(pairs.flatMap(({ t, a }) => [`${a}:${Number(t.receipt.blockNumber) - 1}`, `${a}:${Number(t.receipt.blockNumber)}`]))].filter((k) => !bal.has(k));
    if (!keys.length) return;
    const res = await c.rpc.batch(keys.map((k) => ["eth_getBalance", [k.split(":")[0], hex(Number(k.split(":")[1]))]]), { settled: true });
    keys.forEach((k, i) => res[i] != null && bal.set(k, BigInt(res[i]).toString()));
  };
  await loadBalances(pairsOf());

  // incoming native with no Transfer log: balance changed in a stretch between known txs
  const found = [];
  for (const a of W) {
    const blocks = [...new Set(pairsOf().filter((p) => p.a === a).map((p) => Number(p.t.receipt.blockNumber)))].sort((x, y) => x - y);
    const points = [from - 1, ...blocks.flatMap((b) => [b - 1, b]), to];
    for (let i = 0; i < points.length; i += 2) {
      const [lo, hi] = [points[i], points[i + 1]];
      const [vlo, vhi] = [bal.get(`${a}:${lo}`), bal.get(`${a}:${hi}`)];
      if (hi <= lo || vlo == null || vhi == null || vlo === vhi) continue;
      try {
        const balAt = async (b) => {
          const v = BigInt(await c.rpc.call("eth_getBalance", [a, hex(b)])).toString();
          bal.set(`${a}:${b}`, v);
          return v;
        };
        for (const ch of await findChanges(lo, hi, vlo, vhi, balAt, [], { n: 40 })) {
          const blk = await c.rpc.call("eth_getBlockByNumber", [hex(ch.block), true]);
          const direct = blk.transactions.filter((tx) => lc(tx.to) === a && BigInt(tx.value) > 0n && !txs.has(tx.hash));
          if (direct.length) found.push(...direct.map((tx) => tx.hash));
          else {
            // moved by a contract inside someone else's tx (e.g. a withdrawal/claim paying out native)
            const delta = BigInt(ch.after) - BigInt(ch.before);
            if (delta > 0n) continue; // receives don't alert
            const move = { amount: delta < 0n ? -delta : delta, decimals: 18, symbol: c.native };
            fallbacks.push({
              order: [ch.block, -1],
              msg: buildAlert({
                address: a,
                chain: c.name,
                title: delta > 0n ? "📥 Received (internal transfer)" : "📤 Moved out (internal transfer)",
                ins: delta > 0n ? [move] : [],
                outs: delta < 0n ? [move] : [],
                link: `${c.explorer}/block/${ch.block}`,
                linkText: `Block ${ch.block}`,
              }),
            });
          }
        }
      } catch (e) {
        console.warn(`[${c.key}] balance lookup failed for ${a}: ${e.message}`);
      }
    }
  }
  await loadTxs(c, found, txs);

  const pairs = pairsOf();
  await loadBalances(pairs);
  // the balance diff of a block is only this tx's if the wallet had no other tx in that block
  const perBlock = new Map();
  for (const { t, a } of pairs) perBlock.set(`${a}:${t.receipt.blockNumber}`, (perBlock.get(`${a}:${t.receipt.blockNumber}`) || 0) + 1);

  const items = [...fallbacks];
  for (const { t, a } of pairs) {
    const b = Number(t.receipt.blockNumber);
    const before = bal.get(`${a}:${b - 1}`);
    const after = bal.get(`${a}:${b}`);
    const nativeNet = perBlock.get(`${a}:${t.receipt.blockNumber}`) === 1 && before != null && after != null ? BigInt(after) - BigInt(before) : null;
    try {
      const msg = await txAlert(c, t, a, nativeNet, walletSet);
      if (msg) items.push({ order: [b, Number(t.receipt.transactionIndex)], msg });
    } catch (e) {
      console.error(`[${c.key}] alert for ${t.tx.hash} failed: ${e.message}`);
    }
  }
  items.sort((x, y) => x.order[0] - y.order[0] || x.order[1] - y.order[1]);
  for (const { msg } of items) send(msg);
  if (items.length) console.log(`[${c.key}] blocks ${from}-${to}: ${items.length} alert(s)`);
}

async function cycle(c) {
  const st = (getState().evm[c.key] ??= { lastBlock: null, wallets: {} });
  const W = evmWallets().map((w) => lc(w.address));
  if (!W.length) return;
  const head = Number(await c.rpc.call("eth_blockNumber", [])) - c.lag;
  if (st.lastBlock != null && head <= st.lastBlock) return;

  const raw = await c.rpc.batch(W.flatMap((a) => [["eth_getTransactionCount", [a, hex(head)]], ["eth_getBalance", [a, hex(head)]]]));
  const snap = Object.fromEntries(W.map((a, i) => [a, { nonce: Number(raw[2 * i]), balance: BigInt(raw[2 * i + 1]).toString() }]));

  // wallets added since the last cycle start from here, without alerts for their history
  let known = st.lastBlock == null ? [] : W.filter((a) => st.wallets[a]);
  const maxCatchup = Math.ceil(1800 / c.blockTime);
  if (known.length && head - st.lastBlock > maxCatchup) {
    console.warn(`[${c.key}] ${head - st.lastBlock} blocks behind (>30 min), skipping to head`);
    known = [];
  }
  if (known.length) await processRange(c, st.lastBlock + 1, head, known, st.wallets, snap);

  st.lastBlock = head;
  st.wallets = snap;
  saveState();
}

export function startEvm() {
  for (const c of enabledChains()) {
    c.rpc = new Rpc(c.name, c.rpcs);
    console.log(`[${c.key}] watching via ${c.rpcs[0]}`);
    (async () => {
      for (;;) {
        try {
          await cycle(c);
        } catch (e) {
          console.error(`[${c.key}]`, e.message);
        }
        await sleep(POLL_MS);
      }
    })();
  }
}
