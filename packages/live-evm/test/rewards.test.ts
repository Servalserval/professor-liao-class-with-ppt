import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concat, decodeFunctionData, getAddress, keccak256, zeroAddress, type Chain, type Hex, type PublicClient } from "viem";
import type { AssetRef, LiveContext, RewardRateQuery } from "@incentive-router/live-common";
import { Mutex, type Address, type EvmEnv } from "@incentive-router/live-evm-base";
import type { HttpFetch } from "../src/swap/index.js";
import {
  AAVE_REWARDS_CONTROLLER_ABI,
  AaveRewardsClaimer,
  MERKL_DISTRIBUTOR_ABI,
  MERKL_DISTRIBUTOR_DEFAULT,
  MerklClaimer,
  merklLeaf,
  merklRewardRateProvider,
  merklRootFromProof,
  parseMerklUserRewards,
  underlyingOfReceiptSymbol,
} from "../src/rewards/index.js";

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const ME = addr(0x1111);
const EVIL = addr(0xbad);
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const ctx = (over: Partial<LiveContext> = {}): LiveContext => ({
  dryRun: true,
  log: () => {},
  limits: { maxGasUsd: { default: 5 }, maxSlippageBps: 50, maxLoopIterations: 5 },
  priceUsd: async () => 1,
  nativePriceUsd: async () => 3000,
  ...over,
});

type Read = { address: Address; functionName: string; args?: readonly unknown[] };
function mockEnv(chain: string, chainId: number, read: (a: Read) => unknown) {
  const sent: { to: Address; data: Hex }[] = [];
  const publicClient = {
    async call(a: { to: Address; data: Hex }) {
      sent.push(a);
      return { data: "0x" };
    },
    estimateGas: async () => 200_000n,
    getGasPrice: async () => 10_000_000n,
    readContract: async (a: Read) => read(a),
    getCode: async () => "0x6080",
    getChainId: async () => chainId,
  };
  const env: EvmEnv = { chain, viemChain: { id: chainId } as Chain, publicClient: publicClient as unknown as PublicClient, account: ME, lock: new Mutex() };
  return { env, sent };
}

/**
 * Mock signer matching live-evm-base sendTx (prepare -> sign -> sendRawTransaction -> receipt).
 * `accept()` is called per submit; false = the submit times out and the tx is never seen.
 */
function withSigner(env: EvmEnv, accept: () => boolean) {
  let n = 0;
  env.walletClient = {
    account: { address: ME },
    prepareTransactionRequest: async (r: object) => ({ ...r, nonce: ++n }),
    signTransaction: async () => `0x${n.toString(16).padStart(8, "0")}`,
  } as unknown as EvmEnv["walletClient"];
  Object.assign(env.publicClient, {
    sendRawTransaction: async () => {
      if (!accept()) throw new Error("request timed out");
      return "0x";
    },
    getTransaction: async () => null,
    waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 100_000n, effectiveGasPrice: 10_000_000n }),
  });
}

// ---------------------------------------------------------------------------
// Merkl claims
// ---------------------------------------------------------------------------

const T1 = addr(0x7001); // 18 decimals
const T2 = addr(0x7002); // 6 decimals
const A1 = 5_000000000000000000n; // cumulative 5.0
const A2 = 3_000000n; // cumulative 3.0
const L1 = merklLeaf(ME, T1, A1);
const L2 = merklLeaf(ME, T2, A2);
const ROOT = BigInt(L1) < BigInt(L2) ? keccak256(concat([L1, L2])) : keccak256(concat([L2, L1]));

