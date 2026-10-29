import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import { bigDecimal, type ExecutionPlan } from "@aave/client";
import type { RewardRateQuery } from "@incentive-router/live-common";
import { AaveV4Adapter, SPOKE_ABI, type AaveV4AdapterOptions, type AaveV4Api } from "../src/index.js";
import { COLL_ID, DEBT_ID, FakeV4, HUB, ME, SPOKE, testCtx, usdeRef, usdtRef, USDE, USDT } from "./fake-v4-chain.js";

const E18 = 10n ** 18n;
const PAIR = "USDe/USDt";

function make(f: FakeV4, over: Partial<AaveV4AdapterOptions> = {}): AaveV4Adapter {
  return new AaveV4Adapter({
    env: f.env(),
    api: null,
    spoke: { chain: "avalanche", spokeName: "core-ethena", spoke: SPOKE, hub: HUB },
    pairs: [{ pairId: PAIR, collateral: usdeRef, debt: usdtRef }],
    swapper: f.swapper,
    now: () => f.blockTs * 1000,
    ...over,
  });
}

const decodeSpoke = (data: Hex) => decodeFunctionData({ abi: SPOKE_ABI, data }) as unknown as { functionName: string; args: readonly unknown[] };

describe("AaveV4Adapter.markets", () => {
  it("maps on-chain data to a LoopPair: risk premium in the borrow APR, market price, rewards, swap probe", async () => {
    const f = new FakeV4();
    const queries: RewardRateQuery[] = [];
    const a = make(f, {
      priceUsd: async (x) => (x.symbol === "USDe" ? 0.998 : 1.0),
      extraRewards: async (q) => {
        queries.push(q);
        return q.side === "supply" ? [{ token: "USDe", apr: 0.0575, maxHealthFactor: 2 }] : [];
      },
    });
    assert.equal(a.id, "aave-v4:avalanche:core-ethena");
    const [p] = await a.markets();
    assert.ok(p);
    assert.equal(p.protocol, "aave-v4");
    assert.equal(p.pairId, PAIR);
    assert.equal(p.maxLtv, 0.93);
    assert.equal(p.liqLtv, 0.93);
    assert.ok(Math.abs(p.debt.borrowAprBase - 0.04 * 1.25) < 1e-12, `borrow apr ${p.debt.borrowAprBase}`);
    assert.equal(p.collateral.priceUsd, 0.998);
    assert.equal(p.debt.priceUsd, 1);
    assert.deepEqual(p.collateral.supplyRewards, [{ token: "USDe", apr: 0.0575, maxHealthFactor: 2 }]);
    assert.equal(queries[0]!.marketId, `${SPOKE}:${COLL_ID}`);
    assert.equal(queries[0]!.protocol, "aave-v4");
    assert.ok(Math.abs(p.swapCostFrac - 0.0005) < 1e-12);
    assert.equal(p.swapDepthUsd, 1_000_000);
    assert.equal(p.dataAsOfMs, f.blockTs * 1000);
    assert.equal(p.myLtv, undefined);
    assert.equal(p.paused, false);
    assert.ok(p.debt.irm && Math.abs(p.debt.irm.points[1]![1] - 0.05 * 1.25) < 1e-12);
  });

  it("answers 'is USDt borrowable against USDe on this spoke' from on-chain data", async () => {
    const f = new FakeV4();
    f.debtBorrowable = false;
    const a = make(f);
    const st = await a.pairStatus(PAIR);
    assert.equal(st.canOpen, false);
    assert.ok(st.reasons.some((r) => r.includes("USDt is not borrowable on this spoke")), st.reasons.join("; "));
    const [p] = await a.markets();
    assert.equal(p!.debt.borrowCapRemainingUsd, 0);
    assert.equal(p!.paused, false);
    const r = await a.open(PAIR, 1000n * E18, 0.75, testCtx(true));
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /not borrowable/);
  });

  it("uses AaveKit Merkl rewards only when no extraRewards provider is injected", async () => {
    const f = new FakeV4();
    const reserve = (onChainId: string, rewards: unknown[]) => ({
      id: `r${onChainId}`,
      onChainId,
      settings: { collateralFactor: { value: bigDecimal("0.93") }, borrowable: onChainId === "2" },
      summary: { rewards },
    });
    const api = {
      reserves: async () => [
        reserve("1", [{ __typename: "MerklSupplyReward", id: "m1", endDate: new Date(f.blockTs * 1000 + 86_400_000), extraApy: { value: bigDecimal("0.05") }, payoutToken: { info: { symbol: "USDe" } }, criteria: [{ text: "HF <= 2" }] }]),
        reserve("2", []),
      ],
    } as unknown as AaveV4Api;
    const [p1] = await make(f, { api }).markets();
    assert.equal(p1!.collateral.supplyRewards.length, 1);
    assert.equal(p1!.collateral.supplyRewards[0]!.maxHealthFactor, 2);
    const [p2] = await make(f, { api, extraRewards: async () => [] }).markets();
    assert.equal(p2!.collateral.supplyRewards.length, 0, "auto mode must not double count Merkl campaigns");
  });
});

