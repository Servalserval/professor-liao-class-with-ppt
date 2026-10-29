/**
 * Pure mapping: on-chain Aave V4 reserve snapshot -> core LoopPair.
 *
 * Leg sourcing (documented choice, conservative where it matters):
 *  - Collateral leg totals are SPOKE-reserve level (Merkl campaigns attach to
 *    the spoke reserve, so the reward pool is not inflated by other spokes),
 *    and its "borrow" total is EFFECTIVE: S - min(S - spokeDebt, hubLiquidity),
 *    so S - B = what this spoke's suppliers can actually withdraw now. No IRM
 *    on the collateral leg (supply APR held at the observed value).
 *  - Debt leg totals are HUB level (rates follow hub utilization). B includes
 *    swept liquidity, so S - B = instantly available liquidity and B/S >= the
 *    IRM's drawn/(liquidity+drawn+swept) (borrow APR never understated).
 *  - borrowAprBase and every IRM point are multiplied by (1 + risk premium).
 *  - maxLtv = liqLtv = collateral factor (V4 has no separate threshold).
 *  - Entry blockers (frozen, not borrowable, CF 0, caps reached, drawCap 0,
 *    no liquidity) set the corresponding cap remaining to 0 instead of
 *    flagging `paused` (which the core treats as an EXIT signal); `paused`
 *    is only set when withdraw/repay themselves are blocked.
 */
import type { LoopLeg, LoopPair, RewardRate } from "@incentive-router/core";
import { borrowAprWithRiskPremium, bpsToFrac, capRemaining, hubSupplyApr, irmFromRateData, rayToNumber, toHuman } from "./math.js";

export interface InterestRateData {
  optimalUsageRatio: number;
  baseDrawnRate: number;
  rateGrowthBeforeOptimal: number;
  rateGrowthAfterOptimal: number;
}

/** Everything read on-chain for one reserve (base units of the reserve's asset). */
export interface ReserveMarketData {
  reserveId: bigint;
  symbol: string;
  address: string;
  decimals: number;
  /** Price used for the LoopLeg (market price if available, else protocol oracle). */
  priceUsd: number;
  /** Protocol oracle price (8 dec -> USD). */
  oraclePriceUsd: number;
  // spoke reserve
  reserveSupplied: bigint;
  reserveDrawn: bigint;
  reservePremium: bigint;
  collateralFactorBps: number;
  collateralRiskBps: number;
  paused: boolean;
  frozen: boolean;
  borrowable: boolean;
  // hub asset
  hubLiquidity: bigint;
  hubSwept: bigint;
  hubDrawn: bigint;
  hubPremium: bigint;
  hubAdded: bigint;
  liquidityFeeBps: number;
  drawnRateRay: bigint;
  irm?: InterestRateData;
  // hub x spoke config
  spokeActive: boolean;
  spokeHalted: boolean;
  addCap: bigint;
  drawCap: bigint;
  spokeAdded: bigint;
  spokeDrawn: bigint;
  spokePremium: bigint;
  spokeDeficit: bigint;
}

export interface PairStatus {
  pairId: string;
  /** New loops can be opened right now (supply collateral + borrow debt). */
  canOpen: boolean;
  /** Withdraw / repay are possible (not paused, spoke active and not halted). */
  canExit: boolean;
  reasons: string[];
  collateralFactor: number;
  riskPremium: number;
  /** Debt-leg borrow APR including the risk premium. */
  borrowApr: number;
  drawnApr: number;
}

export interface MapPairInput {
  protocol: string;
  chain: string;
  pairId: string;
  coll: ReserveMarketData;
  debt: ReserveMarketData;
  sameAsset: boolean;
  /** Fraction, e.g. 0.5 = +50% on the drawn rate. */
  riskPremiumFrac: number;
  supplyRewards: RewardRate[];
  borrowRewards: RewardRate[];
  swapCostFrac: number;
  swapDepthUsd: number;
  myLtv?: number;
  dataAsOfMs: number;
}

