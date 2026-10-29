import { gasUsd, rewardTokenConfig } from "./config.js";
import type { DecisionContext } from "./gates/common.js";
import { tokenDrawdown24h } from "./signals.js";
import type { Action } from "./types.js";

const HOUR = 3600_000;

/**
 * Reward-token handling for the whole book (Plasma/XPL lesson: the people who
 * sold on claim earned the marketing budget; the people who held it became
 * the pig). Per token policy:
 *
 *   sell_on_claim  claim on schedule, sell everything claimed (default)
 *   hedge          keep a short perp = unclaimed + held; falls back to sell if no perp
 *   hold           sell only what exceeds max_hold_usd
 *
 * Overrides for every policy:
 *   - 24h price crash  >= price_crash_frac  -> claim (if worth the gas) and dump
 *   - book exposure    >  per_reward_token_frac of equity -> claim and sell down
 *   - never claim below gas x claim_gas_multiple (crash / over-cap skip only the schedule)
 */
export function planRewards(ctx: DecisionContext): Action[] {
  const { cfg } = ctx;
  const out: Action[] = [];
  const hedgeTargets: Record<string, number> = {};
  const hedgedNow: Record<string, number> = {};

  for (const pos of ctx.positions) {
    const gas = gasUsd(cfg, pos.chain);
    for (const [token, r] of Object.entries(pos.rewards)) {
      const tc = rewardTokenConfig(cfg, token);
      const profile = ctx.tokens[token];
      const crash = tokenDrawdown24h(ctx.history, token, ctx.nowMs) >= cfg.rewards.price_crash_frac;
      const bookExposure = ctx.exposure.byRewardToken[token] ?? 0;
      const overCap = ctx.totalEquityUsd > 0 && bookExposure / ctx.totalEquityUsd > cfg.caps.per_reward_token_frac;
      const elapsedH = (ctx.nowMs - r.lastClaimAtMs) / HOUR;
      const normalMin = Math.max(tc.claim_min_usd, gas * cfg.rewards.claim_gas_multiple);

      // Crash / over-cap skip the schedule but still respect gas economics
      // and a minimum spacing (otherwise a 24h crash window claims every cycle).
      const urgentMin = gas * cfg.rewards.claim_gas_multiple;
      const urgentOk = elapsedH >= Math.min(tc.claim_interval_hours, cfg.rewards.urgent_claim_min_interval_hours);
      let claim = 0;
      let reason = "";
      if (crash && urgentOk && r.unclaimedUsd >= urgentMin) {
        claim = r.unclaimedUsd;
        reason = `${token} -${(tokenDrawdown24h(ctx.history, token, ctx.nowMs) * 100).toFixed(0)}% in 24h`;
      } else if (overCap && urgentOk && r.unclaimedUsd >= urgentMin) {
        claim = r.unclaimedUsd;
        reason = `${token} exposure over ${(cfg.caps.per_reward_token_frac * 100).toFixed(1)}% cap`;
      } else if (elapsedH >= tc.claim_interval_hours && r.unclaimedUsd >= normalMin) {
        claim = r.unclaimedUsd;
        reason = "scheduled claim";
      }
      if (claim > 0) out.push({ type: "claim", oppId: pos.oppId, token, amountUsd: claim, reason });

      const held = r.heldUsd + claim;
      const unclaimedLeft = r.unclaimedUsd - claim;
      const canHedge = tc.policy === "hedge" && profile?.perpAvailable === true;

      let sell = 0;
      let sellReason = "";
      if (crash || overCap) {
        sell = held;
        sellReason = crash ? "price crash: dump" : "exposure cap: sell down";
      } else if (tc.policy === "sell_on_claim" || (tc.policy === "hedge" && !canHedge)) {
        sell = held;
        sellReason = tc.policy === "hedge" ? "no perp to hedge: sell" : "sell on claim";
      } else if (tc.policy === "hold") {
        sell = Math.max(0, held - tc.max_hold_usd);
        sellReason = "above max_hold_usd";
      }
      if (sell > 1e-9) out.push({ type: "sell", oppId: pos.oppId, token, amountUsd: sell, reason: sellReason });

      if (canHedge) {
        hedgeTargets[token] = (hedgeTargets[token] ?? 0) + unclaimedLeft + (held - sell);
        hedgedNow[token] = (hedgedNow[token] ?? 0) + r.hedgedUsd;
      }
    }
  }

  // Hedges with no remaining exposure (last position closed, perp delisted,
  // policy changed) must be closed, not orphaned.
  for (const [token, cur] of Object.entries(ctx.hedges))
    if (cur > 0 && hedgeTargets[token] === undefined) {
      out.push({ type: "hedge", token, targetShortUsd: 0, reason: `close ${token} hedge: no exposure left` });
    }
  for (const [token, target] of Object.entries(hedgeTargets)) {
    const cur = ctx.hedges[token] ?? hedgedNow[token] ?? 0;
    const tol = Math.max(50, 0.1 * target);
    if (Math.abs(target - cur) > tol)
      out.push({ type: "hedge", token, targetShortUsd: target, reason: `hedge ${token}: ${Math.round(cur)} -> ${Math.round(target)} USD` });
  }
  return out;
}
