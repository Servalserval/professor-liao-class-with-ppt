/**
 * Two-asset (or same-asset) lending loop: supply COLLATERAL, borrow DEBT,
 * convert debt -> collateral, re-supply. Same-asset loops are the special
 * case collateral.symbol === debt.symbol (no swap, no depeg risk).
 *
 * This file defines the shared contract between protocol adapters
 * (packages/live-*) and the core. The math lives in `loopPairOpportunity`.
 */
import type { IrmModel, RewardRate } from "./loopLending.js";

export interface LoopLeg {
  /** Canonical symbol used for caps/exposure (e.g. "USDC", "USDT", "USDsui"). */
  symbol: string;
  /** Chain-specific id (EVM address / Sui coinType) — informational for the core. */
  assetId?: string;
  priceUsd: number;
  totalSupplyUsd: number;
  totalBorrowUsd: number;
  supplyAprBase: number;
  borrowAprBase: number;
  supplyRewards: RewardRate[];
  borrowRewards: RewardRate[];
  irm?: IrmModel;
  supplyCapRemainingUsd?: number | null;
  borrowCapRemainingUsd?: number | null;
  /** One-off fee charged on borrowing, fraction of borrowed amount. */
  borrowFeeFrac?: number;
}

export interface LoopPair {
  protocol: string;
  chain: string;
  /** Unique within protocol+chain, e.g. "USDC/USDC" or "USDC/USDsui" or a Morpho market id. */
  pairId: string;
  collateral: LoopLeg;
  /** For same-asset loops pass the same object (or an equal one) as `collateral`. */
  debt: LoopLeg;
  /** Max LTV for opening, liquidation LTV — pair-specific (e-mode / Morpho LLTV). */
  maxLtv: number;
  liqLtv: number;
  /** Cost of converting debt -> collateral (and back on exit), fraction of the amount. 0 for same asset. */
  swapCostFrac: number;
  /** USD of debt->collateral (and reverse) that can be swapped within the slippage budget. Infinity for same asset. */
  swapDepthUsd: number;
  flashloanFeeFrac?: number;
  paused?: boolean;
  /** LTV of MY open position, measured by the adapter (relative prices included). */
  myLtv?: number;
  /** Block / API time the data was read at. */
  dataAsOfMs?: number;
}

export function isSameAsset(p: LoopPair): boolean {
  return p.collateral.symbol === p.debt.symbol;
}
