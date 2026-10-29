/**
 * @incentive-router/live-aave-v4 — Aave V4 (hub & spoke) LendingAdapter.
 * Spoke calls are self-encoded from the verified aave-v4 v0.5.11 ABI and
 * guard-checked; AaveKit (@aave/client) is used for reads / cross-checks only.
 */
export { AaveV4Adapter, type PairSnapshot, type ReserveSnapshot, type UserSnapshot } from "./adapter.js";
export { AAVE_V4_PROTOCOL, aaveV4AdapterId, type AaveV4AdapterOptions, type AaveV4PairConfig, type AaveV4SpokeConfig } from "./config.js";
export { aaveKitApi, parseHealthFactorCriterion, pctValue, rewardsFromApiReserve, type AaveV4Api, type ApiRewardMapping } from "./api.js";
export {
  assertTx,
  checkExecutionPlan,
  checkTx,
  TxGuardError,
  type ExpectedCall,
  type SpokeCallSpec,
  type TxGuardPolicy,
  type TxLike,
} from "./guard.js";
export { entryBlockers, exitBlockers, mapLoopPair, type InterestRateData, type MapPairInput, type PairStatus, type ReserveMarketData } from "./market.js";
export {
  apyToApr,
  borrowAprWithRiskPremium,
  capRemaining,
  hubSupplyApr,
  irmFromRateData,
  nextLoopBorrow,
  planLoopSteps,
  planUnwind,
  unwindStep,
  validateTargetLtv,
  MAX_TARGET_FRAC_OF_MAX_LTV,
  type LoopPlan,
  type LoopPlanOptions,
  type LoopStep,
  type UnwindGoal,
  type UnwindParams,
  type UnwindPlan,
  type UnwindStep,
} from "./math.js";
export { EIP1967_IMPLEMENTATION_SLOT, HUB_ABI, IRM_ABI, ORACLE_ABI, SPOKE_ABI } from "./abi.js";
