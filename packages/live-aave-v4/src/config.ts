/**
 * Aave V4 adapter configuration.
 *
 * No address is hard-coded in this package (the installed address book
 * 4.44.22 has no V4 entries). Every address comes from config and is read
 * back on-chain — and against AaveKit when it is reachable — by
 * AaveV4Adapter.verifyConfig() before live use. Candidate values (docs, read
 * 2026-10-29, NOT trusted until verify passes):
 *   Ethereum Core Hub  0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9  SOURCE: https://aave.com/docs/aave-v4/liquidity/hubs.md
 *   Ethereum Plus Hub  0x06002e9c4412CB7814a791eA3666D905871E536A  (same)
 *   Ethereum Prime Hub 0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931  (same)
 *   Ethereum spokes (Main, Bluechip, Ethena Correlated, Ethena Ecosystem, ...) SOURCE: https://aave.com/docs/aave-v4/liquidity/spokes.md
 *   Avalanche hubs / spokes: not listed in the docs — take them from AaveKit
 *   (`spokes(client, { query: { chainIds: [chainId(43114)] } })`) and verify.
 */
import type { AssetRef, LiveContext, Logger, RewardRateProvider, SwapAdapter } from "@incentive-router/live-common";
import type { EvmEnv } from "@incentive-router/live-evm-base";
import type { AaveClient } from "@aave/client";
import type { AaveV4Api } from "./api.js";

export const AAVE_V4_PROTOCOL = "aave-v4";

export interface AaveV4SpokeConfig {
  /** live-common chain id ("ethereum", "avalanche", "base", ...). Must equal env.chain. */
  chain: string;
  /** Short label used in the adapter id: aave-v4:<chain>:<spokeName> (e.g. "core-ethena"). */
  spokeName: string;
  /** Spoke (proxy) address. Verified: has code, implementation has the ABI selectors, AaveKit knows it. */
  spoke: string;
  /** Hub the pair reserves are expected on (e.g. the Core Hub). verifyConfig checks getReserve(id).hub. */
  hub: string;
  /** Other hubs a configured reserve may live on (a spoke can be connected to several hubs). */
  extraHubs?: string[];
  /** Optional labels compared with AaveKit's names in verifyConfig (case-insensitive substring). */
  hubName?: string;
  spokeLabel?: string;
  /** Governance-registered position managers that may appear as tx targets / approve spenders. Not used by the default flows. */
  positionManagers?: string[];
}

export interface AaveV4PairConfig {
  /** Unique within the adapter, e.g. "USDe/USDt". */
  pairId: string;
  collateral: AssetRef;
  debt: AssetRef;
  /** On-chain reserve ids on the spoke. Default: discovered via spoke.getReserveId(hub, hub.getAssetId(underlying)). */
  collateralReserveId?: number | bigint;
  debtReserveId?: number | bigint;
  /** USD notionals used to probe swap cost / depth in markets(). Default [10k, 100k, 1M]. */
  swapProbeUsd?: number[];
  /** Max swap cost accepted while opening (bps). Default 50. */
  maxEntrySwapCostBps?: number;
  /** Max swap cost accepted while closing / deleveraging (bps). Default 200. */
  maxExitSwapCostBps?: number;
  /** HF kept right after each unwind withdraw (before swap + repay). Default 1.04. */
  minUnwindHealthFactor?: number;
  /** Floor used only when minUnwindHealthFactor allows no progress (LTV drifted up). Default 1.01; set equal to disable. */
  emergencyUnwindHealthFactor?: number;
  /** Iteration cap for unwinds. Default max(40, 3 x ctx.limits.maxLoopIterations). */
  maxUnwindIterations?: number;
  /** Smallest loop borrow worth an iteration, USD. Default 10. */
  minBorrowUsd?: number;
}

export interface AaveV4AdapterOptions {
  env: EvmEnv;
  /** AaveKit client (default AaveClient.create({ cache: false })). Ignored when `api` is given. */
  client?: AaveClient;
  /** Injectable AaveKit facade (tests / offline). `null` disables AaveKit entirely (on-chain only). */
  api?: AaveV4Api | null;
  spoke: AaveV4SpokeConfig;
  pairs: AaveV4PairConfig[];
  /** Same-chain swapper for debt <-> collateral (required for two-asset pairs). */
  swapper?: SwapAdapter;
  /** External reward streams (Merkl campaigns, incl. Ethena Liquid Leverage with maxHealthFactor). */
  extraRewards?: RewardRateProvider;
  /** Extra allowlisted call targets (must have code; checked by verifyConfig). */
  allowedTargets?: string[];
  /** Targets whose calldata may be sent WITHOUT decoding (explicit opt-in, e.g. a rewards claimer). Default none. */
  allowUndecodedTargets?: string[];
  /** Market USD price for LoopLeg.priceUsd / position USD values (e.g. DefiLlama). Fallback: protocol oracle. */
  priceUsd?: (asset: AssetRef) => Promise<number>;
  /** Context used for swapper.quote() inside markets() (no ctx is passed there). */
  quoteCtx?: LiveContext;
  /**
   * Reward metadata from AaveKit (Merkl campaigns attached to reserves):
   * "auto" (default) = only when no extraRewards provider is injected (they
   * are the same Merkl campaigns — never count both), "always", "never".
   */
  apiMerklRewards?: "auto" | "always" | "never";
  /** Also build each spoke action via AaveKit and require its plan to decode to exactly our call. Default false. */
  apiCrossCheck?: boolean;
  /** verifyConfig() reports an unreachable AaveKit as an issue. Default false (on-chain checks are authoritative). */
  requireApiCrossCheck?: boolean;
  /** open() refuses a target whose HF (CF / targetLtv) is above any reward's maxHealthFactor. Default false. */
  enforceRewardMaxHealthFactor?: boolean;
  /** Batch spoke calls of one step with Spoke.multicall (atomic). Default true. */
  useSpokeMulticall?: boolean;
  /** Warn when the RPC's latest block is older than this. Default 5 min. */
  maxStaleMs?: number;
  log?: Logger;
  now?: () => number;
}

export function aaveV4AdapterId(spoke: Pick<AaveV4SpokeConfig, "chain" | "spokeName">): string {
  return `${AAVE_V4_PROTOCOL}:${spoke.chain}:${spoke.spokeName}`;
}
