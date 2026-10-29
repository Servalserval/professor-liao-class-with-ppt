/**
 * Supply-only lending (sources/supply.ts): math, reward rules, liquidity rules, unknown (NaN) inputs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkSizedEntry, entryBlockers } from "../src/gates/entry.js";
import { decideExit } from "../src/gates/exit.js";
import { newHistory, type History } from "../src/signals.js";
import { interpIrm, type IrmModel } from "../src/sources/loopLending.js";
import { supplyOpportunity, SupplySource, type SupplyMarket } from "../src/sources/supply.js";
import { stableRisk } from "../src/stables.js";
import type { Action, Opportunity } from "../src/types.js";
import { validateOpportunity } from "../src/validate.js";
import { cfgWith, close, dctx, NOW, position, sctx } from "./helpers.js";

const MIN = 60_000;
const IRM: IrmModel = { points: [[0, 0.0], [0.8, 0.08], [1, 0.5]], reserveFactor: 0.1 };
const exits = (a: Action[]) => a.filter((x): x is Extract<Action, { type: "exit" }> => x.type === "exit");

/** $10M USDC market, $6M lent out, 5% base, on Arbitrum (gas $0.5 default). */
const market = (over: Partial<SupplyMarket> = {}): SupplyMarket => ({
  protocol: "navi",
  chain: "sui",
  marketId: "USDC",
  asset: { symbol: "USDC", priceUsd: 1 },
  totalSupplyUsd: 10e6,
  totalBorrowUsd: 6e6,
  supplyAprBase: 0.05,
  rewards: [],
  ...over,
});
const ID = "s:navi:USDC";
const base = (o: Opportunity) => o.streams.find((s) => s.label === "supply_base")!;
const reward = (o: Opportunity, t: string) => o.streams.find((s) => s.label === `supply_reward:${t}`)!;

function hist(points: { ago: number; metrics: Record<string, number> }[]): History {
  const h = newHistory();
  h.opps[ID] = points.map((p) => ({ t: NOW - p.ago, capacityUsd: 0, rewardAprExMe: 0, metrics: p.metrics }));
  return h;
}

describe("supplyOpportunity: shape", () => {
  it("deposit kind, id, legs, funding, meta, costs incl. depeg loss, no health", () => {
    const cfg = cfgWith({ gas_usd: { sui: 0.05 } });
    const o = supplyOpportunity(market({ depositFeeFrac: 0.001, withdrawFeeFrac: 0.002 }), sctx(cfg), "s")!;
    assert.equal(o.kind, "deposit");
    assert.equal(o.id, ID);
    assert.deepEqual(o.legs, [{ venue: "navi", chain: "sui", token: "USDC", equityFrac: 1 }]);
    assert.deepEqual(o.funding, { chain: "sui", asset: "USDC" });
    assert.equal(o.meta!["marketId"], "USDC");
    assert.equal(o.meta!["supply"], true);
    assert.deepEqual(o.costs, {
      entryFrac: 0.001,
      exitFrac: 0.002,
      fixedEntryUsd: 0.05 * cfg.sources.supply.txs_per_entry,
      fixedExitUsd: 0.05 * cfg.sources.supply.txs_per_exit,
      ongoingApr: stableRisk(cfg, "USDC").lossApr,
    });
    assert.equal(cfg.sources.supply.txs_per_entry, 2);
    assert.equal(cfg.sources.supply.txs_per_exit, 1);
    assert.equal(o.health, undefined);
    assert.deepEqual(validateOpportunity(o, cfg, NOW), []);
  });

  it("supply cap remaining -> maxEquityUsd (my deposit + headroom)", () => {
    const o = supplyOpportunity(market({ supplyCapRemainingUsd: 300_000, myDepositUsd: 50_000 }), sctx(), "s")!;
    assert.equal(o.maxEquityUsd, 350_000);
  });

  it("invalid inputs -> null", () => {
    const bad: Partial<SupplyMarket>[] = [
      { totalSupplyUsd: 0 },
      { totalSupplyUsd: NaN },
      { totalBorrowUsd: -1 },
      { supplyAprBase: Infinity },
      { asset: { symbol: "USDC", priceUsd: NaN } },
      { asset: { symbol: "", priceUsd: 1 } },
      { withdrawableUsd: -5 },
      { depositFeeFrac: NaN },
      { supplyCapRemainingUsd: -1 },
      { rewards: [{ token: "X", apr: NaN }] },
      { rewards: [{ token: "X", apr: 0.01, perUserCapUsd: -1 }] },
    ];
    for (const b of bad) assert.equal(supplyOpportunity(market(b), sctx(), "s"), null, JSON.stringify(b, (_k, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v)));
  });

  it("SupplySource maps markets and drops invalid ones", async () => {
    const src = new SupplySource("s", async () => [market(), market({ marketId: "bad", totalSupplyUsd: 0 }), market({ marketId: "USDT", asset: { symbol: "USDT", priceUsd: 1 } })]);
    assert.deepEqual((await src.fetch(sctx())).map((o) => o.id), ["s:navi:USDC", "s:navi:USDT"]);
  });
});

