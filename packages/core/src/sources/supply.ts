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
import type { Opportunity } from "../types.js";
import type { IrmModel, RewardRate } from "./loopLending.js";
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

/**
 * SupplyMarket -> Opportunity (kind "deposit"), or null on invalid input.
 * Implemented by the core agent (see docs in this file's header).
 */
export function supplyOpportunity(_m: SupplyMarket, _ctx: SourceContext, _sourceId: string): Opportunity | null {
  throw new Error("supplyOpportunity: not implemented yet");
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
