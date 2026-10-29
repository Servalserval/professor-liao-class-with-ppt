/**
 * Wallet-level reward handling for live mode.
 *
 * Why this exists outside the core Router: in live mode the router does not
 * accrue rewards from its model (that is paper-only), and most stablecoin
 * incentives in 2026 are Merkl campaigns paid per WALLET per chain, not per
 * position. So, on its own schedule (>= Merkl's ~2h refresh), the keeper:
 *   1. claims Merkl rewards on every chain that has a claimer, if worth it;
 *   2. claims native protocol rewards (Navi / Suilend / Scallop / Aave
 *      RewardsController) when the adapters' position views show enough;
 *   3. sells configured reward tokens (WMON, WAVAX, sSUI, SCA ...) into the
 *      chain's cash stablecoin through the chain's swapper.
 * Proceeds land in the wallet, so the router sees them as idle cash next
 * cycle (idleBalances) and redeploys them under the normal rules.
 * Reward tokens that are themselves collateral receipts (e.g. aUSDe from
 * Ethena Liquid Leverage) are NOT sold: they already raise the position's
 * collateral and show up in markToMarket.
 *
 * In shadow mode every claim / sell is built and simulated only.
 */
import {
  type AssetRef,
  type LendingAdapter,
  type LiveContext,
  type RewardClaimer,
  type SwapAdapter,
  unitsToUsd,
} from "@incentive-router/live-common";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RewardKeeperOptions {
  intervalHours: number;
  minClaimUsd: number;
  minSellUsd: number;
}

export interface RewardKeeperDeps {
  mode: "live" | "shadow";
  ctx: LiveContext;
  claimers: RewardClaimer[];
  /** Adapter + the pair ids configured on it (for position reads). */
  lending: { adapter: LendingAdapter; pairIds: string[] }[];
  owner: (chain: string) => string | undefined;
  /** chain -> reward tokens to sell when they sit in the wallet. */
  sellables: Record<string, AssetRef[]>;
  /** chain -> cash stablecoin. */
  cash: Record<string, AssetRef>;
  swappers: Record<string, SwapAdapter>;
  balance: (a: AssetRef) => Promise<bigint>;
  statePath: string;
  opts: RewardKeeperOptions;
  now?: () => number;
}

interface KeeperState {
  lastRunMs: number | null;
}

export class RewardKeeper {
  private readonly now: () => number;
  constructor(private readonly d: RewardKeeperDeps) {
    this.now = d.now ?? (() => Date.now());
  }

  private load(): KeeperState {
    if (!existsSync(this.d.statePath)) return { lastRunMs: null };
    try {
      return JSON.parse(readFileSync(this.d.statePath, "utf8")) as KeeperState;
    } catch {
      return { lastRunMs: null };
    }
  }
  private save(s: KeeperState) {
    mkdirSync(dirname(this.d.statePath), { recursive: true });
    writeFileSync(this.d.statePath, JSON.stringify(s));
  }

  due(): boolean {
    const s = this.load();
    return s.lastRunMs === null || this.now() - s.lastRunMs >= this.d.opts.intervalHours * 3_600_000;
  }

  private wctx(): LiveContext {
    return { ...this.d.ctx, dryRun: this.d.mode === "shadow" || this.d.ctx.dryRun };
  }

  /** Run once if due (or when forced). Returns human-readable lines for logs / Telegram. */
  async run(force = false): Promise<string[]> {
    if (!force && !this.due()) return [];
    const out: string[] = [];
    const tag = this.d.mode === "shadow" ? "[shadow] " : "";
    const ctx = this.wctx();

    // 1. Merkl (wallet-level, per chain)
    for (const c of this.d.claimers) {
      const owner = this.d.owner(c.chain);
      if (!owner) continue;
      try {
        const items = await c.claimable(owner);
        let usd = 0;
        for (const it of items) usd += unitsToUsd(it.amount, await this.d.ctx.priceUsd(it.token), it.token.decimals);
        if (usd < this.d.opts.minClaimUsd) {
          if (usd > 0) out.push(`${c.id}: $${usd.toFixed(2)} claimable < min $${this.d.opts.minClaimUsd}, skip`);
          continue;
        }
        const r = await c.claim(owner, ctx);
        out.push(`${tag}${c.id}: claim $${usd.toFixed(2)} ${r.ok ? "OK" : `FAILED ${r.detail ?? ""}`}`);
      } catch (e) {
        out.push(`${c.id}: ERROR ${(e as Error).message}`);
      }
    }

    // 2. native protocol rewards
    for (const { adapter, pairIds } of this.d.lending) {
      try {
        let usd = 0;
        for (const id of pairIds) {
          const v = await adapter.position(id);
          if (v) usd += v.rewardsUnclaimed.reduce((a, r) => a + (Number.isFinite(r.usd) ? r.usd : 0), 0);
        }
        if (usd < this.d.opts.minClaimUsd) continue;
        const r = await adapter.claimRewards(ctx);
        out.push(`${tag}${adapter.id}: native claim $${usd.toFixed(2)} ${r.ok ? "OK" : `FAILED ${r.detail ?? ""}`}`);
      } catch (e) {
        out.push(`${adapter.id}: ERROR ${(e as Error).message}`);
      }
    }

    // 3. sell reward tokens sitting in the wallet
    for (const [chain, tokens] of Object.entries(this.d.sellables)) {
      const cash = this.d.cash[chain];
      const sw = this.d.swappers[chain];
      if (!cash || !sw) {
        if (tokens.length) out.push(`${chain}: cannot sell rewards (no cash asset or swapper configured)`);
        continue;
      }
      for (const t of tokens) {
        try {
          const bal = await this.d.balance(t);
          if (bal <= 0n) continue;
          const usd = unitsToUsd(bal, await this.d.ctx.priceUsd(t), t.decimals);
          if (usd < this.d.opts.minSellUsd) continue;
          const q = await sw.quote(t, cash, bal, this.d.ctx);
          const r = await sw.swap(q, t, cash, ctx);
          out.push(`${tag}${chain}: sell ${t.symbol} $${usd.toFixed(2)} -> ${cash.symbol} (${q.costBps.toFixed(1)} bps) ${r.ok ? "OK" : `FAILED ${r.detail ?? ""}`}`);
        } catch (e) {
          out.push(`${chain}: sell ${t.symbol} ERROR ${(e as Error).message}`);
        }
      }
    }

    this.save({ lastRunMs: this.now() });
    return out;
  }
}
