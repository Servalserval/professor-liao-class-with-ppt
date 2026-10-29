/**
 * Supply-only ("plain lending") opportunities: deposit a stablecoin into a
 * lending market or vault and earn its supply rate + rewards, with no
 * borrowing and no leverage. Used where a loop is impossible or not worth it
 * (net-lending campaigns that pay suppliers only, vaults, savings rates).
 *
 * CONTRACT (orchestrator-owned types; the core agent implements the functions):
 * live adapters (packages/live-*) return SupplyMarket[]; the core turns each
 * into an Opportunity of kind "deposit" with the same valuation, gates and
 * allocator as loops, so the router chooses between loops and plain deposits
 * on one risk-adjusted scale.
 */
import { gasUsd } from "../config.js";
import { median, recentMetricValues } from "../signals.js";
import { stableRisk, usdPeg } from "../stables.js";
import type { Flag, Opportunity, StressSignal, YieldStream } from "../types.js";
import { proRataStream } from "../valuation.js";
import { interpIrm, type IrmModel, type RewardRate } from "./loopLending.js";
import type { Source, SourceContext } from "./types.js";

export interface SupplyAsset {
  /** Canonical symbol (USDC, USDT0, USDe, AUSD, USDsui ...). */
  symbol: string;
  /** Token address / coin type (lowercased for EVM) when known. */
  assetId?: string;
  /** MARKET price in USD (the live runner overrides adapter prices with market prices). */
  priceUsd: number;
}

export interface SupplyMarket {
  /** Venue id used for tiers / caps, e.g. "aave-v3", "aave-v4", "euler", "fluid", "morpho-vault", "navi", "suilend", "scallop". */
  protocol: string;
  chain: string;
  /** Unique within protocol+chain: a reserve symbol, a vault address, `<spoke>:<reserveId>` ... */
  marketId: string;
  asset: SupplyAsset;
  /** USD supplied to the market in total (a vault: totalAssets). */
  totalSupplyUsd: number;
  /** USD currently lent out (a vault: the part not withdrawable now). */
  totalBorrowUsd: number;
  /** Current base supply rate: yearly APR fraction (convert APY -> APR, daily compounding). */
  supplyAprBase: number;
  /**
   * Reward streams paid to suppliers (native + Merkl). For a plain supplier:
   * `netOf` does not reduce anything (we borrow nothing, basis = deposit);
   * `maxHealthFactor` campaigns are NOT earnable (they require borrowing);
   * `ineligibleIfBorrowing` is irrelevant; `perUserCapUsd` / `aprCap` apply.
   */
  rewards: RewardRate[];
  /** IRM of the underlying market; my deposit lowers utilization and therefore the rate. */
  irm?: IrmModel;
  /** USD anyone can withdraw right now (available liquidity). Default totalSupplyUsd - totalBorrowUsd. NaN = unknown. */
  withdrawableUsd?: number;
  supplyCapRemainingUsd?: number;
  depositFeeFrac?: number;
  withdrawFeeFrac?: number;
  /** Deposits disabled / market frozen / vault paused. */
  paused?: boolean;
  /** My current deposit in this market, USD (measured by the adapter). */
  myDepositUsd?: number;
  /** Block / API time of the data. */
  dataAsOfMs?: number;
  /** Vault-style products: where the money is actually lent (exposure / risk notes), e.g. "morpho:base:0x…". */
  underlying?: string[];
  /** Free-form note shown in reports (curator, strategy). */
  note?: string;
}

const fin = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const optFinNonNeg = (x: number | undefined) => x === undefined || (fin(x) && x >= 0);

function rewardOk(r: RewardRate): boolean {
  return (
    typeof r.token === "string" &&
    fin(r.apr) &&
    (r.perUserCapUsd === undefined || (fin(r.perUserCapUsd) && r.perUserCapUsd >= 0)) &&
    (r.maxHealthFactor === undefined || fin(r.maxHealthFactor)) &&
    (r.netOf === undefined || Array.isArray(r.netOf)) &&
    (r.ineligibleIfBorrowing === undefined || Array.isArray(r.ineligibleIfBorrowing)) &&
    (r.aprCap === undefined || (fin(r.aprCap) && r.aprCap >= 0)) &&
    (r.endsAtMs === undefined || r.endsAtMs === null || fin(r.endsAtMs))
  );
}

