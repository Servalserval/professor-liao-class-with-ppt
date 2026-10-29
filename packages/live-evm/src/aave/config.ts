/**
 * Market / pair configuration for the Aave v3 family.
 *
 * Official Aave markets: `aaveMarketFromAddressBook("AaveV3Plasma")` pulls the
 * addresses from the installed @bgd-labs/aave-address-book (4.44.22, Feb 2026).
 * Forks (Spark, HyperLend, Kinza, ZeroLend, ...) and Aave markets newer than
 * that package (Monad, X Layer, ...) use an explicit AaveMarketConfig; every
 * address in it is read back on-chain by AaveV3Adapter.verifyConfig() before
 * live use (provider.getPool() == pool, pool.ADDRESSES_PROVIDER() == provider,
 * the data provider decodes this pool's reserve list, token -> controller ...).
 */
import * as AddressBook from "@bgd-labs/aave-address-book";
import { chainByEvmId, type AssetRef } from "@incentive-router/live-common";
import type { Address } from "viem";
import type { UiLayout } from "./layouts.js";
import type { EModePreference } from "./math.js";

export interface AaveMarketConfig {
  /** Venue protocol id reported in LoopPair.protocol: "aave-v3", "spark", "hyperlend", "zerolend", ... */
  protocol: string;
  /** live-common chain id ("ethereum", "plasma", ...). */
  chain: string;
  pool: Address;
  poolAddressesProvider: Address;
  uiPoolDataProvider: Address;
  /** Defaults to aToken.getIncentivesController() read on-chain. */
  rewardsController?: Address;
  /** Only checked for code by verifyConfig (rates are read from the RewardsController directly). */
  uiIncentiveDataProvider?: Address;
  /** Distinguishes several markets of one protocol on one chain (adapter id = protocol:chain:key). */
  key?: string;
  /** Pin the UiPoolDataProvider struct layout; default = auto-detect (see layouts.ts). */
  uiLayout?: UiLayout;
  /** Expected EVM chain id (address-book CHAIN_ID); verifyConfig compares it with the RPC. */
  evmChainId?: number;
  /** Address-book market name when built by aaveMarketFromAddressBook. */
  addressBookName?: string;
}

export interface AavePairConfig {
  /** Unique within the adapter, e.g. "USDe/USDT0" or "USDC/USDC". */
  pairId: string;
  collateral: AssetRef;
  debt: AssetRef;
  /** "auto" (default): best e-mode containing both assets | "none" | explicit category id. */
  eMode?: EModePreference;
  /** USD notionals used to probe swap cost / depth in markets(). Default [10k, 100k, 1M]. */
  swapProbeUsd?: number[];
  /** Max swap cost accepted while opening (bps). Default 50. */
  maxEntrySwapCostBps?: number;
  /** Max swap cost accepted while closing / deleveraging (bps). Default 200. */
  maxExitSwapCostBps?: number;
  /** Health factor kept while collateral is withdrawn for an unwind swap. Default 1.04. */
  minUnwindHealthFactor?: number;
  /** Iteration cap for two-asset unwinds (withdraw -> swap -> repay). Default max(40, 3 x maxLoopIterations). */
  maxUnwindIterations?: number;
}

type AddressBookMarket = {
  POOL: string;
  POOL_ADDRESSES_PROVIDER: string;
  UI_POOL_DATA_PROVIDER?: string;
  UI_INCENTIVE_DATA_PROVIDER?: string;
  DEFAULT_INCENTIVES_CONTROLLER?: string;
  CHAIN_ID: number;
  ASSETS: Record<string, { decimals: number; UNDERLYING: string; A_TOKEN: string; V_TOKEN: string; id?: number }>;
};

function bookMarkets(): Record<string, AddressBookMarket> {
  const out: Record<string, AddressBookMarket> = {};
  for (const [name, v] of Object.entries(AddressBook as Record<string, unknown>)) {
    if (!name.startsWith("AaveV3") || !v || typeof v !== "object") continue;
    const m = v as Partial<AddressBookMarket>;
    if (typeof m.POOL === "string" && typeof m.POOL_ADDRESSES_PROVIDER === "string" && typeof m.CHAIN_ID === "number")
      out[name] = m as AddressBookMarket;
  }
  return out;
}

