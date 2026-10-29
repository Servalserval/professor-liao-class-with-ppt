/**
 * Chain registry. RPC URLs are NOT here: they come from config/env on the
 * machine that runs the bot (public RPCs rate-limit and are not trustworthy
 * for writes). evmChainId values are public constants.
 */
export type ChainFamily = "evm" | "sui";

export interface ChainInfo {
  id: string;
  family: ChainFamily;
  evmChainId?: number;
  nativeSymbol: string;
  /** Average block / checkpoint time, seconds (for wait loops). */
  blockSeconds: number;
  explorerTx?: string;
}

export const CHAINS: Record<string, ChainInfo> = {
  sui: { id: "sui", family: "sui", nativeSymbol: "SUI", blockSeconds: 0.5, explorerTx: "https://suivision.xyz/txblock/" },
  ethereum: { id: "ethereum", family: "evm", evmChainId: 1, nativeSymbol: "ETH", blockSeconds: 12, explorerTx: "https://etherscan.io/tx/" },
  arbitrum: { id: "arbitrum", family: "evm", evmChainId: 42161, nativeSymbol: "ETH", blockSeconds: 0.25, explorerTx: "https://arbiscan.io/tx/" },
  base: { id: "base", family: "evm", evmChainId: 8453, nativeSymbol: "ETH", blockSeconds: 2, explorerTx: "https://basescan.org/tx/" },
  optimism: { id: "optimism", family: "evm", evmChainId: 10, nativeSymbol: "ETH", blockSeconds: 2, explorerTx: "https://optimistic.etherscan.io/tx/" },
  bsc: { id: "bsc", family: "evm", evmChainId: 56, nativeSymbol: "BNB", blockSeconds: 0.75, explorerTx: "https://bscscan.com/tx/" },
  avalanche: { id: "avalanche", family: "evm", evmChainId: 43114, nativeSymbol: "AVAX", blockSeconds: 2, explorerTx: "https://snowtrace.io/tx/" },
  polygon: { id: "polygon", family: "evm", evmChainId: 137, nativeSymbol: "POL", blockSeconds: 2, explorerTx: "https://polygonscan.com/tx/" },
  linea: { id: "linea", family: "evm", evmChainId: 59144, nativeSymbol: "ETH", blockSeconds: 2, explorerTx: "https://lineascan.build/tx/" },
  sonic: { id: "sonic", family: "evm", evmChainId: 146, nativeSymbol: "S", blockSeconds: 1, explorerTx: "https://sonicscan.org/tx/" },
  plasma: { id: "plasma", family: "evm", evmChainId: 9745, nativeSymbol: "XPL", blockSeconds: 1, explorerTx: "https://plasmascan.to/tx/" },
  hyperevm: { id: "hyperevm", family: "evm", evmChainId: 999, nativeSymbol: "HYPE", blockSeconds: 1, explorerTx: "https://hyperevmscan.io/tx/" },
  gnosis: { id: "gnosis", family: "evm", evmChainId: 100, nativeSymbol: "xDAI", blockSeconds: 5, explorerTx: "https://gnosisscan.io/tx/" },
  mantle: { id: "mantle", family: "evm", evmChainId: 5000, nativeSymbol: "MNT", blockSeconds: 2, explorerTx: "https://mantlescan.xyz/tx/" },
  unichain: { id: "unichain", family: "evm", evmChainId: 130, nativeSymbol: "ETH", blockSeconds: 1, explorerTx: "https://uniscan.xyz/tx/" },
  // chain ids below are checked by assertChainId() against the RPC before any write
  monad: { id: "monad", family: "evm", evmChainId: 143, nativeSymbol: "MON", blockSeconds: 0.4, explorerTx: "https://monadscan.com/tx/" },
  xlayer: { id: "xlayer", family: "evm", evmChainId: 196, nativeSymbol: "OKB", blockSeconds: 1, explorerTx: "https://www.oklink.com/xlayer/tx/" },
};

export function chainInfo(id: string): ChainInfo {
  const c = CHAINS[id];
  if (!c) throw new Error(`unknown chain "${id}" — add it to packages/live-common/src/chains.ts`);
  return c;
}

/** Reverse lookup by EVM chain id. */
export function chainByEvmId(evmChainId: number): ChainInfo | undefined {
  return Object.values(CHAINS).find((c) => c.evmChainId === evmChainId);
}