describe("supplyOpportunity: rates", () => {
  it("no IRM: my deposit dilutes the rate, apr(E) = base x S / (S - myE + E)", () => {
    const o = supplyOpportunity(market(), sctx(), "s")!;
    assert.ok(close(base(o).aprAt(0), 0.05));
    assert.ok(close(base(o).aprAt(1e6), (0.05 * 10e6) / 11e6));
    // my current $1M is backed out: the current rate is what I already earn
    const held = supplyOpportunity(market({ myDepositUsd: 1e6 }), sctx(), "s")!;
    assert.ok(close(base(held).aprAt(1e6), 0.05));
    assert.ok(close(base(held).aprAt(2e6), (0.05 * 10e6) / 11e6));
    // the router's own position is used when the adapter does not report one
    const viaRouter = supplyOpportunity(market(), sctx(cfgWith(), { [ID]: 1e6 }), "s")!;
    assert.ok(close(base(viaRouter).aprAt(1e6), 0.05));
  });

  it("IRM: supply(u) = borrowIrm(u) x u x (1 - rf) with u(E) = B / (S - myE + E)", () => {
    const o = supplyOpportunity(market({ irm: IRM }), sctx(), "s")!;
    for (const E of [0, 1e6, 5e6]) {
      const u = 6e6 / (10e6 + E);
      assert.ok(close(base(o).aprAt(E), interpIrm(IRM, u) * u * 0.9), `E=${E}`);
    }
    assert.ok(base(o).aprAt(5e6) < base(o).aprAt(0), "depositing lowers utilization and the rate");
    const u0 = o.signals.find((s) => s.name === "utilization")!;
    assert.ok(close(u0.value, 0.6));
    assert.ok(o.projectedSignals!(4e6).find((s) => s.name === "utilization")!.value < 0.6);
  });

  it("rewards: pro rata over S, aprCap, perUserCapUsd on my deposit, borrow-only campaigns are 0, net is fine", () => {
    const o = supplyOpportunity(
      market({
        rewards: [
          { token: "A", apr: 0.04 },
          { token: "B", apr: 0.1, aprCap: 0.03 },
          { token: "C", apr: 0.06, netOf: ["*"], perUserCapUsd: 100_000 },
          { token: "D", apr: 0.05, maxHealthFactor: 2 },
          { token: "E", apr: 0.02, ineligibleIfBorrowing: ["USDC"] },
        ],
      }),
      sctx(),
      "s"
    )!;
    assert.ok(close(reward(o, "A").aprAt(1e6), (0.04 * 10e6) / 11e6));
    assert.ok(close(reward(o, "B").aprAt(0), 0.03));
    // C: full rate up to $100k of my deposit, then cap/E of it
    assert.ok(close(reward(o, "C").aprAt(50_000), (0.06 * 10e6) / (10e6 + 50_000)));
    assert.ok(close(reward(o, "C").aprAt(400_000), ((0.06 * 10e6) / (10e6 + 400_000)) * (100_000 / 400_000)));
    assert.equal(reward(o, "D").aprAt(10_000), 0, "HF-gated campaigns need a borrow");
    assert.ok(reward(o, "E").aprAt(0) > 0, "ineligibleIfBorrowing is irrelevant for a supplier");
    const notes = o.meta!["rewardNotes"] as Record<string, string[]>;
    assert.deepEqual(notes["supply_reward:C"], ["net_lending_ok", "per_user_cap_usd_100000"]);
    assert.deepEqual(notes["supply_reward:D"], ["requires_borrowing"]);
    assert.ok(notes["supply_reward:B"]!.includes("apr_capped_0.03"));
  });
});