const usd = (units: bigint, r: ReserveMarketData) => toHuman(units, r.decimals) * r.priceUsd;
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function entryBlockers(coll: ReserveMarketData, debt: ReserveMarketData, sameAsset: boolean): string[] {
  const out: string[] = [];
  const C = coll.symbol;
  const D = debt.symbol;
  if (coll.paused) out.push(`${C} reserve paused`);
  if (coll.frozen) out.push(`${C} reserve frozen (no new supply / collateral)`);
  if (!(coll.collateralFactorBps > 0)) out.push(`${C} collateral factor is 0 on this spoke (cannot back a borrow)`);
  if (!coll.spokeActive) out.push(`${C}: spoke inactive on the hub`);
  if (coll.spokeHalted) out.push(`${C}: spoke halted on the hub`);
  const addRoom = capRemaining(coll.addCap, coll.decimals, coll.spokeAdded);
  if (addRoom !== null && addRoom === 0n) out.push(`${C} supply cap (addCap ${coll.addCap}) reached`);
  if (debt.paused && !sameAsset) out.push(`${D} reserve paused`);
  if (debt.frozen && !sameAsset) out.push(`${D} reserve frozen (no new borrows)`);
  if (!debt.borrowable) out.push(`${D} is not borrowable on this spoke`);
  if (!sameAsset && !debt.spokeActive) out.push(`${D}: spoke inactive on the hub`);
  if (!sameAsset && debt.spokeHalted) out.push(`${D}: spoke halted on the hub`);
  if (debt.drawCap === 0n) out.push(`${D} drawCap is 0 for this spoke`);
  else {
    const drawRoom = capRemaining(debt.drawCap, debt.decimals, debt.spokeDrawn + debt.spokePremium + debt.spokeDeficit);
    if (drawRoom !== null && drawRoom === 0n) out.push(`${D} borrow cap (drawCap ${debt.drawCap}) reached`);
  }
  if (debt.hubLiquidity === 0n) out.push(`${D}: no hub liquidity`);
  return out;
}

export function exitBlockers(coll: ReserveMarketData, debt: ReserveMarketData): string[] {
  const out: string[] = [];
  for (const r of [coll, debt]) {
    if (r.paused) out.push(`${r.symbol} reserve paused (withdraw/repay blocked)`);
    if (!r.spokeActive) out.push(`${r.symbol}: spoke inactive on the hub (all actions blocked)`);
    if (r.spokeHalted) out.push(`${r.symbol}: spoke halted on the hub (liquidity flows blocked)`);
  }
  return [...new Set(out)];
}

