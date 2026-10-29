/**
 * AaveKit (@aave/client 7.1.0) access, behind a small injectable interface so
 * tests (and the offline sandbox) can mock it.
 *
 * What the adapter uses AaveKit for — never for health-critical numbers and
 * never to sign server-built calldata:
 *  - verifyConfig(): the spoke / hub / reserves AaveKit reports must match the
 *    on-chain reads (identity cross-check of the configured addresses);
 *  - markets(): Merkl reward metadata attached to reserves (only when no
 *    extraRewards provider is injected, see `apiMerklRewards`) and a
 *    consistency check of collateral factor / borrowability;
 *  - optional `apiCrossCheck`: request AaveKit's ExecutionPlan for the same
 *    action and require that it decodes to exactly our self-encoded call;
 *  - claimRewards(): list claimable rewards (Merkl ones are skipped: the
 *    MerklClaimer claims them wallet-wide).
 *
 * AaveKit's default request policy is "cache-and-network" (can resolve with
 * cached data), so every read here forces "network-only", and a client we
 * create ourselves has the cache disabled.
 */
import { AaveClient, RewardAccrualBasis, type BigDecimal, type ResultAsync } from "@aave/client";
import {
  borrow as borrowAction,
  claimRewards as claimRewardsAction,
  repay as repayAction,
  reserves as reservesAction,
  spoke as spokeAction,
  supply as supplyAction,
  userClaimableRewards as userClaimableRewardsAction,
  withdraw as withdrawAction,
} from "@aave/client/actions";
import type {
  BorrowRequest,
  ClaimRewardsRequest,
  ExecutionPlan,
  RepayRequest,
  Reserve,
  ReservesRequest,
  Spoke,
  SpokeRequest,
  SupplyRequest,
  TransactionRequest,
  UserClaimableReward,
  UserClaimableRewardsRequest,
  WithdrawRequest,
} from "@aave/client";
import type { RewardRate } from "@incentive-router/core";
import { apyToApr } from "./math.js";

export interface AaveV4Api {
  spoke(req: SpokeRequest): Promise<Spoke | null>;
  reserves(req: ReservesRequest): Promise<Reserve[]>;
  userClaimableRewards(req: UserClaimableRewardsRequest): Promise<UserClaimableReward[]>;
  claimRewards(req: ClaimRewardsRequest): Promise<TransactionRequest>;
  supply(req: SupplyRequest): Promise<ExecutionPlan>;
  borrow(req: BorrowRequest): Promise<ExecutionPlan>;
  repay(req: RepayRequest): Promise<ExecutionPlan>;
  withdraw(req: WithdrawRequest): Promise<ExecutionPlan>;
}

