# checkingwallet

A Telegram bot that alerts you about any activity of the wallets you track — swaps, sends, receives, approvals, LP / DeFi moves — on **Solana** and **EVM chains** (Ethereum, Base, BSC, Arbitrum, Monad).

## Requirements

- Node.js 20+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A [Helius](https://helius.dev) API key (for Solana; free tier works)
- Optional: an [Alchemy](https://alchemy.com) key, used only as a backup when public EVM RPCs fail

## Setup

```bash
git clone https://github.com/0xpingping/checkingwallet.git && cd checkingwallet
npm install
cp .env.example .env      # then fill in your keys
npm start
```

`TELEGRAM_CHAT_ID` is the chat that receives alerts, and the only chat allowed to use commands. To find it, message your bot once and open `https://api.telegram.org/bot<TOKEN>/getUpdates` — look for `"chat":{"id":...}`.

## Adding wallets

From Telegram:

| Command | What it does |
| --- | --- |
| `/add <address> <label>` | Track a wallet (EVM `0x…` or Solana). One per line to add many |
| `/remove <address or label>` | Stop tracking |
| `/alerts` | Toggle Swap / LP alerts per wallet (sends are always on) |
| `/list` | Show tracked wallets |
| `/help` | How it works |

Wallets are saved to `wallets.json` (see `wallets.example.json` for the format). You can also edit that file by hand.

## Configuration

See `.env.example`. Useful options:

- `EVM_CHAINS` — which EVM chains to watch (`ethereum,base,bsc,arbitrum,monad`)
- `EVM_POLL_SECONDS` — how often EVM chains are polled
- `SOL_MIN_INCOMING` — ignore tiny incoming SOL (address-poisoning spam)
- `RPC_<CHAIN>` — your own RPC URL(s) for a chain, tried first (e.g. `RPC_BASE=https://...`)
- `DRY_RUN=1` — print alerts to the console instead of sending them

## Running 24/7 with pm2

```bash
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
```

## Privacy

`.env` (keys), `wallets.json` (your wallets) and `state/` are git-ignored and never leave your machine.

## License

MIT — see [LICENSE](LICENSE).