describe("AaveV4Adapter.open", () => {
  it("dry-run: proves approve + multicall(supply, enable collateral, borrow) with eth_simulateV1, no state change", async () => {
    const f = new FakeV4();
    const a = make(f);
    const before = JSON.stringify(f.state, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    let simulated: { to: string; data: Hex }[] = [];
    const orig = f.publicClient.simulateCalls;
    f.publicClient.simulateCalls = async (p) => {
      simulated = p.calls;
      return orig(p);
    };
    const r = await a.open(PAIR, 10_000n * E18, 0.75, testCtx(true));
    assert.equal(r.ok, true, r.detail);
    assert.equal(f.sent.length, 0);
    assert.equal(JSON.stringify(f.state, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), before);
    assert.equal(simulated.length, 2);
    const ap = decodeFunctionData({ abi: erc20Abi, data: simulated[0]!.data });
    assert.equal(ap.functionName, "approve");
    assert.deepEqual(ap.args, [SPOKE, 10_000n * E18]);
    const mc = decodeSpoke(simulated[1]!.data);
    assert.equal(mc.functionName, "multicall");
    const inner = (mc.args[0] as Hex[]).map(decodeSpoke);
    assert.deepEqual(inner.map((x) => x.functionName), ["supply", "setUsingAsCollateral", "borrow"]);
    for (const x of inner) assert.equal(getAddress(String(x.args[2])), ME);
    assert.equal(inner[2]!.args[0], DEBT_ID);
    assert.equal(inner[2]!.args[1], 7_499_999_992n); // 75% of $10k minus the 1e-9 relative haircut, floored
    assert.ok(r.txs.every((t) => t.simulated));
    assert.match(r.detail ?? "", /plan: \d+ borrow/);
  });

  it("dry-run fails closed when the RPC cannot simulate a dependent batch", async () => {
    const f = new FakeV4();
    f.simulateCallsSupported = false;
    const r = await make(f).open(PAIR, 10_000n * E18, 0.75, testCtx(true));
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /cannot be proven/);
  });

  it("refuses a target above 0.95 x collateral factor without sending anything", async () => {
    const f = new FakeV4();
    const r = await make(f).open(PAIR, 10_000n * E18, 0.9, testCtx(false));
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /exceeds 0.95/);
    assert.equal(f.sent.length, 0);
  });

  it("refuses when the HF at target is above a reward's maxHealthFactor (opt-in)", async () => {
    const f = new FakeV4();
    const a = make(f, { enforceRewardMaxHealthFactor: true, extraRewards: async (q) => (q.side === "supply" ? [{ token: "USDe", apr: 0.05, maxHealthFactor: 2 }] : []) });
    const r = await a.open(PAIR, 10_000n * E18, 0.4, testCtx(true)); // HF 0.93/0.4 = 2.3 > 2
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /maxHealthFactor/);
    assert.equal((await a.open(PAIR, 10_000n * E18, 0.75, testCtx(true))).ok, true);
  });

  it("live: loops to (never above) the target LTV with exact approvals only", async () => {
    const f = new FakeV4();
    const a = make(f);
    const r = await a.open(PAIR, 10_000n * E18, 0.75, testCtx(false));
    assert.equal(r.ok, true, r.detail);
    assert.ok(f.maxLtvSeen <= 0.75 + 1e-12, `max LTV seen ${f.maxLtvSeen}`);
    assert.ok(f.ltv() > 0.74 && f.ltv() <= 0.75, `final LTV ${f.ltv()}`);
    assert.equal(f.state.allowance[USDE.toLowerCase()], 0n, "approvals must be consumed exactly");
    for (const t of f.sent) {
      if (t.to === USDE || t.to === USDT) {
        const d = decodeFunctionData({ abi: erc20Abi, data: t.data });
        assert.equal(d.functionName, "approve");
        assert.ok((d.args[1] as bigint) < 1n << 128n);
      } else assert.equal(t.to, SPOKE);
    }
    const pos = await a.position(PAIR);
    assert.ok(pos);
    assert.ok(Math.abs(pos.ltv - f.ltv()) < 1e-9);
    assert.ok(Math.abs(pos.healthFactor! - 0.93 / f.ltv()) < 1e-6);
    assert.ok(pos.equityUsd > 9_980 && pos.equityUsd < 10_000, `equity ${pos.equityUsd}`);
    assert.equal(pos.asOfMs, f.blockTs * 1000);
    const [p] = await a.markets();
    assert.ok(Math.abs(p!.myLtv! - f.ltv()) < 1e-9);
  });

  it("live: a failed swap repays the dangling borrow and stops at a safe LTV", async () => {
    const f = new FakeV4();
    f.swapFails = true;
    const r = await make(f).open(PAIR, 10_000n * E18, 0.75, testCtx(false));
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /repaid/);
    assert.equal(f.state.debt, 0n);
    assert.equal(f.state.supplied, 10_000n * E18);
  });

  it("live: an unconfirmed step-1 broadcast stops the loop without guessing", async () => {
    const f = new FakeV4();
    f.unconfirmed = { at: 1, mode: "landed" }; // approve OK, multicall(supply, collateral, borrow) lands without receipt
    const r = await make(f).open(PAIR, 10_000n * E18, 0.75, testCtx(false));
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /unconfirmed/);
    assert.equal(f.submitted, 2);
    assert.ok(f.state.debt > 0n && f.ltv() <= 0.75, "it landed; reported, not undone");
    assert.match(r.detail ?? "", /observed: supplied 10000 USDe/);
  });

  it("apiCrossCheck: refuses when AaveKit's plan for the same action decodes differently", async () => {
    const f = new FakeV4();
    const evil = getAddress("0x6666666666666666666666666666666666666666");
    const api = {
      reserves: async () => [
        { id: "r1", onChainId: "1", settings: { collateralFactor: { value: bigDecimal("0.93") }, borrowable: false }, summary: { rewards: [] } },
        { id: "r2", onChainId: "2", settings: { collateralFactor: { value: bigDecimal("0") }, borrowable: true }, summary: { rewards: [] } },
      ],
      supply: async () =>
        ({
          __typename: "TransactionRequest",
          to: SPOKE,
          from: ME,
          chainId: 43114,
          value: 0n,
          operations: null,
          data: encodeFunctionData({ abi: SPOKE_ABI, functionName: "supply", args: [COLL_ID, 10_000n * E18, evil] }),
        }) as unknown as ExecutionPlan,
    } as unknown as AaveV4Api;
    const r = await make(f, { api, apiCrossCheck: true }).open(PAIR, 10_000n * E18, 0.75, testCtx(true));
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /AaveKit cross-check.*onBehalfOf/);
  });
});