async function unwrap<T, E>(r: ResultAsync<T, E>, what: string): Promise<T> {
  const x = await r;
  if (x.isErr()) {
    const e: unknown = x.error;
    throw new Error(`AaveKit ${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return x.value;
}

/** Default AaveKit-backed implementation. `client` defaults to AaveClient.create({ cache: false }). */
export function aaveKitApi(client: AaveClient = AaveClient.create({ cache: false })): AaveV4Api {
  const opts = { requestPolicy: "network-only" as const };
  return {
    spoke: (req) => unwrap(spokeAction(client, req, opts), "spoke"),
    reserves: (req) => unwrap(reservesAction(client, req, opts), "reserves"),
    userClaimableRewards: (req) => unwrap(userClaimableRewardsAction(client, req, opts), "userClaimableRewards"),
    claimRewards: (req) => unwrap(claimRewardsAction(client, req), "claimRewards"),
    supply: (req) => unwrap(supplyAction(client, req), "supply"),
    borrow: (req) => unwrap(borrowAction(client, req), "borrow"),
    repay: (req) => unwrap(repayAction(client, req), "repay"),
    withdraw: (req) => unwrap(withdrawAction(client, req), "withdraw"),
  };
}

// ---------------------------------------------------------------------------
// Pure mapping helpers (tested)
// ---------------------------------------------------------------------------

/** PercentNumber.value: "1.0 represents 100%" (AaveKit schema). */
export function pctValue(p: { value: BigDecimal } | null | undefined): number | undefined {
  if (!p) return undefined;
  const v = p.value.toApproximateNumber();
  return Number.isFinite(v) ? v : undefined;
}

interface MinimalMerklReward {
  __typename: string;
  id: string;
  endDate?: Date | null;
  extraApy?: { value: BigDecimal };
  discountApy?: { value: BigDecimal };
  accrualBasis?: string;
  nettedBy?: { info: { symbol: string } }[];
  payoutToken?: { info: { symbol: string } };
  criteria?: { text: string }[] | null;
}

export interface ApiRewardMapping {
  rewards: RewardRate[];
  /** Rewards seen but not counted, with the reason (logged by the adapter). */
  skipped: { id: string; reason: string }[];
}

const UPPER = /(<=|≤|=<|<|below|under|at most|less than|lower than|not (?:exceed|above)|max(?:imum)?(?: of)?|up to)/i;
const LOWER = /(>=|≥|=>|>|above|over|at least|greater than|higher than|min(?:imum)?(?: of)?)/i;
const HF = /\b(health[\s-]*factor|hf)\b/i;

/**
 * Parse a Merkl criteria text for a health-factor bound. Returns
 *  - { max } for "HF <= 2" / "health factor below 2" / "max HF of 2",
 *  - "unsupported" when HF is mentioned but no upper bound can be read (a
 *    lower bound cannot be expressed in RewardRate -> caller drops the reward),
 *  - null when HF is not mentioned.
 */
export function parseHealthFactorCriterion(text: string): { max: number } | "unsupported" | null {
  const m = HF.exec(text);
  if (!m) return null;
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
  const head = text.slice(Math.max(0, m.index - 30), m.index);
  const num = /([0-9]+(?:\.[0-9]+)?)/.exec(tail);
  const upper = UPPER.exec(tail) ?? UPPER.exec(head);
  const lower = LOWER.exec(tail);
  if (num && upper && (!lower || (upper.index ?? 0) <= (lower.index ?? Infinity))) return { max: Number(num[1]) };
  return "unsupported";
}

/**
 * Map AaveKit reserve rewards (Merkl campaigns attached to the reserve) to
 * core RewardRates for one side. Points programs are ignored (no APR).
 * APY -> APR (daily compounding, conservative). NET accrual -> netOf.
 */
export function rewardsFromApiReserve(reserve: { summary: { rewards: readonly unknown[] } }, side: "supply" | "borrow", nowMs: number): ApiRewardMapping {
  const want = side === "supply" ? "MerklSupplyReward" : "MerklBorrowReward";
  const out: ApiRewardMapping = { rewards: [], skipped: [] };
  for (const raw of reserve.summary.rewards) {
    const r = raw as MinimalMerklReward;
    if (r.__typename !== want) continue;
    const endsAtMs = r.endDate instanceof Date ? r.endDate.getTime() : null;
    if (endsAtMs !== null && endsAtMs <= nowMs) {
      out.skipped.push({ id: r.id, reason: "ended" });
      continue;
    }
    const apy = pctValue(side === "supply" ? r.extraApy : r.discountApy);
    if (apy === undefined || !(apy > 0)) {
      out.skipped.push({ id: r.id, reason: "no apy" });
      continue;
    }
    const rate: RewardRate = { token: r.payoutToken?.info.symbol ?? "UNKNOWN", apr: apyToApr(apy), endsAtMs };
    if (r.accrualBasis === RewardAccrualBasis.Net) {
      const syms = (r.nettedBy ?? []).map((t) => t.info.symbol);
      rate.netOf = syms.length ? syms : ["*"];
    }
    let drop: string | null = null;
    for (const c of r.criteria ?? []) {
      const hf = parseHealthFactorCriterion(c.text);
      if (hf === "unsupported") drop = `health-factor criterion not expressible: "${c.text}"`;
      else if (hf) rate.maxHealthFactor = Math.min(rate.maxHealthFactor ?? Infinity, hf.max);
    }
    if (drop) {
      out.skipped.push({ id: r.id, reason: drop });
      continue;
    }
    out.rewards.push(rate);
  }
  return out;
}
