/**
 * Shared alert layout for both chains. A "move" is { amount: bigint, decimals, symbol } or an NFT
 * { nft: "SYMBOL #id" }; outs/ins are what the wallet lost/gained in the tx.
 */
import { esc } from "./telegram.js";
import { walletOf } from "./store.js";

export function fmtUnits(value, decimals) {
  let v = BigInt(value);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0");
  // 4 decimals for amounts >= 1, otherwise 4 significant digits so dust isn't shown as 0
  const keep = whole > 0n ? 4 : Math.min(decimals, frac.match(/^0*/)[0].length + 4);
  frac = frac.slice(0, keep).replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}

const moveText = (m) => (m.nft ? esc(m.nft) : `${fmtUnits(m.amount, m.decimals)} ${esc(m.symbol)}`);

/** Alert title for a kind ("send" | "swap" | "lp", see wants() in store.js). */
export function titleFor(kind, { outs, ins, signer }) {
  if (kind === "send") return signer ? "📤 Sent" : "📤 Moved out";
  if (kind === "swap") return "🔄 Swap";
  if (outs.length && !ins.length) return "🏊 LP · add liquidity";
  if (ins.length && !outs.length) return "🏊 LP · remove / claim";
  return "🏊 LP";
}

export function buildAlert({ address, chain, title, subtitle, outs = [], ins = [], extra = [], link, linkText }) {
  const w = walletOf(address);
  const addr = `<code>${esc(w?.address || address)}</code>`;
  const lines = [`${title}`, `Chain : ${esc(chain)}`, w?.label ? `<b>${esc(w.label)}</b> - ${addr}` : addr];
  if (subtitle) lines.push(`<i>${esc(subtitle)}</i>`);
  for (const m of outs) lines.push(`➖ ${moveText(m)}`);
  for (const m of ins) lines.push(`➕ ${moveText(m)}`);
  lines.push(...extra);
  if (link) lines.push(`<a href="${link}">${esc(linkText || "View tx")}</a>`);
  return lines.join("\n");
}
