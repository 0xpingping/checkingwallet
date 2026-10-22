/** Telegram commands (only from TELEGRAM_CHAT_ID): /add, /remove, /list, /alerts (buttons), /help. */
import { tg, send, esc, CHAT_ID } from "./telegram.js";
import { loadWallets, saveWallets, isEvmAddress, isSolAddress, getState, saveState, short, ALERT_TYPES, alertsOf } from "./store.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HELP = [
  "<b>Wallet activity alerts</b>",
  "I message you when a tracked wallet sends money to another wallet (always on). Swap and LP alerts can be switched per wallet with /alerts. New wallets start with Send + Swap.",
  "",
  "/add <code>address label</code> — track a wallet (EVM 0x… or Solana). One per line to add many:",
  "<code>/add 0xabc… main\nAbC…xyz sol hot wallet</code>",
  "/remove <code>address or label</code>",
  "/alerts — choose Swap / LP alerts per wallet",
  "/list — tracked wallets",
].join("\n");

const sameAddress = (a, b) => (isEvmAddress(a) ? a.toLowerCase() === b.toLowerCase() : a === b);

function add(body) {
  const wallets = loadWallets();
  const added = [];
  const bad = [];
  for (const line of body.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [address, ...rest] = line.split(/\s+/);
    if (!isEvmAddress(address) && !isSolAddress(address)) {
      bad.push(address);
      continue;
    }
    const label = rest.join(" ") || "";
    const existing = wallets.find((w) => sameAddress(w.address, address));
    if (existing) {
      // re-adding a tracked wallet with a name renames it
      if (label && label !== existing.label) existing.label = label, added.push(`renamed · ${esc(label)}`);
      continue;
    }
    wallets.push({ address, label });
    added.push(`${isEvmAddress(address) ? "EVM" : "Solana"} · ${esc(label || address)}`);
  }
  saveWallets(wallets);
  const lines = [];
  if (added.length) lines.push(`✅ Added ${added.length}:`, ...added.map((a) => `• ${a}`), "", "Alerts start from now (no history). Send + Swap are on; change with /alerts.");
  if (bad.length) lines.push(`⚠️ Not a valid address: ${bad.map((b) => `<code>${esc(b)}</code>`).join(", ")}`);
  if (!lines.length) lines.push("Nothing new to add. Usage: /add <code>address label</code>");
  return lines.join("\n");
}

function remove(arg) {
  const wallets = loadWallets();
  const w = wallets.find((x) => sameAddress(x.address, arg) || (x.label && x.label.toLowerCase() === arg.toLowerCase()));
  if (!w) return `Not tracked: <code>${esc(arg)}</code>`;
  saveWallets(wallets.filter((x) => x !== w));
  delete getState().sol[w.address]; // re-adding later starts fresh instead of replaying old txs
  saveState();
  return `🗑 Removed ${esc(w.label || w.address)}`;
}

function list() {
  const wallets = loadWallets();
  if (!wallets.length) return "No wallets yet. Use /add <code>address label</code>";
  const row = (w) => `• ${w.label ? `<b>${esc(w.label)}</b> ` : ""}<code>${esc(w.address)}</code>\n   ${alertSummary(w)}`;
  const evm = wallets.filter((w) => isEvmAddress(w.address));
  const sol = wallets.filter((w) => isSolAddress(w.address));
  const chains = (process.env.EVM_CHAINS || "").replaceAll(",", ", ");
  return [
    evm.length ? `<b>EVM</b> (${esc(chains)})\n${evm.map(row).join("\n")}` : "",
    sol.length ? `<b>Solana</b>\n${sol.map(row).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

const alertSummary = (w) => ["📤 Send", ...Object.entries(ALERT_TYPES).filter(([k]) => alertsOf(w)[k]).map(([, name]) => name)].join(", ");

// ---------- /alerts buttons ----------
// callback_data: "w:<address>" opens a wallet, "t:<type>:<address>" toggles a type, "l" back to the list

function walletListView() {
  const wallets = loadWallets();
  if (!wallets.length) return { text: "No wallets yet. Use /add <code>address label</code>" };
  return {
    text: "Tap a wallet to choose its alerts:",
    reply_markup: { inline_keyboard: wallets.map((w) => [{ text: w.label || short(w.address), callback_data: `w:${w.address}` }]) },
  };
}

function walletView(w) {
  const on = alertsOf(w);
  return {
    text: `<b>${esc(w.label || short(w.address))}</b>\n<code>${esc(w.address)}</code>\n\n📤 Send is always on. Tap to switch:`,
    reply_markup: {
      inline_keyboard: [
        Object.entries(ALERT_TYPES).map(([k, name]) => ({ text: `${on[k] ? "✅" : "⬜"} ${name}`, callback_data: `t:${k}:${w.address}` })),
        [{ text: "« All wallets", callback_data: "l" }],
      ],
    },
  };
}

async function onButton(q) {
  const [action, ...rest] = q.data.split(":");
  let view;
  if (action === "l") view = walletListView();
  else {
    const address = rest[rest.length - 1];
    const wallets = loadWallets();
    const w = wallets.find((x) => x.address === address);
    if (!w) view = { text: "That wallet isn't tracked anymore." };
    else {
      if (action === "t" && ALERT_TYPES[rest[0]]) {
        w.alerts = { ...alertsOf(w), [rest[0]]: !alertsOf(w)[rest[0]] };
        saveWallets(wallets);
      }
      view = walletView(w);
    }
  }
  await tg("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
  await tg("editMessageText", {
    chat_id: q.message.chat.id,
    message_id: q.message.message_id,
    text: view.text,
    parse_mode: "HTML",
    reply_markup: view.reply_markup,
  }).catch((e) => console.warn("[cmd]", e.message));
}

function handle(text) {
  const [first] = text.trim().split(/\s+/);
  const cmd = first.split("@")[0].toLowerCase();
  const body = text.trim().slice(first.length).trim();
  if (cmd === "/add") return add(body);
  if (cmd === "/remove") return body ? remove(body) : "Usage: /remove <code>address or label</code>";
  if (cmd === "/list") return list();
  if (cmd === "/alerts") {
    const view = walletListView();
    send(view.text, { reply_markup: view.reply_markup });
    return null;
  }
  if (cmd === "/help" || cmd === "/start") return HELP;
  return null;
}

export async function startCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "add", description: "Track wallet(s): /add address label" },
      { command: "remove", description: "Stop tracking: /remove address or label" },
      { command: "alerts", description: "Choose Swap / LP alerts per wallet" },
      { command: "list", description: "Tracked wallets" },
      { command: "help", description: "How it works" },
    ],
  }).catch((e) => console.warn("[cmd]", e.message));

  let offset = 0;
  for (;;) {
    try {
      const updates = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.callback_query) {
          if (String(u.callback_query.message?.chat.id) === CHAT_ID) await onButton(u.callback_query).catch((e) => console.warn("[cmd]", e.message));
          continue;
        }
        const m = u.message;
        if (!m?.text || String(m.chat.id) !== CHAT_ID) continue;
        try {
          const reply = handle(m.text);
          if (reply) send(reply);
        } catch (e) {
          send(`⚠️ ${esc(e.message)}`);
        }
      }
    } catch (e) {
      console.error("[cmd]", e.message);
      await sleep(5000);
    }
  }
}