function rewardsApi(over: Record<string, unknown>[] = []) {
  const calls: string[] = [];
  const body = [
    {
      chain: { id: 42161, name: "Arbitrum" },
      rewards: [
        // API `claimed` is stale (lags after a claim) — the on-chain value must win
        { token: { address: T1, chainId: 42161, symbol: "ARB", decimals: 18 }, amount: A1.toString(), claimed: "1000", pending: "777", proofs: [L2] },
        { token: { address: T2, chainId: 42161, symbol: "USDC", decimals: 6 }, amount: A2.toString(), claimed: "0", pending: "0", proofs: [L1] },
        { token: { address: addr(0x7003), chainId: 42161, symbol: "DONE", decimals: 18 }, amount: "10", claimed: "10", pending: "5", proofs: [L1] },
        ...over,
      ],
    },
    { chain: { id: 1, name: "Ethereum" }, rewards: [{ token: { address: addr(0x7004), chainId: 1, symbol: "X", decimals: 18 }, amount: "99", claimed: "0", proofs: [] }] },
  ];
  const f: HttpFetch = async (url) => {
    calls.push(url);
    return json(body);
  };
  return { f, calls };
}

function distributorReads(opts: { root?: Hex; redirect?: Address } = {}) {
  return (a: Read): unknown => {
    if (a.functionName === "getMerkleRoot") return opts.root ?? ROOT;
    if (a.functionName === "claimed") return a.args?.[1] === T1 ? [2_000000000000000000n, 1, ROOT] : [0n, 0, ROOT];
    if (a.functionName === "claimRecipient") return a.args?.[1] === zeroAddress ? zeroAddress : opts.redirect ?? zeroAddress;
    throw new Error(`unexpected read ${a.functionName}`);
  };
}

describe("merkl rewards parsing", () => {
  it("claimable = amount - claimed, excludes pending and other chains", async () => {
    const { env } = mockEnv("arbitrum", 42161, distributorReads());
    const api = rewardsApi();
    const c = new MerklClaimer(env, { chain: "arbitrum" }, api.f);
    const cl = await c.claimable(ME);
    assert.deepEqual(
      cl.map((x) => [x.token.symbol, x.amount]),
      [
        ["ARB", A1 - 1000n],
        ["USDC", A2],
      ]
    );
    assert.equal(api.calls[0], `https://api.merkl.xyz/v4/users/${ME.toLowerCase()}/rewards/summary?chainId=42161`);
    assert.equal(c.distributor, MERKL_DISTRIBUTOR_DEFAULT);
  });
  it("drops malformed proofs / amounts", () => {
    const bad = [{ chain: { id: 10 }, rewards: [{ token: { address: T1, decimals: 18 }, amount: "1.5", claimed: "0", proofs: [] }, { token: { address: T2, decimals: 6 }, amount: "5", claimed: "0", proofs: ["0x12"] }] }];
    assert.equal(parseMerklUserRewards(bad, 10, "optimism").length, 0);
  });
});

