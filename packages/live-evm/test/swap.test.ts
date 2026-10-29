import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, type Chain, type Hex, type PublicClient } from "viem";
import type { AssetRef, LiveContext } from "@incentive-router/live-common";
import { Mutex, type Address, type EvmEnv } from "@incentive-router/live-evm-base";
import {
  AggregatorSwapAdapter,
  KYBER_META_ROUTER_V2_ABI,
  KYBERSWAP_META_ROUTER_V2,
  ODOS_ROUTER_V2,
  ODOS_ROUTER_V2_ABI,
  oracleCostBps,
  slippageBpsFor,
  type HttpFetch,
} from "../src/swap/index.js";

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const ME = addr(0x1111);
const EVIL = addr(0xbad);
const EXECUTOR = addr(0xe1);
const USDC: AssetRef = { chain: "arbitrum", symbol: "USDC", address: addr(0xa1), decimals: 6 };
const USDT: AssetRef = { chain: "arbitrum", symbol: "USDT", address: addr(0xa2), decimals: 6 };
const AMOUNT_IN = 1_000_000_000n; // 1000 USDC
const QUOTE_OUT = 998_000_000n; // 998 USDT -> 20 bps vs a 1:1 oracle

interface Sent {
  to: Address;
  data: Hex;
  value?: bigint;
}

function mockEnv(opts: { allowance?: bigint; revertTo?: Address } = {}) {
  const sent: Sent[] = [];
  const publicClient = {
    async call(a: Sent) {
      if (opts.revertTo && a.to.toLowerCase() === opts.revertTo.toLowerCase()) throw new Error("execution reverted: TRANSFER_FROM_FAILED");
      sent.push(a);
      return { data: "0x" };
    },
    async estimateGas() {
      return 300_000n;
    },
    async getGasPrice() {
      return 10_000_000n; // 0.01 gwei
    },
    async readContract(a: { functionName: string }) {
      if (a.functionName === "allowance") return opts.allowance ?? 0n;
      if (a.functionName === "balanceOf") return 0n;
      throw new Error(`unexpected read ${a.functionName}`);
    },
    async getCode() {
      return "0x6080";
    },
    async getChainId() {
      return 42161;
    },
  };
  const env: EvmEnv = { chain: "arbitrum", viemChain: { id: 42161 } as Chain, publicClient: publicClient as unknown as PublicClient, account: ME, lock: new Mutex() };
  return { env, sent };
}

const prices: Record<string, number> = { USDC: 1, USDT: 1 };
const mkCtx = (over: Partial<LiveContext> = {}): LiveContext => ({
  dryRun: true,
  log: () => {},
  limits: { maxGasUsd: { default: 5 }, maxSlippageBps: 50, maxLoopIterations: 5 },
  priceUsd: async (a) => prices[a.symbol]!,
  nativePriceUsd: async () => 3000,
  ...over,
});

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

function kyberCalldata(p: { recipient: Address; minOut: bigint; amountIn?: bigint; src?: Address; dst?: Address; fee?: bigint }): Hex {
  const amountIn = p.amountIn ?? AMOUNT_IN;
  return encodeFunctionData({
    abi: KYBER_META_ROUTER_V2_ABI,
    functionName: "swap",
    args: [
      {
        callTarget: EXECUTOR,
        approveTarget: EXECUTOR,
        targetData: "0x1234",
        desc: {
          srcToken: p.src ?? (USDC.address as Address),
          dstToken: p.dst ?? (USDT.address as Address),
          srcReceivers: [EXECUTOR],
          srcAmounts: [amountIn],
          feeReceivers: p.fee ? [EVIL] : [],
          feeAmounts: p.fee ? [p.fee] : [],
          dstReceiver: p.recipient,
          amount: amountIn,
          minReturnAmount: p.minOut,
          flags: 0n,
          permit: "0x",
        },
        clientData: "0x",
      },
    ],
  });
}