/**
 * SupplyMarket -> Opportunity (kind "deposit"), or null on invalid input.
 *
 * With S = totalSupplyUsd, B = totalBorrowUsd, my deposit already in S = m0
 * (adapter's myDepositUsd, else the router's position) and E = my total deposit:
 *   base, IRM known:  supply(u) = borrowIrm(u) x u x (1 - reserveFactor),  u(E) = B / (S - m0 + E)
 *   base, no IRM:     apr(E) = supplyAprBase x S / (S - m0 + E)          (my money dilutes the rate)
 *   rewards:          fixed emission pro rata over S (grossPerEquity 1); aprCap and
 *                     perUserCapUsd (basis = my deposit) apply; maxHealthFactor
 *                     campaigns need a borrow -> 0 ("requires_borrowing"); netOf has
 *                     no effect for a pure supplier ("net_lending_ok").
 *   costs:            deposit / withdraw fees; gas x sources.supply.txs_per_entry / exit;
 *                     ongoing = expected depeg loss of the asset (src/stables.ts).
 *   liquidity:        exit capacity = withdrawableUsd ?? S - B, footprint 1, so the
 *                     1/10 entry and 1/5 full-exit rules apply to withdrawable liquidity.
 *                     NaN = unknown: the recent observations (median of up to 3 within
 *                     portfolio.max_data_age_minutes) are reused and entries are blocked;
 *                     with none the market is not reported (blind; no exit on one cycle).
 *   signals:          utilization (now / after my deposit) and depeg |price - 1| with the
 *                     asset's levels; paused -> warn flag "deposits_paused" (blocks
 *                     entries and top-ups, never an exit by itself). No health metric.
 */