describe("merkl claim", () => {
  it("encodes CUMULATIVE amounts with proofs (decodeFunctionData round trip)", async () => {
    assert.equal(merklRootFromProof(L1, [L2]), ROOT);
    const { env, sent } = mockEnv("arbitrum", 42161, distributorReads());
    const c = new MerklClaimer(env, { chain: "arbitrum" }, rewardsApi().f);
    const r = await c.claim(ME, ctx());
    assert.equal(r.ok, true, r.detail);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, MERKL_DISTRIBUTOR_DEFAULT);
    const d = decodeFunctionData({ abi: MERKL_DISTRIBUTOR_ABI, data: sent[0]!.data });
    assert.equal(d.functionName, "claim");
    const [users, tokens, amounts, proofs] = d.args as readonly [readonly Address[], readonly Address[], readonly bigint[], readonly (readonly Hex[])[]];
    assert.deepEqual(users, [ME, ME]);
    assert.deepEqual(tokens, [T1, T2]);
    assert.deepEqual(amounts, [A1, A2], "tree amounts, not amount - claimed");
    assert.deepEqual(proofs, [[L2], [L1]]);
    // what actually moves = cumulative - on-chain claimed (2.0 already claimed of T1)
    assert.deepEqual(
      r.claimed.map((x) => x.amount),
      [3_000000000000000000n, A2]
    );
  });
  it("skips entries whose proof does not match the active on-chain root", async () => {
    const { env, sent } = mockEnv("arbitrum", 42161, distributorReads({ root: keccak256("0x01") }));
    const r = await new MerklClaimer(env, { chain: "arbitrum" }, rewardsApi().f).claim(ME, ctx());
    assert.equal(r.ok, true);
    assert.equal(sent.length, 0);
    assert.match(r.detail!, /nothing claimable/);
  });
  it("refuses tokens whose claim recipient is redirected", async () => {
    const { env, sent } = mockEnv("arbitrum", 42161, distributorReads({ redirect: EVIL }));
    const r = await new MerklClaimer(env, { chain: "arbitrum" }, rewardsApi().f).claim(ME, ctx());
    assert.equal(sent.length, 0);
    assert.equal(r.claimed.length, 0);
  });
  it("refuses to claim for another owner and rate-limits live claims", async () => {
    const { env } = mockEnv("arbitrum", 42161, distributorReads());
    let t = 1_000_000;
    const c = new MerklClaimer(env, { chain: "arbitrum", now: () => t }, rewardsApi().f);
    assert.equal((await c.claim(EVIL, ctx())).ok, false);
    // read-only env: the live claim fails and must not start the interval timer
    const noSigner = await c.claim(ME, ctx({ dryRun: false }));
    assert.equal(noSigner.ok, false);
    assert.match(noSigner.detail!, /no signer/);
    // give the env a (mock) signer: first live claim goes through, the next one within 2 h is skipped
    let broadcasts = 0;
    withSigner(env, () => (broadcasts++, true));
    const live = await c.claim(ME, ctx({ dryRun: false }));
    assert.equal(live.ok, true, live.detail);
    assert.equal(live.txs[0]!.simulated, false);
    t += 60 * 60_000;
    const again = await c.claim(ME, ctx({ dryRun: false }));
    assert.match(again.detail!, /skipped, last claim 60 min ago/);
    assert.equal(broadcasts, 1);
    t += 60 * 60_000;
    assert.equal((await c.claim(ME, ctx({ dryRun: false }))).txs.length, 1);
    assert.equal(broadcasts, 2);
  });
  it("an unconfirmed claim broadcast returns the hash and still starts the claim interval", async () => {
    const { env } = mockEnv("arbitrum", 42161, distributorReads());
    let submits = 0;
    withSigner(env, () => (submits++, false)); // submit times out, tx not seen -> BroadcastUnconfirmedError
    const c = new MerklClaimer(env, { chain: "arbitrum" }, rewardsApi().f);
    const r = await c.claim(ME, ctx({ dryRun: false }));
    assert.equal(r.ok, false);
    assert.match(r.detail!, /may have landed\) hash=0x[0-9a-f]{64}/);
    assert.equal(r.txs[0]!.unconfirmed, true);
    const again = await c.claim(ME, ctx({ dryRun: false }));
    assert.match(again.detail!, /skipped/);
    assert.equal(submits, 1, "not re-sent immediately");
  });
});

describe("aave rewards claimer", () => {
  it("reads getAllUserRewards and encodes claimAllRewardsToSelf(assets)", async () => {
    const CTRL = addr(0xc0);
    const A_TOKEN = addr(0xa7);
    const DEBT = addr(0xd7);
    const REWARD = addr(0x7777);
    const { env, sent } = mockEnv("arbitrum", 42161, (a) => {
      if (a.functionName === "getAllUserRewards") return [[REWARD, addr(0x7778)], [42n, 0n]];
      if (a.functionName === "symbol") return "ARB";
      if (a.functionName === "decimals") return 18;
      if (a.functionName === "getRewardsList") return [REWARD];
      if (a.functionName === "getIncentivesController") return a.address === A_TOKEN ? CTRL : EVIL;
      throw new Error(a.functionName);
    });
    const c = new AaveRewardsClaimer(env, { chain: "arbitrum", rewardsController: CTRL, assets: [A_TOKEN, DEBT] });
    assert.deepEqual((await c.claimable(ME)).map((x) => [x.token.symbol, x.amount]), [["ARB", 42n]]);
    const r = await c.claim(ME, ctx());
    assert.equal(r.ok, true, r.detail);
    const d = decodeFunctionData({ abi: AAVE_REWARDS_CONTROLLER_ABI, data: sent[0]!.data });
    assert.equal(d.functionName, "claimAllRewardsToSelf");
    assert.deepEqual(d.args, [[A_TOKEN, DEBT]]);
    assert.equal(sent[0]!.to, CTRL);
    const issues = await c.verifyConfig();
    assert.equal(issues.length, 1);
    assert.match(issues[0]!, /getIncentivesController/);
  });
});