export interface AddressBookMarketInfo {
  name: string;
  evmChainId: number;
  /** live-common chain id, undefined when the chain is not in live-common CHAINS (testnets, Celo, Scroll, ...). */
  chain?: string;
  hasUiPoolDataProvider: boolean;
  assets: string[];
}

/** Every Aave v3 market in the installed address book. */
export function listAaveAddressBookMarkets(): AddressBookMarketInfo[] {
  return Object.entries(bookMarkets()).map(([name, m]) => ({
    name,
    evmChainId: m.CHAIN_ID,
    chain: chainByEvmId(m.CHAIN_ID)?.id,
    hasUiPoolDataProvider: typeof m.UI_POOL_DATA_PROVIDER === "string",
    assets: Object.keys(m.ASSETS ?? {}),
  }));
}

/**
 * Market key for id disambiguation: markets sharing a chain id get the part
 * of their name after the shortest such name ("AaveV3EthereumLido" -> "lido").
 */
function marketKey(name: string, all: Record<string, AddressBookMarket>): string | undefined {
  const id = all[name]!.CHAIN_ID;
  const peers = Object.keys(all).filter((n) => all[n]!.CHAIN_ID === id);
  if (peers.length <= 1) return undefined;
  const core = peers.reduce((a, b) => (b.length < a.length ? b : a));
  if (core === name) return undefined;
  return name.startsWith(core) ? name.slice(core.length).toLowerCase() : name.toLowerCase();
}

/**
 * Build an AaveMarketConfig from the installed address book.
 * SOURCE: node_modules/@bgd-labs/aave-address-book/dist/<name>-*.d.ts (v4.44.22)
 */
export function aaveMarketFromAddressBook(name: string, opts: { chain?: string; protocol?: string } = {}): AaveMarketConfig {
  const all = bookMarkets();
  const m = all[name];
  if (!m) throw new Error(`aave-address-book has no market "${name}" (have: ${Object.keys(all).join(", ")})`);
  if (!m.UI_POOL_DATA_PROVIDER) throw new Error(`aave-address-book market ${name} has no UI_POOL_DATA_PROVIDER`);
  const chain = opts.chain ?? chainByEvmId(m.CHAIN_ID)?.id;
  if (!chain) throw new Error(`aave-address-book market ${name}: chain id ${m.CHAIN_ID} is not in live-common CHAINS; pass opts.chain`);
  return {
    protocol: opts.protocol ?? "aave-v3",
    chain,
    pool: m.POOL as Address,
    poolAddressesProvider: m.POOL_ADDRESSES_PROVIDER as Address,
    uiPoolDataProvider: m.UI_POOL_DATA_PROVIDER as Address,
    rewardsController: m.DEFAULT_INCENTIVES_CONTROLLER as Address | undefined,
    uiIncentiveDataProvider: m.UI_INCENTIVE_DATA_PROVIDER as Address | undefined,
    key: marketKey(name, all),
    evmChainId: m.CHAIN_ID,
    addressBookName: name,
  };
}

/**
 * AssetRef for a reserve listed in the address book (`symbol` = the book's
 * ASSETS key, e.g. "USDT0", "USDe", "PT_USDe_9APR2026"). `canonicalSymbol`
 * overrides the symbol used by the core for caps.
 */
export function aaveAssetFromAddressBook(name: string, symbol: string, canonicalSymbol?: string): AssetRef {
  const m = bookMarkets()[name];
  if (!m) throw new Error(`aave-address-book has no market "${name}"`);
  const a = m.ASSETS[symbol];
  if (!a) throw new Error(`aave-address-book ${name} has no asset ${symbol} (have: ${Object.keys(m.ASSETS).join(", ")})`);
  const chain = chainByEvmId(m.CHAIN_ID)?.id;
  if (!chain) throw new Error(`aave-address-book market ${name}: chain id ${m.CHAIN_ID} is not in live-common CHAINS`);
  return { chain, symbol: canonicalSymbol ?? symbol, address: a.UNDERLYING, decimals: a.decimals };
}

/** Default adapter id: "aave-v3:plasma", "aave-v3:ethereum:lido", "spark:ethereum". */
export function aaveAdapterId(m: AaveMarketConfig): string {
  return m.key ? `${m.protocol}:${m.chain}:${m.key}` : `${m.protocol}:${m.chain}`;
}