describe("AaveV4Adapter close / deleverage", () => {
  async function opened(): Promise<{ f: FakeV4; a: AaveV4Adapter }> {
    const f = new FakeV4();
    const a = make(f);
    const r = await a.open(PAIR, 10_000n * E18, 0.75, testCtx(false));
    assert.equal(r.ok, true, r.detail);
    f.maxLtvSeen = 0;
    return { f, a };
  }

  it("simulateClose is true and does not touch state", async () => {
    const { f, a } = await opened();
    const n = f.sent.length;
    assert.equal(await a.simulateClose(PAIR, testCtx(false)), true);
    assert.equal(f.sent.length, n);
  });

  it("close(1): repays everything, withdraws all, HF never below the unwind floor", async () => {
    const { f, a } = await opened();
    const d0 = f.state.debt;
    const n0 = f.sent.length;
    const r = await a.close(PAIR, 1, testCtx(false));
    assert.equal(r.ok, true, r.detail);
    assert.equal(f.state.debt, 0n);
    assert.equal(f.state.supplied, 0n);
    assert.ok(f.minHfAfterWithdraw >= 1.04 - 1e-6, `min HF ${f.minHfAfterWithdraw}`);
    const usde = Number(f.state.wallet[USDE.toLowerCase()]!) / 1e18;
    assert.ok(usde > 9_950 && usde < 10_000, `returned ${usde}`);
    assert.ok(r.amountUsd! > 9_950);
    assert.equal(await a.position(PAIR), null);
    // the 1bp accrual margin left on the final repay is reset: no allowance survives the unwind
    assert.equal(f.state.allowance[USDT.toLowerCase()], 0n);
    assert.equal(f.state.allowance[USDE.toLowerCase()], 0n);
    const lastTx = f.sent[f.sent.length - 1]!;
    assert.equal(lastTx.to, USDT);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: lastTx.data }).args, [SPOKE, 0n]);
    // every repay approval is capped at the outstanding debt + 1bp margin
    let debt = d0;
    for (let i = n0; i < f.sent.length; i++) {
      const t = f.sent[i]!;
      if (t.to === USDT) {
        const amt = decodeFunctionData({ abi: erc20Abi, data: t.data }).args[1] as bigint;
        assert.ok(amt <= debt + debt / 10_000n + 1n, `approve ${amt} > debt ${debt} + margin`);
      } else if (t.to === SPOKE) {
        const d = decodeSpoke(t.data);
        const calls = d.functionName === "multicall" ? (d.args[0] as Hex[]).map(decodeSpoke) : [d];
        for (const c of calls) if (c.functionName === "repay") debt -= (c.args[1] as bigint) < debt ? (c.args[1] as bigint) : debt;
      }
    }
    assert.equal(debt, 0n);
    // last spoke tx: multicall(repay, withdraw max)
    const spokeTxs = f.sent.filter((t) => t.to === SPOKE);
    const last = decodeSpoke(spokeTxs[spokeTxs.length - 1]!.data);
    assert.equal(last.functionName, "multicall");
    const inner = (last.args[0] as Hex[]).map(decodeSpoke);
    assert.deepEqual(inner.map((x) => x.functionName), ["repay", "withdraw"]);
    assert.equal(inner[1]!.args[1], (1n << 256n) - 1n);
  });

  it("close(0.5) halves the position at about the same LTV", async () => {
    const { f, a } = await opened();
    const d0 = f.state.debt;
    const c0 = f.state.supplied;
    const r = await a.close(PAIR, 0.5, testCtx(false));
    assert.equal(r.ok, true, r.detail);
    assert.ok(f.state.debt <= d0 / 2n);
    assert.ok(f.state.supplied <= c0 / 2n + E18);
    assert.ok(f.ltv() <= 0.75 + 1e-9);
  });

  it("deleverage to 0.5", async () => {
    const { f, a } = await opened();
    const r = await a.deleverage(PAIR, 0.5, testCtx(false));
    assert.equal(r.ok, true, r.detail);
    assert.ok(f.ltv() <= 0.5 + 1e-6 && f.ltv() > 0.45, `ltv ${f.ltv()}`);
    const noop = await a.deleverage(PAIR, 0.6, testCtx(false));
    assert.equal(noop.ok, true);
    assert.match(noop.detail ?? "", /nothing to do/);
  });

  it("a failed exit swap re-supplies the withdrawn collateral", async () => {
    const { f, a } = await opened();
    const c0 = f.state.supplied;
    const d0 = f.state.debt;
    f.swapFails = true;
    const r = await a.close(PAIR, 1, testCtx(false));
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /re-supplied/);
    assert.equal(f.state.supplied, c0);
    assert.equal(f.state.debt, d0);
  });

  it("unconfirmed broadcast mid-unwind: re-reads state, sends nothing more, reports the hash", async () => {
    for (const mode of ["landed", "dropped"] as const) {
      const { f, a } = await opened();
      f.unconfirmed = { at: f.submitted + 1, mode }; // 2nd submission of the close (the first repay group)
      const r = await a.close(PAIR, 1, testCtx(false));
      assert.equal(r.ok, false, mode);
      assert.match(r.detail ?? "", /unconfirmed and may still land: no further txs sent/);
      assert.match(r.detail ?? "", /observed: supplied/);
      assert.equal(f.submitted, f.unconfirmed.at + 1, `${mode}: nothing submitted after the unconfirmed tx`);
      const u = r.txs.find((t) => t.unconfirmed);
      assert.ok(u?.id && u.nonce !== undefined, mode);
      assert.ok(f.hf() >= 1.0, mode);
    }
  });

  it("exit is refused (not attempted) when the reserve is paused", async () => {
    const { f, a } = await opened();
    f.collPaused = true;
    const r = await a.close(PAIR, 1, testCtx(true));
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /paused/);
  });
});