// ---------------------------------------------------------------------------
// Merkl reward-rate provider (fixtures mirror shapes seen on api.merkl.xyz, 2026-10-29)
// ---------------------------------------------------------------------------

const USDE = addr(0x5e);
const A_ETH_USDE = addr(0x4f59);
const VD_ETH_USDE = addr(0x0153);
const RLUSD = addr(0x8292);
const A_HOR_RLUSD = addr(0xe319);
const VD_HOR_RLUSD = addr(0xace8);
const USDG = addr(0xe343);
const USDT = addr(0xdac1);
const USDC = addr(0xa0b8);
const HUB = addr(0xcca8);
const HUB2 = addr(0x0600);
const MORPHO_MARKET = `0x${"ab".repeat(32)}`;
const NOW = 1_793_000_000_000;
const LIVE = { startTimestamp: 1792713600, endTimestamp: 1793318400 };
const PAST = { startTimestamp: 1792108800, endTimestamp: 1792713600 };

const aaveOpps = [
  {
    id: "11521673201667687989",
    type: "AAVE_SUPPLY",
    identifier: `${A_ETH_USDE}BORROW_BL`,
    explorerAddress: A_ETH_USDE,
    action: "LEND",
    status: "LIVE",
    chainId: 1,
    tvl: 247452150.83,
    dailyRewards: 32287.37,
    latestCampaignEnd: "1793318400",
    protocol: { id: "aave", name: "Aave" },
    tokens: [{ address: A_ETH_USDE, symbol: "aEthUSDe" }, { address: USDE, symbol: "USDe" }],
    campaigns: [
      {
        campaignId: "0xc1",
        type: "AAVE_SUPPLY",
        ...LIVE,
        dailyRewards: 32287.37,
        rewardToken: { address: addr(0x1d94), symbol: "aEthUSDe", type: "TOKEN" },
        params: {
          targetToken: A_ETH_USDE,
          underlyingToken: USDE,
          symbolUnderlyingToken: "USDe",
          whitelist: [],
          blacklist: [],
          hooks: [
            { chainId: 1, hookType: 17, protocol: 0, targetBytesLike: addr(0x925a), healthFactorThreshold: "2" },
            { hookType: 14, protocol: 2, computeChainId: 1, borrowBytesLike: [VD_ETH_USDE] },
          ],
          distributionMethodParameters: { distributionMethod: "AAVE_NET_APR", distributionSettings: { mode: "MAX_APR", side: "supply", targetAPR: "0.05" } },
        },
      },
      { campaignId: "0xc0", type: "AAVE_SUPPLY", ...PAST, dailyRewards: 0, rewardToken: { address: addr(0x1d94), symbol: "aEthUSDe" }, params: { targetToken: A_ETH_USDE } },
    ],
  },
  {
    id: "16069439808187088621",
    type: "AAVE_NET_LENDING",
    identifier: "46f2cfea975070a7",
    explorerAddress: A_HOR_RLUSD,
    action: "LEND",
    status: "LIVE",
    chainId: 1,
    tvl: 161741920.17,
    dailyRewards: 15916.94,
    protocol: { id: "aave" },
    tokens: [{ address: A_HOR_RLUSD, symbol: "aHorRwaRLUSD" }],
    campaigns: [
      {
        campaignId: "0xc2",
        type: "AAVE_NET_LENDING",
        ...LIVE,
        dailyRewards: 15916.94,
        rewardToken: { address: A_HOR_RLUSD, symbol: "aHorRwaRLUSD" },
        params: {
          tokens: [{ address: A_HOR_RLUSD, symbol: "aHorRwaRLUSD" }, { address: VD_HOR_RLUSD, symbol: "variableDebtHorRwaRLUSD" }],
          borrowTokens: [VD_HOR_RLUSD],
          lendingToken: A_HOR_RLUSD,
          hooks: [],
          blacklist: [addr(0x13dd)],
          whitelist: [],
          distributionMethodParameters: { distributionMethod: "AAVE_NET_APR", distributionSettings: { mode: "MAX_APR", targetAPR: "0.05" } },
        },
      },
    ],
  },
  {
    id: "742197597174337786",
    type: "AAVE_V4_HUB_NET_LENDING",
    identifier: "843cee7d4361af56",
    action: "LEND",
    status: "LIVE",
    chainId: 1,
    tvl: 78468841.75,
    dailyRewards: 7918.78,
    protocol: { id: "aave" },
    tokens: [{ address: USDG, symbol: "USDG" }],
    campaigns: [
      {
        campaignId: "0xc3",
        type: "AAVE_V4_HUB_NET_LENDING",
        ...LIVE,
        dailyRewards: 7918.78,
        rewardToken: { address: addr(0xdf46), symbol: "USDG" },
        params: {
          hubs: [{ hubAddress: HUB, assets: [{ symbol: "USDG", assetId: 8, underlyingToken: USDG }, { symbol: "USDT", assetId: 4, underlyingToken: USDT }, { symbol: "USDC", assetId: 5, underlyingToken: USDC }] }],
          borrowAssetIds: ["8", "4", "5"],
          lendingAssetIds: ["8"],
          hooks: [],
          whitelist: [],
          blacklist: [],
          distributionMethodParameters: { distributionMethod: "AAVE_V4_NET_APR", distributionSettings: { mode: "MAX_APR", side: "supply", assetId: "8", targetAPR: "0.06" } },
        },
      },
    ],
  },
  {
    id: "13158230964923482281",
    type: "AAVE_V4_HUB_NET_BORROWING",
    identifier: "78146c09dd5ee539",
    action: "BORROW",
    status: "LIVE",
    chainId: 1,
    tvl: 48795122.72,
    dailyRewards: 2673.7,
    protocol: { id: "aave" },
    tokens: [{ address: USDC, symbol: "USDC" }],
    campaigns: [
      {
        campaignId: "0xc4",
        type: "AAVE_V4_HUB_NET_BORROWING",
        ...LIVE,
        dailyRewards: 2673.7,
        rewardToken: { address: addr(0x4045), symbol: "USDC" },
        params: {
          hubs: [{ hubAddress: HUB, assets: [{ symbol: "USDC", assetId: 5, underlyingToken: USDC }, { symbol: "USDT", assetId: 4, underlyingToken: USDT }, { symbol: "USDG", assetId: 8, underlyingToken: USDG }] }],
          borrowAssetIds: ["5"],
          supplyAssetIds: ["4", "5", "8"],
          hooks: [],
          whitelist: [],
          blacklist: [],
          distributionMethodParameters: { distributionMethod: "MAX_APR", distributionSettings: { apr: "0.02" } },
        },
      },
    ],
  },
  {
    id: "999",
    type: "AAVE_SUPPLY",
    identifier: addr(0x9999),
    explorerAddress: addr(0x9999),
    action: "LEND",
    status: "LIVE",
    chainId: 1,
    tvl: 1_000_000,
    dailyRewards: 100,
    protocol: { id: "aave" },
    campaigns: [{ campaignId: "0xc5", type: "AAVE_SUPPLY", ...LIVE, dailyRewards: 100, rewardToken: { address: addr(0x77), symbol: "WL" }, params: { targetToken: addr(0x9999), whitelist: [addr(0x4242)] } }],
  },
];

