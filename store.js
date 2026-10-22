/**
 * wallets.json holds the tracked wallets ([{ address, label }]); state/state.json holds where each
 * watcher left off (last Solana signature per wallet, last EVM block + nonce/balance per chain).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WALLETS_FILE = path.join(DIR, "wallets.json");
const STATE_FILE = path.join(DIR, "state", "state.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export const isEvmAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
export const isSolAddress = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

export function loadWallets() {
  return readJson(WALLETS_FILE, []).filter((w) => w && w.address);
}

export function saveWallets(list) {
  writeJson(WALLETS_FILE, list);
}

export const evmWallets = () => loadWallets().filter((w) => isEvmAddress(w.address));
export const solWallets = () => loadWallets().filter((w) => isSolAddress(w.address));

export const walletOf = (address) => loadWallets().find((x) => x.address.toLowerCase() === address.toLowerCase());

export const labelOf = (address) => walletOf(address)?.label || short(address);

// Per-wallet alert switches (wallets.json "alerts"), changed with /alerts. Sends are always on.
export const ALERT_TYPES = { swap: "🔄 Swap", lp: "🏊 LP" };
export const ALERT_DEFAULTS = { swap: true, lp: false };

export const alertsOf = (w) => ({ ...ALERT_DEFAULTS, ...w?.alerts });

export const wants = (address, kind) => kind === "send" || alertsOf(walletOf(address))[kind];

export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const state = readJson(STATE_FILE, {});
state.sol ??= {};
state.evm ??= {};

export const getState = () => state;
export const saveState = () => writeJson(STATE_FILE, state);