/** Simulated KyberSwap API. `calldata` gets the parsed build body (slippageTolerance etc). */
function kyberApi(o: { routerAtQuote?: Address; routerAtBuild?: Address; out?: bigint; calldata?: (body: { slippageTolerance: number; recipient: string }) => Hex; fail?: boolean } = {}) {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  const out = o.out ?? QUOTE_OUT;
  const f: HttpFetch = async (url, init) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, body });
    if (o.fail) return json({ message: "boom" }, 500);
    if (url.includes("/arbitrum/api/v1/routes")) {
      return json({
        code: 0,
        message: "successfully",
        data: {
          routerAddress: o.routerAtQuote ?? KYBERSWAP_META_ROUTER_V2,
          routeSummary: {
            tokenIn: USDC.address.toLowerCase(),
            tokenOut: USDT.address.toLowerCase(),
            amountIn: AMOUNT_IN.toString(),
            amountOut: out.toString(),
            // deliberately optimistic API USD numbers: costBps must NOT use them
            amountInUsd: "1000",
            amountOutUsd: "1000",
            gas: "300000",
            gasUsd: "0.05",
            route: [[{ pool: addr(0x9001), exchange: "uniswap-v3", tokenIn: USDC.address, tokenOut: USDT.address }]],
            routeID: "r-1",
            checksum: "1",
            timestamp: 1,
          },
        },
      });
    }
    if (url.includes("/arbitrum/api/v1/route/build")) {
      const b = body as { slippageTolerance: number; recipient: string };
      const minOut = (out * BigInt(10_000 - b.slippageTolerance)) / 10_000n;
      return json({
        code: 0,
        data: {
          routerAddress: o.routerAtBuild ?? o.routerAtQuote ?? KYBERSWAP_META_ROUTER_V2,
          data: o.calldata ? o.calldata(b) : kyberCalldata({ recipient: b.recipient as Address, minOut }),
          amountIn: AMOUNT_IN.toString(),
          amountOut: out.toString(),
          transactionValue: "0",
          gas: "300000",
          gasUsd: "0.05",
        },
      });
    }
    return json({}, 404);
  };
  return { f, calls };
}

const kyberOnly = (env: EvmEnv, f: HttpFetch, maxCostBps = 40) => new AggregatorSwapAdapter(env, { chain: "arbitrum", aggregators: ["kyberswap"], maxCostBps }, f);

describe("oracle cost", () => {
  it("measures cost vs ctx.priceUsd, not the API's USD numbers", async () => {
    assert.ok(Math.abs(oracleCostBps(AMOUNT_IN, 6, 1, QUOTE_OUT, 6, 1) - 20) < 1e-9);
    assert.ok(Math.abs(oracleCostBps(AMOUNT_IN, 6, 1, QUOTE_OUT, 6, 0.999) - 29.98) < 0.01);
    const { env } = mockEnv();
    const q = await kyberOnly(env, kyberApi().f).quote(USDC, USDT, AMOUNT_IN, mkCtx());
    assert.ok(Math.abs(q.costBps - 20) < 1e-9, `costBps ${q.costBps}`); // API said 0 bps
    assert.equal(q.amountOut, QUOTE_OUT);
    assert.match(q.route, /^kyberswap:uniswap-v3/);
  });
  it("rejects quotes above maxCostBps", async () => {
    const { env } = mockEnv();
    await assert.rejects(kyberOnly(env, kyberApi().f, 10).quote(USDC, USDT, AMOUNT_IN, mkCtx()), /cost 20\.0 bps > max 10/);
  });
});

describe("router allowlist", () => {
  it("rejects a quote naming a router outside the allowlist", async () => {
    const { env } = mockEnv();
    await assert.rejects(kyberOnly(env, kyberApi({ routerAtQuote: EVIL }).f).quote(USDC, USDT, AMOUNT_IN, mkCtx()), /not in the kyberswap allowlist/);
  });
  it("rejects built calldata targeting a non-allowlisted router, before any approval", async () => {
    const { env, sent } = mockEnv();
    const a = kyberOnly(env, kyberApi({ routerAtBuild: EVIL }).f);
    const q = await a.quote(USDC, USDT, AMOUNT_IN, mkCtx());
    const r = await a.swap(q, USDC, USDT, mkCtx());
    assert.equal(r.ok, false);
    assert.match(r.detail!, /not an allowlisted kyberswap router/);
    assert.equal(sent.length, 0, "nothing simulated / approved");
  });
  it("uses the official router constants by default", () => {
    const { env } = mockEnv();
    const a = new AggregatorSwapAdapter(env, { chain: "arbitrum", maxCostBps: 50 }, kyberApi().f);
    assert.deepEqual(a.routers().kyberswap, [KYBERSWAP_META_ROUTER_V2.toLowerCase()]);
    assert.deepEqual(a.routers().odos, [ODOS_ROUTER_V2.arbitrum!.toLowerCase()]);
  });
});

