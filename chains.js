/**
 * EVM chains. lag = blocks to stay behind head, because public RPCs load-balance over nodes and a
 * node that hasn't seen the newest block yet returns empty logs instead of an error.
 * logRange = max blocks per eth_getLogs call. Extra RPCs can be put first with RPC_<KEY> in .env;
 * with ALCHEMY_API_KEY set, Alchemy is added last as a backup only.
 */
export const CHAINS = {
  ethereum: {
    name: "Ethereum",
    alchemy: "eth-mainnet",
    native: "ETH",
    explorer: "https://etherscan.io",
    // publicnode/drpc refuse eth_getLogs by wallet topic; 1rpc caps it at 50 blocks
    rpcs: ["https://1rpc.io/eth", "https://gateway.tenderly.co/public/mainnet", "https://rpc.mevblocker.io", "https://ethereum-rpc.publicnode.com"],
    blockTime: 12,
    lag: 1,
    logRange: 50,
  },
  base: {
    name: "Base",
    alchemy: "base-mainnet",
    native: "ETH",
    explorer: "https://basescan.org",
    // publicnode/drpc refuse eth_getLogs by wallet topic; 1rpc caps it at 50 blocks
    rpcs: ["https://gateway.tenderly.co/public/base", "https://1rpc.io/base", "https://base-rpc.publicnode.com", "https://mainnet.base.org"],
    blockTime: 2,
    lag: 2,
    logRange: 50,
  },
  bsc: {
    name: "BSC",
    alchemy: "bnb-mainnet",
    native: "BNB",
    explorer: "https://bscscan.com",
    // publicnode/drpc/dataseed refuse eth_getLogs without a contract address; blockrazor allows 25 blocks
    rpcs: ["https://bsc.blockrazor.xyz", "https://bsc-rpc.publicnode.com"],
    blockTime: 0.45,
    lag: 4,
    logRange: 25,
  },
  arbitrum: {
    name: "Arbitrum",
    alchemy: "arb-mainnet",
    native: "ETH",
    explorer: "https://arbiscan.io",
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://gateway.tenderly.co/public/arbitrum", "https://arbitrum-one-rpc.publicnode.com"],
    blockTime: 0.25,
    lag: 8,
    logRange: 1000,
  },
  monad: {
    name: "Monad",
    alchemy: "monad-mainnet",
    native: "MON",
    explorer: "https://monadscan.com",
    rpcs: ["https://rpc.monad.xyz", "https://rpc3.monad.xyz"],
    blockTime: 0.4,
    lag: 5,
    logRange: 100,
  },
};

export function enabledChains() {
  const keys = (process.env.EVM_CHAINS || Object.keys(CHAINS).join(","))
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return keys.map((key) => {
    const c = CHAINS[key];
    if (!c) throw new Error(`Unknown chain in EVM_CHAINS: ${key}`);
    const own = (process.env[`RPC_${key.toUpperCase()}`] || "").split(",").map((s) => s.trim()).filter(Boolean);
    const alchemy = process.env.ALCHEMY_API_KEY ? [`https://${c.alchemy}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`] : [];
    return { key, ...c, rpcs: [...own, ...c.rpcs, ...alchemy] };
  });
}
