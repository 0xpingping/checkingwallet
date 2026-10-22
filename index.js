import "dotenv/config";
import { startCommands } from "./commands.js";
import { startEvm } from "./evm.js";
import { startSolana } from "./solana.js";
import { loadWallets } from "./store.js";

for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
  if (!process.env[k]) {
    console.error(`${k} is missing in .env`);
    process.exit(1);
  }
}

console.log(`checkingwallet starting with ${loadWallets().length} wallet(s)`);
startCommands();
startEvm();
startSolana();