describe("supplyOpportunity: liquidity, signals, flags", () => {
  it("exit capacity = withdrawable (default S - B); 1/10 entry and 1/5 full exit apply to it", () => {
    const o = supplyOpportunity(market({ withdrawableUsd: 2e6, supplyAprBase: 0.08 }), sctx(), "s")!;
    assert.equal(o.liquidity.exitCapacityUsd, 2e6);
    assert.equal(o.liquidity.footprintPerEquity, 1);
    assert.equal(supplyOpportunity(market(), sctx(), "s")!.liquidity.exitCapacityUsd, 4e6);
    const big = dctx({ equity: 10e6, cfg: cfgWith({ caps: { max_position_usd: 1e9, per_opportunity_frac: 1, per_venue_frac_by_tier: { 1: 1 } } }) });
    assert.equal(checkSizedEntry(o, 0, 200_000, big).ok, true);
    assert.match(checkSizedEntry(o, 0, 250_000, big).reasons.join(), /exit capacity/);
    const p = position(o, 400_000); // 20% of withdrawable
    const e = exits(decideExit(p, o, [], dctx({ positions: [p], equity: 10e6 })).actions);
    assert.equal(e.length, 1);
    assert.equal(e[0]!.urgent, true, "pool-driven liquidity exits are immediate");
  });

  it("NaN withdrawable = unknown: blind without history; with recent reads -> reused, entries blocked, no exit", () => {
    assert.equal(supplyOpportunity(market({ withdrawableUsd: NaN }), sctx(), "s"), null);
    const stale = { ...sctx(), history: hist([{ ago: 30 * MIN, metrics: { withdrawable_usd: 2e6 } }]) };
    assert.equal(supplyOpportunity(market({ withdrawableUsd: NaN }), stale, "s"), null);
    const ctx = { ...sctx(), history: hist([{ ago: 2 * MIN, metrics: { withdrawable_usd: 2e6 } }, { ago: MIN, metrics: { withdrawable_usd: 2e6 } }]) };
    const o = supplyOpportunity(market({ withdrawableUsd: NaN }), ctx, "s")!;
    assert.equal(o.liquidity.exitCapacityUsd, 2e6);
    assert.equal(o.liquidity.reusedQuote, true);
    assert.equal(o.liquidity.estimated, true);
    assert.equal(o.metrics["withdrawable_usd"], undefined);
    assert.ok(entryBlockers(o, dctx()).some((b) => b.includes("liquidity_unknown")));
    // 15% of the reused capacity: fine (it would be 30% with the estimate haircut)
    const p = position(o, 300_000);
    assert.equal(exits(decideExit(p, o, [], dctx({ positions: [p], equity: 10e6 })).actions).length, 0);
  });

  it("NaN supplyAprBase = unknown: blind without a recent rate, never valued as 0 or as an edge", () => {
    assert.equal(supplyOpportunity(market({ supplyAprBase: NaN, note: "share-price history unavailable" }), sctx(), "s"), null);
    const ctx = { ...sctx(), history: hist([{ ago: MIN, metrics: { supply_apr: 0.045 } }]) };
    const o = supplyOpportunity(market({ supplyAprBase: NaN }), ctx, "s")!;
    assert.ok(close(base(o).aprAt(0), 0.045), "last recent rate");
    assert.equal(o.metrics["supply_apr"], undefined, "not recorded as a fresh observation");
    assert.ok(o.flags.some((f) => f.name === "rate_unknown" && f.severity === "warn"));
    assert.ok(entryBlockers(o, dctx()).some((b) => b.includes("rate_unknown")));
    const p = position(o, 10_000);
    assert.equal(exits(decideExit(p, o, [], dctx({ positions: [p] })).actions).length, 0);
    // with an IRM the rate is computed, the NaN quote does not matter
    const withIrm = supplyOpportunity(market({ supplyAprBase: NaN, irm: IRM }), sctx(), "s")!;
    assert.ok(base(withIrm).aprAt(0) > 0);
    assert.ok(!withIrm.flags.some((f) => f.name === "rate_unknown"));
  });

  it("depeg signal |price - 1| with the asset's own levels; non-USD stables get none", () => {
    const cfg = cfgWith({ stables: { AUSD: { tier: 2, depeg_warn: 0.002, depeg_exit: 0.006 } } });
    const o = supplyOpportunity(market({ asset: { symbol: "AUSD", priceUsd: 0.997 } }), sctx(cfg), "s")!;
    const d = o.signals.find((s) => s.name === "depeg")!;
    assert.ok(close(d.value, 0.003));
    assert.equal(d.warnAt, 0.002);
    assert.equal(d.exitAt, 0.006);
    const usdc = supplyOpportunity(market(), sctx(cfg), "s")!.signals.find((s) => s.name === "depeg")!;
    assert.equal(usdc.warnAt, cfg.sources.lending_loop.depeg_warn);
    const eur = supplyOpportunity(market({ asset: { symbol: "EURC", priceUsd: 1.08 } }), sctx(cfg), "s")!;
    assert.equal(eur.signals.find((s) => s.name === "depeg"), undefined);
  });

  it("paused: warn flag blocks entries and top-ups but is not an exit", () => {
    const o = supplyOpportunity(market({ paused: true }), sctx(), "s")!;
    assert.deepEqual(o.flags.map((f) => [f.name, f.severity]), [["deposits_paused", "warn"]]);
    assert.ok(entryBlockers(o, dctx()).some((b) => b.includes("deposits_paused")));
    const p = position(o, 10_000);
    const acts = decideExit(p, o, [], dctx({ positions: [p] })).actions;
    assert.equal(exits(acts).length, 0);
    assert.ok(acts.some((a) => a.type === "alert" && a.message.includes("deposits_paused")));
  });

  it("health_missing applies to leveraged kinds only, never to deposits", () => {
    const cfg = cfgWith({ portfolio: { health_missing: "exit" } });
    const o = supplyOpportunity(market(), sctx(cfg), "s")!;
    const p = position(o, 10_000);
    const acts = decideExit(p, o, [], dctx({ cfg, positions: [p] })).actions;
    assert.equal(exits(acts).length, 0);
    assert.ok(!acts.some((a) => a.type === "alert" && /health/.test(a.message)));
  });
});