export function supplyOpportunity(m: SupplyMarket, ctx: SourceContext, sourceId: string): Opportunity | null {
  const { cfg } = ctx;
  if (!m || typeof m.protocol !== "string" || typeof m.chain !== "string" || typeof m.marketId !== "string") return null;
  if (!m.asset || typeof m.asset.symbol !== "string" || !m.asset.symbol) return null;
  if (!fin(m.asset.priceUsd) || !(m.asset.priceUsd > 0)) return null;
  if (!fin(m.totalSupplyUsd) || !(m.totalSupplyUsd > 0) || !fin(m.totalBorrowUsd) || m.totalBorrowUsd < 0) return null;
  // NaN supplyAprBase = UNKNOWN (e.g. a vault's share-price history read failed): handled below
  const aprUnknown = Number.isNaN(m.supplyAprBase);
  if (!aprUnknown && !fin(m.supplyAprBase)) return null;
  if (!Array.isArray(m.rewards) || !m.rewards.every(rewardOk)) return null;
  if (!optFinNonNeg(m.depositFeeFrac) || !optFinNonNeg(m.withdrawFeeFrac) || !optFinNonNeg(m.supplyCapRemainingUsd)) return null;
  if (!optFinNonNeg(m.myDepositUsd)) return null;
  const withdrawUnknown = m.withdrawableUsd !== undefined && Number.isNaN(m.withdrawableUsd);
  if (m.withdrawableUsd !== undefined && !withdrawUnknown && !(fin(m.withdrawableUsd) && m.withdrawableUsd >= 0)) return null;
  if (m.irm && (!Array.isArray(m.irm.points) || !m.irm.points.length || !fin(m.irm.reserveFactor))) return null;

  const sup = cfg.sources.supply;
  const id = `${sourceId}:${m.protocol}:${m.marketId}`;
  const S = m.totalSupplyUsd;
  const B = m.totalBorrowUsd;
  const myInPool = Math.min(S, m.myDepositUsd ?? ctx.myEquityByOpp[id] ?? 0);
  const exMe = Math.max(0, S - myInPool);
  const uAt = (E: number) => {
    const d = exMe + Math.max(0, E);
    return d > 0 ? Math.min(1, B / d) : 0;
  };
  const uNow = Math.min(1, B / S);

  // --- base supply rate (NaN without IRM: last recent rate, else blind) ------------
  const since = ctx.nowMs - cfg.portfolio.max_data_age_minutes * 60_000;
  const flags: Flag[] = [];
  let supplyAprBase = m.supplyAprBase;
  if (aprUnknown && !m.irm) {
    const prev = recentMetricValues(ctx.history, id, "supply_apr", since);
    // no recent rate: not reported this cycle (blind) — never valued as 0, never a fake edge
    if (!prev.length) return null;
    supplyAprBase = prev[prev.length - 1]!;
    flags.push({ name: "rate_unknown", severity: "warn", detail: "supply APR unknown this cycle; last recent rate reused (no entries)" });
  }
  const irm = m.irm;
  const baseAt = irm
    ? (E: number) => {
        const u = uAt(E);
        return interpIrm(irm, u) * u * (1 - irm.reserveFactor);
      }
    : (E: number) => {
        const d = exMe + Math.max(0, E);
        return d > 0 ? (supplyAprBase * S) / d : 0;
      };
  const streams: YieldStream[] = [{ label: "supply_base", kind: "base", aprAt: baseAt }];

  // --- rewards (supplier view) ---------------------------------------------------
  const rewardNotes: Record<string, string[]> = {};
  for (const r of m.rewards) {
    const label = `supply_reward:${r.token}`;
    const notes: string[] = [];
    if (r.netOf?.length) notes.push("net_lending_ok");
    if (r.maxHealthFactor !== undefined) notes.push("requires_borrowing");
    if (r.perUserCapUsd !== undefined) notes.push(`per_user_cap_usd_${r.perUserCapUsd}`);
    if (r.aprCap !== undefined && r.apr > r.aprCap) notes.push(`apr_capped_${r.aprCap}`);
    if (notes.length) rewardNotes[label] = notes;
    const base = proRataStream({
      label,
      kind: "reward",
      aprNow: r.aprCap !== undefined ? Math.min(r.apr, r.aprCap) : r.apr,
      poolUsd: S,
      grossPerEquity: 1,
      myEquityNowUsd: myInPool,
      aprMultiplier: 1,
      rewardToken: r.token,
      endsAtMs: r.endsAtMs ?? null,
    });
    const cap = r.perUserCapUsd;
    if (r.maxHealthFactor !== undefined || cap === 0) streams.push({ ...base, aprAt: () => 0 });
    else if (cap === undefined) streams.push(base);
    else
      streams.push({
        ...base,
        aprAt: (E: number) => {
          const apr = base.aprAt(E);
          return E > cap ? apr * (cap / E) : apr;
        },
      });
  }

  // --- withdrawable liquidity (NaN = unknown) ----------------------------------------
  let capacity: number;
  let reused = false;
  if (withdrawUnknown) {
    const prev = recentMetricValues(ctx.history, id, "withdrawable_usd", since);
    if (!prev.length) return null; // blind this cycle: never a 0-capacity exit
    capacity = median(prev.slice(-3));
    reused = true;
    flags.push({ name: "liquidity_unknown", severity: "warn", detail: "withdrawable liquidity reused from recent reads" });
  } else capacity = m.withdrawableUsd ?? Math.max(0, S - B);
  if (m.paused) flags.push({ name: "deposits_paused", severity: "warn", detail: "deposits disabled / market frozen" });

  // --- risk ------------------------------------------------------------------------------
  const risk = stableRisk(cfg, m.asset.symbol);
  const ll = cfg.sources.lending_loop;
  const peg = usdPeg(m.asset.symbol);
  const depeg = peg === null ? 0 : Math.abs(m.asset.priceUsd / peg - 1);
  const sig = (name: string, value: number, warnAt: number, exitAt: number): StressSignal => ({ name, value, warnAt, exitAt, direction: "above" });
  const signalsAt = (u: number): StressSignal[] => [
    sig("utilization", u, ll.utilization_warn, ll.utilization_exit),
    ...(peg === null ? [] : [sig("depeg", depeg, risk.depegWarn, risk.depegExit)]),
  ];

  const gas = gasUsd(cfg, m.chain);
  // raw fresh observations only (the NaN fallbacks above read these back)
  const metrics: Record<string, number> = { utilization: uNow, tvl_usd: S, depeg };
  if (!aprUnknown) metrics.supply_apr = m.supplyAprBase;
  if (!withdrawUnknown && m.withdrawableUsd !== undefined) metrics.withdrawable_usd = m.withdrawableUsd;
  else if (!withdrawUnknown) metrics.withdrawable_usd = capacity;

  const meta: Record<string, unknown> = {
    marketId: m.marketId,
    supply: true,
    depegLossApr: risk.lossApr,
    stableRisk: { symbol: m.asset.symbol, tier: risk.tier, lossApr: risk.lossApr, known: risk.known },
  };
  if (Object.keys(rewardNotes).length) meta.rewardNotes = rewardNotes;
  if (m.underlying?.length) meta.underlying = m.underlying;
  if (m.note) meta.note = m.note;

  const o: Opportunity = {
    id,
    sourceId,
    kind: "deposit",
    name: `${m.protocol} ${m.asset.symbol} supply (${m.chain})`,
    primaryVenue: m.protocol,
    chain: m.chain,
    legs: [{ venue: m.protocol, chain: m.chain, token: m.asset.symbol, equityFrac: 1 }],
    streams,
    costs: {
      entryFrac: m.depositFeeFrac ?? 0,
      exitFrac: m.withdrawFeeFrac ?? 0,
      fixedEntryUsd: gas * sup.txs_per_entry,
      fixedExitUsd: gas * sup.txs_per_exit,
      ongoingApr: risk.lossApr,
    },
    liquidity: {
      exitCapacityUsd: capacity,
      footprintPerEquity: 1,
      binding: "pool",
      ...(reused ? { estimated: true, reusedQuote: true } : {}),
    },
    signals: signalsAt(uNow),
    projectedSignals: (E) => signalsAt(uAt(E)),
    flags,
    metrics,
    maxEquityUsd: m.supplyCapRemainingUsd !== undefined ? myInPool + m.supplyCapRemainingUsd : undefined,
    funding: { chain: m.chain, asset: m.asset.symbol },
    myEquityUsd: ctx.myEquityByOpp[id] ?? m.myDepositUsd ?? 0,
    observedAtMs: ctx.nowMs,
    meta,
  };
  if (m.dataAsOfMs !== undefined) o.dataAsOfMs = m.dataAsOfMs;
  return o;
}

/** Wrap any async supply-market provider (live adapters). */
export class SupplySource implements Source {
  constructor(
    readonly id: string,
    private readonly provider: () => Promise<SupplyMarket[]>
  ) {}
  async fetch(ctx: SourceContext): Promise<Opportunity[]> {
    const markets = await this.provider();
    return markets.map((m) => supplyOpportunity(m, ctx, this.id)).filter((o): o is Opportunity => o !== null);
  }
}