export function mapLoopPair(x: MapPairInput): { pair: LoopPair; status: PairStatus } {
  const { coll, debt } = x;
  const rp = x.riskPremiumFrac;
  const blockers = entryBlockers(coll, debt, x.sameAsset);
  const exits = exitBlockers(coll, debt);
  const canOpen = blockers.length === 0;

  const drawnAprDebt = rayToNumber(debt.drawnRateRay);
  const borrowApr = borrowAprWithRiskPremium(drawnAprDebt, rp);

  // --- collateral leg (spoke reserve level)
  const S_c = usd(coll.reserveSupplied, coll);
  const spokeAvail = coll.reserveSupplied > coll.reserveDrawn + coll.reservePremium ? coll.reserveSupplied - coll.reserveDrawn - coll.reservePremium : 0n;
  const withdrawable = min(spokeAvail, coll.hubLiquidity);
  const B_c = usd(coll.reserveSupplied - withdrawable, coll);
  const addRoom = capRemaining(coll.addCap, coll.decimals, coll.spokeAdded);
  const collSupplyApr = hubSupplyApr({
    drawnRateRay: coll.drawnRateRay,
    drawn: coll.hubDrawn,
    premium: coll.hubPremium,
    addedAssets: coll.hubAdded,
    liquidityFeeBps: coll.liquidityFeeBps,
  });

  // --- debt leg (hub level)
  const S_d = usd(debt.hubLiquidity + debt.hubDrawn + debt.hubSwept, debt);
  const B_d = usd(debt.hubDrawn + debt.hubSwept, debt);
  const drawRoom = debt.drawCap === 0n ? 0n : capRemaining(debt.drawCap, debt.decimals, debt.spokeDrawn + debt.spokePremium + debt.spokeDeficit);
  const debtIrm = debt.irm ? irmFromRateData(debt.irm, debt.liquidityFeeBps, 1 + rp) : undefined;

  let collateral: LoopLeg;
  let debtLeg: LoopLeg;
  if (x.sameAsset) {
    // One market: hub-level totals, borrow cost incl. premium, no IRM (it would also drive the supply side).
    const leg: LoopLeg = {
      symbol: coll.symbol,
      assetId: coll.address,
      priceUsd: coll.priceUsd,
      totalSupplyUsd: S_c,
      totalBorrowUsd: B_c,
      supplyAprBase: collSupplyApr,
      borrowAprBase: borrowApr,
      supplyRewards: x.supplyRewards,
      borrowRewards: x.borrowRewards,
      supplyCapRemainingUsd: canOpen ? (addRoom === null ? null : usd(addRoom, coll)) : 0,
      borrowCapRemainingUsd: canOpen ? (drawRoom === null ? null : usd(drawRoom, debt)) : 0,
    };
    collateral = leg;
    debtLeg = leg;
  } else {
    collateral = {
      symbol: coll.symbol,
      assetId: coll.address,
      priceUsd: coll.priceUsd,
      totalSupplyUsd: S_c,
      totalBorrowUsd: B_c,
      supplyAprBase: collSupplyApr,
      borrowAprBase: borrowAprWithRiskPremium(rayToNumber(coll.drawnRateRay), rp),
      supplyRewards: x.supplyRewards,
      borrowRewards: [],
      supplyCapRemainingUsd: !canOpen ? 0 : addRoom === null ? null : usd(addRoom, coll),
    };
    debtLeg = {
      symbol: debt.symbol,
      assetId: debt.address,
      priceUsd: debt.priceUsd,
      totalSupplyUsd: S_d,
      totalBorrowUsd: B_d,
      supplyAprBase: hubSupplyApr({
        drawnRateRay: debt.drawnRateRay,
        drawn: debt.hubDrawn,
        premium: debt.hubPremium,
        addedAssets: debt.hubAdded,
        liquidityFeeBps: debt.liquidityFeeBps,
      }),
      borrowAprBase: borrowApr,
      supplyRewards: [],
      borrowRewards: x.borrowRewards,
      irm: debtIrm,
      borrowCapRemainingUsd: !canOpen ? 0 : drawRoom === null ? null : usd(drawRoom, debt),
    };
  }

  const cf = bpsToFrac(coll.collateralFactorBps);
  const pair: LoopPair = {
    protocol: x.protocol,
    chain: x.chain,
    pairId: x.pairId,
    collateral,
    debt: debtLeg,
    maxLtv: cf,
    liqLtv: cf,
    swapCostFrac: x.sameAsset ? 0 : x.swapCostFrac,
    swapDepthUsd: x.sameAsset ? Infinity : x.swapDepthUsd,
    flashloanFeeFrac: 0,
    paused: exits.length > 0,
    dataAsOfMs: x.dataAsOfMs,
  };
  if (x.myLtv !== undefined) pair.myLtv = x.myLtv;
  return {
    pair,
    status: {
      pairId: x.pairId,
      canOpen,
      canExit: exits.length === 0,
      reasons: [...blockers, ...exits.filter((e) => !blockers.includes(e))],
      collateralFactor: cf,
      riskPremium: rp,
      borrowApr,
      drawnApr: drawnAprDebt,
    },
  };
}