const morphoOpps = [
  {
    id: "m1",
    type: "MORPHOBORROW",
    identifier: MORPHO_MARKET,
    action: "BORROW",
    status: "LIVE",
    chainId: 1,
    tvl: 10_000_000,
    dailyRewards: 1000,
    latestCampaignEnd: 1793318400,
    protocol: { id: "morpho" },
    rewardsRecord: { breakdowns: [{ token: { address: addr(0x3333), symbol: "MORPHO" }, value: 1000 }] },
    // no campaigns array: opportunity-level fallback (detail fetch returns none)
  },
];

function oppApi() {
  const calls: string[] = [];
  const f: HttpFetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/opportunities")) {
      if (u.searchParams.get("page") !== "0") return json([]);
      if (u.searchParams.get("chainId") !== "1") return json([]);
      const p = u.searchParams.get("mainProtocolId");
      return json(p === "aave" ? aaveOpps : p === "morpho" ? morphoOpps : []);
    }
    if (u.pathname.includes("/opportunities/")) return json({ id: "m1" }); // detail without campaigns
    return json({}, 404);
  };
  return { f, calls };
}

const asset = (symbol: string, address: string): AssetRef => ({ chain: "ethereum", symbol, address, decimals: 18 });
const q = (over: Partial<RewardRateQuery>): RewardRateQuery => ({ protocol: "aave-v3", chain: "ethereum", asset: asset("USDe", USDE), side: "supply", ...over });

