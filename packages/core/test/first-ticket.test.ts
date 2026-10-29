/** Fixed entry/exit costs (Ethereum gas) must not stop a position that clears the bar at a sensible size. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planAllocation } from "../src/allocator.js";
import { explainSelection } from "../src/selection.js";
import { supplyOpportunity } from "../src/sources/supply.js";
import { cfgWith, dctx, sctx } from "./helpers.js";

describe("allocator: first ticket with fixed costs", () => {
  const cfg = cfgWith({
    baseline_apr: 0.045,
    gas_usd: { ethereum: 2 }, // $4 entry (2 txs) + $2 exit
    venues: { fluid: { enabled: true, tier: 1 } },
    thresholds: { kind_premium_adjust: { deposit: { entry: { 1: -0.02 }, exit: { 1: 0 } } } }, // tier-1 deposit bar 5.5%
    caps: { max_position_usd: 120_000, per_opportunity_frac: 0.4 },
  });
  const o = supplyOpportunity(
    {
      protocol: "fluid",
      chain: "ethereum",
      marketId: "fUSDC",
      asset: { symbol: "USDC", priceUsd: 1 },
      totalSupplyUsd: 140e6,
      totalBorrowUsd: 125e6,
      supplyAprBase: 0.0587,
      rewards: [],
    },
    sctx(cfg),
    "s"
  )!;

  it("a chunk-sized start fails the bar, a bigger first ticket clears it and is taken", () => {
    const ctx = dctx({ cfg, equity: 300_000 });
    const plan = planAllocation([o], ctx);
    assert.equal(plan.entries.length, 1, JSON.stringify(plan.rejected));
    assert.ok(plan.entries[0]!.deltaUsd >= 12_000, String(plan.entries[0]!.deltaUsd));
    assert.ok(plan.entries[0]!.netApr >= 0.055);
  });

  it("when no ticket clears it, the reasons are reported at the most favourable size tried", () => {
    const strict = cfgWith({ ...cfg, thresholds: { kind_premium_adjust: { deposit: { entry: { 1: 0 }, exit: { 1: 0 } } } } }); // bar 7.5%
    const ctx = dctx({ cfg: strict, equity: 300_000 });
    const plan = planAllocation([o], ctx);
    assert.equal(plan.entries.length, 0);
    assert.ok((plan.rejectedAtUsd?.[o.id] ?? 0) > 6_000, JSON.stringify(plan.rejectedAtUsd));
    const row = explainSelection([o], ctx, plan)[0]!;
    assert.equal(row.sizeUsd, plan.rejectedAtUsd![o.id]);
    assert.match(row.reasons.join(), /net APR 5\.\d\d% < entry 7\.50%/);
  });
});