describe("recipient", () => {
  it("rejects calldata whose dstReceiver is not our account", async () => {
    const { env, sent } = mockEnv();
    const api = kyberApi({ calldata: (b) => kyberCalldata({ recipient: EVIL, minOut: (QUOTE_OUT * BigInt(10_000 - b.slippageTolerance)) / 10_000n }) });
    const a = kyberOnly(env, api.f);
    const r = await a.swap(await a.quote(USDC, USDT, AMOUNT_IN, mkCtx()), USDC, USDT, mkCtx());
    assert.equal(r.ok, false);
    assert.match(r.detail!, /recipient .* is not our account/);
    assert.equal(sent.length, 0);
    // we asked for ourselves as recipient
    assert.equal(api.calls.find((c) => c.url.includes("route/build"))!.body!.recipient, ME);
  });
  it("rejects calldata carrying fees", async () => {
    const { env } = mockEnv();
    const a = kyberOnly(env, kyberApi({ calldata: (b) => kyberCalldata({ recipient: b.recipient as Address, minOut: QUOTE_OUT, fee: 1n }) }).f);
    const r = await a.swap(await a.quote(USDC, USDT, AMOUNT_IN, mkCtx()), USDC, USDT, mkCtx());
    assert.equal(r.ok, false);
    assert.match(r.detail!, /fees/);
  });
});

describe("min-out", () => {
  it("min-out = quote * (1 - maxSlippageBps), passed to the API; exact approval; simulated swap", async () => {
    const minOut = (QUOTE_OUT * 9950n) / 10_000n;
    assert.equal(minOut, 993_010_000n);
    assert.equal(slippageBpsFor(QUOTE_OUT, minOut), 50);
    const { env, sent } = mockEnv();
    const api = kyberApi();
    const a = kyberOnly(env, api.f);
    const q = await a.quote(USDC, USDT, AMOUNT_IN, mkCtx());
    const r = await a.swap(q, USDC, USDT, mkCtx());
    assert.equal(r.ok, true, r.detail);
    assert.equal(api.calls.find((c) => c.url.includes("route/build"))!.body!.slippageTolerance, 50);
    // 1) approve exactly amountIn to the verified router, 2) swap to the router
    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.to, USDC.address);
    const ap = decodeFunctionData({ abi: erc20Abi, data: sent[0]!.data });
    assert.equal(ap.functionName, "approve");
    assert.deepEqual(ap.args, [KYBERSWAP_META_ROUTER_V2, AMOUNT_IN]);
    assert.equal(sent[1]!.to, KYBERSWAP_META_ROUTER_V2);
    const sw = decodeFunctionData({ abi: KYBER_META_ROUTER_V2_ABI, data: sent[1]!.data });
    assert.equal(sw.functionName, "swap");
    const desc = (sw.args[0] as { desc: { minReturnAmount: bigint; dstReceiver: string } }).desc;
    assert.equal(desc.minReturnAmount, minOut);
    assert.equal(desc.dstReceiver, ME);
    assert.equal(r.txs.every((t) => t.simulated), true);
  });
  it("rejects calldata 1 wei below min-out", async () => {
    const { env, sent } = mockEnv();
    const a = kyberOnly(env, kyberApi({ calldata: (b) => kyberCalldata({ recipient: b.recipient as Address, minOut: 993_009_999n }) }).f);
    const r = await a.swap(await a.quote(USDC, USDT, AMOUNT_IN, mkCtx()), USDC, USDT, mkCtx());
    assert.equal(r.ok, false);
    assert.match(r.detail!, /min-out/);
    assert.equal(sent.length, 0);
  });
  it("skips the approval when allowance already covers amountIn", async () => {
    const { env, sent } = mockEnv({ allowance: AMOUNT_IN });
    const a = kyberOnly(env, kyberApi().f);
    const r = await a.swap(await a.quote(USDC, USDT, AMOUNT_IN, mkCtx()), USDC, USDT, mkCtx());
    assert.equal(r.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, KYBERSWAP_META_ROUTER_V2);
  });
  it("dry-run with a pending approval reports calldata verified but swap not simulatable", async () => {
    const { env } = mockEnv({ revertTo: KYBERSWAP_META_ROUTER_V2 });
    const a = kyberOnly(env, kyberApi().f);
    const r = await a.swap(await a.quote(USDC, USDT, AMOUNT_IN, mkCtx()), USDC, USDT, mkCtx());
    assert.equal(r.ok, true);
    assert.match(r.detail!, /approval mined first/);
    assert.equal(r.txs.length, 1); // only the approval
  });
  it("refuses a tampered SwapQuote", async () => {
    const { env } = mockEnv();
    const a = kyberOnly(env, kyberApi().f);
    const q = await a.quote(USDC, USDT, AMOUNT_IN, mkCtx());
    const r = await a.swap({ ...q, amountOut: 1n }, USDC, USDT, mkCtx());
    assert.equal(r.ok, false);
    assert.match(r.detail!, /amounts differ/);
  });
});