describe("AaveV4Adapter.verifyConfig / claimRewards", () => {
  it("passes on a consistent deployment", async () => {
    const f = new FakeV4();
    assert.deepEqual(await make(f).verifyConfig(), []);
  });

  it("reports ABI drift, decimals mismatch and an unborrowable debt reserve", async () => {
    const f = new FakeV4();
    f.implSelectors = ["supply", "withdraw", "borrow", "repay"]; // no setUsingAsCollateral / multicall
    f.debtBorrowable = false;
    const a = make(f, { pairs: [{ pairId: PAIR, collateral: usdeRef, debt: { ...usdtRef, decimals: 18 } }] });
    const issues = await a.verifyConfig();
    assert.ok(issues.some((i) => i.includes("lacks selectors for setUsingAsCollateral, multicall")), issues.join("\n"));
    assert.ok(issues.some((i) => i.includes("decimals")), issues.join("\n"));
    const b = make(f);
    assert.ok((await b.verifyConfig()).some((i) => i.includes("not borrowable")));
  });

  it("leaves Merkl rewards to the Merkl claimer and refuses undecodable claim targets", async () => {
    const f = new FakeV4();
    const claimable = (typename: string) => ({
      __typename: typename,
      id: "x",
      claimable: { token: { info: { symbol: "AAVE" } }, amount: { onChainValue: 5n, decimals: 18 }, exchange: { value: bigDecimal("1") } },
    });
    const merklOnly = { userClaimableRewards: async () => [claimable("UserMerklClaimableReward")] } as unknown as AaveV4Api;
    const r1 = await make(f, { api: merklOnly }).claimRewards(testCtx(false));
    assert.equal(r1.ok, true);
    assert.deepEqual(r1.claimed, []);
    assert.equal(r1.txs.length, 0);
    const target = getAddress("0x7777777777777777777777777777777777777777");
    const other = {
      userClaimableRewards: async () => [claimable("SomeNativeReward")],
      claimRewards: async () => ({ __typename: "TransactionRequest", to: target, from: ME, data: "0x12345678", value: 0n, chainId: 43114, operations: null }),
    } as unknown as AaveV4Api;
    const r2 = await make(f, { api: other }).claimRewards(testCtx(true));
    assert.equal(r2.ok, false);
    assert.match(r2.detail ?? "", /allowUndecoded/);
  });
});