describe("merkl reward-rate provider", () => {
  it("matches an Aave v3 supply campaign by aToken; APR = dailyRewards*365/tvl; conditions parsed", async () => {
    const api = oppApi();
    const p = merklRewardRateProvider({ fetch: api.f, now: () => NOW });
    const rates = await p(q({ marketId: A_ETH_USDE }));
    assert.equal(rates.length, 1, "past campaign ignored");
    const r = rates[0]!;
    assert.ok(Math.abs(r.apr - (32287.37 * 365) / 247452150.83) < 1e-12);
    assert.equal(r.endsAtMs, 1793318400_000);
    assert.equal(r.token, "USDe"); // aEthUSDe reported as its underlying
    assert.match(r.note!, /paid in aEthUSDe/);
    assert.equal(r.maxHealthFactor, 2);
    assert.deepEqual(r.ineligibleIfBorrowing, [VD_ETH_USDE.toLowerCase()]);
    assert.equal(r.aprCap, 0.05);
    assert.equal(r.netOf, undefined);
    assert.match(api.calls[0]!, /\/v4\/opportunities\?chainId=1&mainProtocolId=aave&status=LIVE&campaigns=true&items=100&page=0$/);
    // collateral side of Aave = supply position
    assert.equal((await p(q({ marketId: A_ETH_USDE, side: "collateral" }))).length, 1);
  });
  it("returns nothing without a market identifier, for a wrong aToken, the wrong side or the wrong underlying", async () => {
    const p = merklRewardRateProvider({ fetch: oppApi().f, now: () => NOW });
    assert.deepEqual(await p(q({})), []);
    assert.deepEqual(await p(q({ marketId: addr(0x4444) })), []);
    assert.deepEqual(await p(q({ marketId: A_ETH_USDE, side: "borrow" })), []);
    assert.deepEqual(await p(q({ marketId: A_ETH_USDE, asset: asset("USDC", USDC) })), [], "params.underlyingToken mismatch");
    assert.deepEqual(await p(q({ protocol: "unknown-lender", marketId: A_ETH_USDE })), []);
    assert.deepEqual(await p(q({ marketId: addr(0x9999) })), [], "whitelisted campaign");
  });
  it("expired campaigns yield nothing", async () => {
    const p = merklRewardRateProvider({ fetch: oppApi().f, now: () => 1793318400_000 + 1 });
    assert.deepEqual(await p(q({ marketId: A_ETH_USDE })), []);
  });
  it("Aave v3 NET_LENDING: netOf parsed from borrowTokens (resolveKeys supplies the aToken)", async () => {
    const p = merklRewardRateProvider({ fetch: oppApi().f, now: () => NOW, resolveKeys: (x) => (x.asset.address === RLUSD ? [A_HOR_RLUSD] : []) });
    const rates = await p(q({ asset: asset("RLUSD", RLUSD) }));
    assert.equal(rates.length, 1);
    assert.deepEqual(rates[0]!.netOf, ["RLUSD"]);
    assert.equal(rates[0]!.token, "RLUSD");
    const blocked = merklRewardRateProvider({ fetch: oppApi().f, now: () => NOW, owner: addr(0x13dd), resolveKeys: () => [A_HOR_RLUSD] });
    assert.deepEqual(await blocked(q({ asset: asset("RLUSD", RLUSD) })), [], "blacklisted owner");
  });
  it("Aave v4 hub campaigns: hub + paid-on asset must match; netOf from the other side's asset ids", async () => {
    const p = merklRewardRateProvider({ fetch: oppApi().f, now: () => NOW });
    const sup = await p(q({ protocol: "aave-v4", asset: asset("USDG", USDG), marketId: HUB }));
    assert.equal(sup.length, 1);
    assert.deepEqual(sup[0]!.netOf, ["USDG", "USDT", "USDC"]);
    assert.equal(sup[0]!.aprCap, 0.06);
    const bor = await p(q({ protocol: "aave-v4", asset: asset("USDC", USDC), marketId: HUB, side: "borrow" }));
    assert.equal(bor.length, 1);
    assert.deepEqual(bor[0]!.netOf, ["USDT", "USDC", "USDG"]);
    assert.ok(Math.abs(bor[0]!.apr - (2673.7 * 365) / 48795122.72) < 1e-12);
    // negatives
    assert.deepEqual(await p(q({ protocol: "aave-v4", asset: asset("USDT", USDT), marketId: HUB })), [], "USDT is netted, not paid");
    assert.deepEqual(await p(q({ protocol: "aave-v4", asset: asset("USDG", USDG), marketId: HUB2 })), [], "other hub");
    assert.deepEqual(await p(q({ protocol: "aave-v4", asset: asset("USDG", USDG) })), [], "no hub given");
    assert.deepEqual(await p(q({ protocol: "aave-v3", asset: asset("USDG", USDG), marketId: HUB })), [], "v3 query never matches v4 types");
  });
  it("Morpho: identifier == market id; opportunity-level fallback when no campaigns", async () => {
    const p = merklRewardRateProvider({ fetch: oppApi().f, now: () => NOW });
    const r = await p({ protocol: "morpho", chain: "ethereum", asset: asset("USDC", USDC), side: "borrow", marketId: MORPHO_MARKET.toUpperCase().replace("0X", "0x") });
    assert.equal(r.length, 1);
    assert.equal(r[0]!.token, "MORPHO");
    assert.ok(Math.abs(r[0]!.apr - (1000 * 365) / 10_000_000) < 1e-12);
    assert.equal(r[0]!.endsAtMs, 1793318400_000);
    assert.deepEqual(await p({ protocol: "morpho", chain: "ethereum", asset: asset("USDC", USDC), side: "collateral", marketId: MORPHO_MARKET }), [], "morpho collateral is not lent");
    assert.deepEqual(await p({ protocol: "morpho", chain: "ethereum", asset: asset("USDC", USDC), side: "borrow", marketId: `0x${"cd".repeat(32)}` }), []);
  });
  it("caches responses for cacheMinutes", async () => {
    let t = NOW;
    const api = oppApi();
    const p = merklRewardRateProvider({ fetch: api.f, now: () => t, cacheMinutes: 5 });
    await p(q({ marketId: A_ETH_USDE }));
    await p(q({ marketId: A_HOR_RLUSD, asset: asset("RLUSD", RLUSD) }));
    assert.equal(api.calls.length, 1);
    t += 5 * 60_000 + 1;
    await p(q({ marketId: A_ETH_USDE }));
    assert.equal(api.calls.length, 2);
  });
  it("strips Aave receipt prefixes conservatively", () => {
    assert.equal(underlyingOfReceiptSymbol("aPlaUSDe"), "USDe");
    assert.equal(underlyingOfReceiptSymbol("aEthsUSDe"), "sUSDe");
    assert.equal(underlyingOfReceiptSymbol("variableDebtHorRwaRLUSD"), "RLUSD");
    assert.equal(underlyingOfReceiptSymbol("ARB"), undefined);
    assert.equal(underlyingOfReceiptSymbol("aFooBar"), undefined);
  });
});
