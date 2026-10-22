const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function tg(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(`${method}: ${json.description}`);
    err.retryAfter = json.parameters?.retry_after;
    throw err;
  }
  return json.result;
}

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Sends go through one queue, ~1 msg/s, so a burst of alerts stays under Telegram's per-chat limit.
let queue = Promise.resolve();

/** extra: more sendMessage fields, e.g. { reply_markup } for buttons */
export function send(html, extra = {}) {
  if (process.env.DRY_RUN) return console.log(`--- alert ---\n${html}\n`);
  queue = queue.then(() => sendNow(html, extra));
  return queue;
}

async function sendNow(html, extra) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await tg("sendMessage", {
        chat_id: CHAT_ID,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...extra,
      });
      await sleep(1100);
      return;
    } catch (e) {
      console.error("[tg]", e.message);
      await sleep(((e.retryAfter ?? 2) + 1) * 1000);
    }
  }
}