describe("odos fallback", () => {
  const ROUTER = ODOS_ROUTER_V2.arbitrum!;
  function odosCalldata(recipient: Address, outputMin: bigint, outputQuote = QUOTE_OUT): Hex {
    return encodeFunctionData({
      abi: ODOS_ROUTER_V2_ABI,
      functionName: "swap",
      args: [
        { inputToken: USDC.address as Address, inputAmount: AMOUNT_IN, inputReceiver: EXECUTOR, outputToken: USDT.address as Address, outputQuote, outputMin, outputReceiver: recipient },
        "0xabcd",
        EXECUTOR,
        0,
      ],
    });
  }
  function api(recipient: Address) {
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    const f: HttpFetch = async (url, init) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push({ url, body });
      if (url.includes("kyberswap")) return json({ message: "rate limited" }, 429);
      if (url.endsWith("/sor/quote/v3"))
        return json({ pathId: "p-1", inTokens: [USDC.address], outTokens: [USDT.address], inAmounts: [AMOUNT_IN.toString()], outAmounts: [QUOTE_OUT.toString()], gasEstimateValue: 0.04 });
      if (url.endsWith("/sor/assemble")) {
        const slipPct = calls.find((c) => c.url.endsWith("/sor/quote/v3"))!.body!.slippageLimitPercent as number;
        const outputMin = (QUOTE_OUT * BigInt(Math.round(10_000 - slipPct * 100))) / 10_000n;
        return json({ transaction: { to: ROUTER, from: ME, data: odosCalldata(recipient, outputMin), value: "0", chainId: 42161 }, outputTokens: [{ tokenAddress: USDT.address, amount: QUOTE_OUT.toString() }] });
      }
      return json({}, 404);
    };
    return { f, calls };
  }
  it("falls back to Odos, decodes swap(), checks receiver + outputMin", async () => {
    const { env, sent } = mockEnv();
    const o = api(ME);
    const a = new AggregatorSwapAdapter(env, { chain: "arbitrum", maxCostBps: 40 }, o.f);
    const q = await a.quote(USDC, USDT, AMOUNT_IN, mkCtx());
    assert.match(q.route, /^odos:/);
    // 1 bp headroom below maxSlippageBps so Odos rounding can never undercut our min-out
    assert.equal(o.calls.find((c) => c.url.endsWith("/sor/quote/v3"))!.body!.slippageLimitPercent, 0.49);
    assert.equal(o.calls.find((c) => c.url.endsWith("/sor/quote/v3"))!.body!.compact, false);
    const r = await a.swap(q, USDC, USDT, mkCtx());
    assert.equal(r.ok, true, r.detail);
    assert.equal(sent[1]!.to, ROUTER);
    const ap = decodeFunctionData({ abi: erc20Abi, data: sent[0]!.data });
    assert.deepEqual(ap.args, [ROUTER, AMOUNT_IN]);
  });
  it("rejects Odos calldata paying someone else", async () => {
    const { env, sent } = mockEnv();
    const a = new AggregatorSwapAdapter(env, { chain: "arbitrum", maxCostBps: 40 }, api(EVIL).f);
    const r = await a.swap(await a.quote(USDC, USDT, AMOUNT_IN, mkCtx()), USDC, USDT, mkCtx());
    assert.equal(r.ok, false);
    assert.match(r.detail!, /recipient/);
    assert.equal(sent.length, 0);
  });
});
