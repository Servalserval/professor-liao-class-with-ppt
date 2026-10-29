/**
 * Builds every live component from config/live.yaml:
 *   chain envs -> price feed -> swappers -> reward-rate provider ->
 *   lending adapters (+ PairRegistry sources) -> executors (Loop + Canary) ->
 *   bridges (CCTP V2, USDT0, same-chain swap) -> wallet buckets -> verify.
 *
 * Keys: EVM_PRIVATE_KEY(_FILE) / SUI_PRIVATE_KEY(_FILE). Without a key a
 * chain env is read-only (wallets.*_address), which is enough for shadow
 * mode: every write is simulated from that address, nothing can be signed.
 */
import { loadConfig, type BridgeExecutor, type Executor, type RouteSpec, type RouterConfig, type Source, type TokenProfile } from "@incentive-router/core";
import {
  CctpV2Adapter,
  LiveBridgeExecutor,
  recipientsFromEnvs,
  USDT0_DEPLOYMENTS,
  Usdt0OftAdapter,
  verifyBridges,
} from "@incentive-router/live-bridges";
import {
  chainInfo,
  loadSecret,
  type AssetRef,
  type BridgeAdapter,
  type LendingAdapter,
  type LiveContext,
  type Logger,
  type RewardClaimer,
  type RewardRateProvider,
  type SwapAdapter,
} from "@incentive-router/live-common";
import { AaveV3Adapter, aaveAssetFromAddressBook, aaveMarketFromAddressBook, MerklClaimer, merklRewardRateProvider, AggregatorSwapAdapter, MorphoBlueAdapter, type AaveMarketConfig } from "@incentive-router/live-evm";
import { assertChainId, erc20Balance, makeEvmEnv, verifyAsset, type Address, type EvmEnv, type Hex } from "@incentive-router/live-evm-base";
import {
  CetusPtbSwapper,
  CetusSwapAdapter,
  coinBalance,
  coinDecimalsFromChain,
  createCetusAggregatorClient,
  makeSuiEnv,
  NaviAdapter,
  ScallopAdapter,
  SuilendAdapter,
  type PtbSwapper,
  type SuiEnv,
} from "@incentive-router/live-sui";
import { AaveV4Adapter } from "@incentive-router/live-aave-v4";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { BucketReader } from "./balances.js";
import { configHash } from "./gate.js";
import { applyCanaryToRouterConfig, CanaryExecutor } from "./guards.js";
import type { AssetSpec, LendingSpec, LiveConfig, PairSpec } from "./liveConfig.js";
import { LoopExecutor } from "./loopExecutor.js";
import { PairRegistry, type PairWiring } from "./pairs.js";
import { PriceFeed } from "./prices.js";
import { RewardKeeper } from "./rewardKeeper.js";
import { ShadowBridgeExecutor } from "./shadowBridge.js";
import { SwapRouteAdapter } from "./swapRoute.js";

export interface Runtime {
  cfg: LiveConfig;
  routerCfg: RouterConfig;
  /** Hash of the (unexpanded) live config + router config: the live gate compares it with the verify stamp. */
  hash: string;
  log: Logger;
  ctx: LiveContext;
  prices: PriceFeed;
  evm: Record<string, EvmEnv>;
  sui?: SuiEnv;
  assets: Record<string, Record<string, AssetRef>>;
  registry: PairRegistry;
  sources: Source[];
  executor: Executor;
  executors: Record<string, Executor>;
  bridges: Record<string, BridgeExecutor>;
  buckets: BucketReader;
  keeper: RewardKeeper;
  tokens: () => Promise<Record<string, TokenProfile>>;
  /** Component id -> blocking issues found on-chain (empty = OK) + non-fatal "WARN:" lines. */
  verify: () => Promise<{ issues: Record<string, string[]>; warnings: Record<string, string[]> }>;
  canSign: { evm: boolean; sui: boolean };
}

export interface BuildOptions {
  /** Positions currently in the router store (for the canary guard). */
  positions: () => { oppId: string; equityUsd: number }[];
  log?: Logger;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

type Verifier = { id: string; run: () => Promise<string[]> };

const defaultLog: Logger = (level, msg, data) => {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}${data ? " " + JSON.stringify(data) : ""}`;
  if (level === "error" || level === "warn") console.error(line);
  else if (level !== "debug" || process.env.DEBUG) console.log(line);
};

/** Accept string[] or {ok, checks|issues} verify reports. */
function issuesOf(r: unknown): string[] {
  if (Array.isArray(r)) return r.map(String);
  if (r && typeof r === "object") {
    const o = r as { ok?: boolean; issues?: unknown[]; checks?: { name: string; ok: boolean; detail?: string }[] };
    if (Array.isArray(o.issues)) return o.issues.map(String);
    if (Array.isArray(o.checks)) return o.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    if (o.ok === false) return ["verify failed (no details)"];
  }
  return [];
}

/** Config asset -> AssetRef (explicit address, Aave address book, or the USDT0 table). */
export function resolveAsset(chain: string, symbol: string, a: AssetSpec): AssetRef {
  if (a.address) {
    if (a.decimals === undefined) throw new Error(`assets.${chain}.${symbol}: decimals required with an address`);
    return { chain, symbol, address: a.address, decimals: a.decimals };
  }
  if (a.aave_book) {
    const r = aaveAssetFromAddressBook(a.aave_book, a.book_symbol ?? symbol, symbol);
    if (r.chain !== chain) throw new Error(`assets.${chain}.${symbol}: address book ${a.aave_book} is on ${r.chain}`);
    return r;
  }
  if (a.usdt0) {
    const d = USDT0_DEPLOYMENTS[chain];
    if (!d?.token) throw new Error(`assets.${chain}.${symbol}: no USDT0 token listed for ${chain} (give the address)`);
    return { chain, symbol, address: d.token, decimals: 6 };
  }
  throw new Error(`assets.${chain}.${symbol}: needs address+decimals, aave_book or usdt0`);
}

export function routerConfigFor(cfg: LiveConfig): RouterConfig {
  return applyCanaryToRouterConfig(loadConfig(cfg.router_config), cfg.canary);
}

export function liveConfigHash(raw: unknown, cfg: LiveConfig): string {
  const routerRaw = parse(readFileSync(cfg.router_config, "utf8")) as unknown;
  return configHash({ live: raw, router: routerRaw });
}

export async function buildRuntime(cfg: LiveConfig, raw: unknown, o: BuildOptions): Promise<Runtime> {
  const log = o.log ?? defaultLog;
  const env = o.env ?? process.env;
  const now = o.now ?? (() => Date.now());
  const routerCfg = routerConfigFor(cfg);
  const hash = liveConfigHash(raw, cfg);
  const verifiers: Verifier[] = [];

  // --- assets -----------------------------------------------------------------
  const assets: Record<string, Record<string, AssetRef>> = {};
  for (const [chain, m] of Object.entries(cfg.assets ?? {}))
    for (const [symbol, a] of Object.entries(m)) (assets[chain] ??= {})[symbol] = resolveAsset(chain, symbol, a);
  const asset = (chain: string, symbol: string): AssetRef => {
    const a = assets[chain]?.[symbol];
    if (!a) throw new Error(`asset ${chain}:${symbol} is not in config assets`);
    return a;
  };

  // --- prices + context ---------------------------------------------------------
  const prices = new PriceFeed({
    overrides: cfg.prices?.overrides,
    nativeIds: (cfg.prices as { native_ids?: Record<string, string> } | undefined)?.native_ids,
    maxAgeMs: (cfg.prices?.max_age_minutes ?? 10) * 60_000,
    now,
  });
  const ctx: LiveContext = {
    dryRun: true, // executors flip this per mode; anything else stays simulate-only
    log,
    limits: { maxGasUsd: cfg.limits.max_gas_usd, maxSlippageBps: cfg.limits.max_slippage_bps, maxLoopIterations: cfg.limits.max_loop_iterations },
    priceUsd: (a) => prices.priceUsd(a),
    nativePriceUsd: (c) => prices.nativePriceUsd(c),
  };

  // --- chain envs -----------------------------------------------------------------
  const evmKey = loadSecret("EVM_PRIVATE_KEY", env);
  const suiKey = loadSecret("SUI_PRIVATE_KEY", env);
  const evm: Record<string, EvmEnv> = {};
  let sui: SuiEnv | undefined;
  for (const [chain, c] of Object.entries(cfg.chains ?? {})) {
    const info = chainInfo(chain);
    if (info.family === "evm") {
      if (!c.rpc) throw new Error(`chains.${chain}.rpc is empty (set the env var it references)`);
      evm[chain] = makeEvmEnv({ chain, rpcUrl: c.rpc, privateKey: evmKey, address: cfg.wallets.evm_address as Address | undefined });
      if (evmKey && cfg.wallets.evm_address && evm[chain]!.account.toLowerCase() !== cfg.wallets.evm_address.toLowerCase())
        throw new Error(`EVM key address ${evm[chain]!.account} != wallets.evm_address ${cfg.wallets.evm_address}`);
      const e = evm[chain]!;
      verifiers.push({ id: `chain:${chain}`, run: async () => (await assertChainId(e).then(() => [] as string[]).catch((x: Error) => [x.message])) });
    } else {
      if (!c.grpc || !c.jsonrpc) throw new Error(`chains.${chain} needs grpc and jsonrpc`);
      sui = makeSuiEnv({ grpcUrl: c.grpc, jsonRpcUrl: c.jsonrpc, secret: suiKey, address: cfg.wallets.sui_address });
      if (suiKey && cfg.wallets.sui_address && sui.address !== makeSuiEnv({ grpcUrl: c.grpc, jsonRpcUrl: c.jsonrpc, address: cfg.wallets.sui_address }).address)
        throw new Error(`Sui key address ${sui.address} != wallets.sui_address ${cfg.wallets.sui_address}`);
    }
  }
  const evmEnv = (chain: string) => {
    const e = evm[chain];
    if (!e) throw new Error(`no EVM env for ${chain} (add it under chains)`);
    return e;
  };
  const suiEnv = () => {
    if (!sui) throw new Error("no Sui env (add chains.sui)");
    return sui;
  };
  const balance = async (a: AssetRef): Promise<bigint> =>
    chainInfo(a.chain).family === "sui" ? coinBalance(suiEnv(), a.address) : erc20Balance(evmEnv(a.chain), a.address as Address);

  // asset checks
  for (const [chain, m] of Object.entries(assets)) {
    if (chainInfo(chain).family === "evm") {
      if (!evm[chain]) continue;
      for (const a of Object.values(m)) verifiers.push({ id: `asset:${chain}:${a.symbol}`, run: () => verifyAsset(evmEnv(chain), a) });
    } else if (sui) {
      const dec = coinDecimalsFromChain(sui);
      for (const a of Object.values(m))
        verifiers.push({
          id: `asset:${chain}:${a.symbol}`,
          run: async () => {
            const d = await dec(a.address).catch((e: Error) => -1 - 0 * e.message.length);
            return d === a.decimals ? [] : [`${a.symbol}: on-chain decimals ${d} != configured ${a.decimals}`];
          },
        });
    }
  }

  // --- swappers -------------------------------------------------------------------
  const swappers: Record<string, SwapAdapter> = {};
  let suiPtbSwapper: PtbSwapper | undefined;
  for (const [chain, s] of Object.entries(cfg.swaps ?? {})) {
    const opt = (s.options ?? {}) as Record<string, unknown>;
    const maxCostBps = Number(opt.max_cost_bps ?? opt.maxCostBps ?? 15);
    if (s.type === "aggregator") {
      const sw = new AggregatorSwapAdapter(evmEnv(chain), { chain, maxCostBps, ...(opt.aggregator_options as object) });
      swappers[chain] = sw;
      verifiers.push({ id: `swap:${chain}`, run: async () => issuesOf(await sw.verifyConfig()) });
    } else if (s.type === "cetus") {
      const e = suiEnv();
      const decimals = coinDecimalsFromChain(e);
      const suiAssets = Object.values(assets.sui ?? {});
      const ptb = new CetusPtbSwapper({
        aggregator: createCetusAggregatorClient(e, { apiKey: env.CETUS_API_KEY }),
        refPriceUsd: async (coinType) => {
          const a = suiAssets.find((x) => x.address === coinType);
          return prices.priceUsd(a ?? { chain: "sui", symbol: coinType, address: coinType, decimals: await decimals(coinType) });
        },
        decimals,
        maxCostBps,
        maxHops: opt.max_hops !== undefined ? Number(opt.max_hops) : undefined,
      });
      suiPtbSwapper = ptb;
      swappers[chain] = new CetusSwapAdapter({ env: e, swapper: ptb });
    } else throw new Error(`swaps.${chain}: unknown type ${s.type}`);
  }

  // --- reward rates (Merkl) ------------------------------------------------------
  const merklOpts = (cfg.rewards?.merkl?.options ?? {}) as Record<string, unknown>;
  const extraRewards: RewardRateProvider | undefined = cfg.rewards?.merkl?.enabled
    ? (merklRewardRateProvider({
        apiKey: env.MERKL_API_KEY || undefined,
        owner: cfg.wallets.evm_address,
        rewardSymbols: merklOpts.reward_symbols as Record<string, string> | undefined,
        log,
      }) as RewardRateProvider)
    : undefined;

  // --- Pyth (Sui in-PTB price pushes) ---------------------------------------------
  let pythUpdates: FactoryDeps["pythUpdates"];
  if (sui && (cfg.lending ?? []).some((l) => l.type === "suilend")) {
    const { SuiPriceServiceConnection } = await import("@pythnetwork/pyth-sui-js");
    pythUpdates = new SuiPriceServiceConnection(env.PYTH_HERMES_URL || "https://hermes.pyth.network", {
      accessToken: env.PYTH_API_KEY || undefined,
      timeout: 10_000,
    });
  }

  // --- lending adapters -----------------------------------------------------------
  const registry = new PairRegistry({ marketPrice: (a) => prices.priceUsd(a), log });
  const sources: Source[] = [];
  const lendingForKeeper: { adapter: LendingAdapter; pairIds: string[] }[] = [];
  const wiringOf = (l: LendingSpec): PairWiring[] =>
    l.pairs.map((p: PairSpec) => ({ pairId: p.pairId, collateral: asset(l.chain, p.collateral), debt: asset(l.chain, p.debt), expectedPriceRatio: p.expected_price_ratio }));
  for (const l of cfg.lending ?? []) {
    const wiring = wiringOf(l);
    const opt = (l.options ?? {}) as Record<string, unknown>;
    const adapter = makeLendingAdapter(l, wiring, opt, {
      evmEnv,
      suiEnv,
      swappers,
      suiPtbSwapper,
      extraRewards,
      priceUsd: (a) => prices.priceUsd(a),
      log,
      pythUpdates,
    });
    sources.push(registry.source(adapter, wiring));
    lendingForKeeper.push({ adapter, pairIds: wiring.map((w) => w.pairId) });
    const v = (adapter as unknown as { verifyConfig?: () => Promise<unknown> }).verifyConfig;
    if (v) verifiers.push({ id: `lending:${adapter.id}`, run: async () => issuesOf(await v.call(adapter)) });
    else verifiers.push({ id: `lending:${adapter.id}`, run: async () => [`${adapter.id}: adapter has no verifyConfig()`] });
  }

  // --- executors ----------------------------------------------------------------------
  const mode = cfg.mode === "live" ? "live" : "shadow";
  const cash: Record<string, AssetRef> = {};
  for (const [chain, sym] of Object.entries(cfg.cash_asset ?? {})) cash[chain] = asset(chain, sym);
  const sellCfg = ((cfg.rewards as { sell?: Record<string, string[]> } | undefined)?.sell ?? {}) as Record<string, string[]>;
  const rewardAssets: Record<string, Record<string, AssetRef>> = {};
  for (const [chain, syms] of Object.entries(sellCfg)) for (const s of syms) (rewardAssets[chain] ??= {})[s] = asset(chain, s);
  const loop = new LoopExecutor({ mode, ctx, bind: (id) => registry.bind(id), swappers, rewardAssets, proceedsAsset: cash });
  const executor = new CanaryExecutor(loop, cfg.canary, () => o.positions() as never);
  const executors = Object.fromEntries(sources.map((s) => [s.id, executor as Executor]));

  // --- bridges -----------------------------------------------------------------------
  const bridgeAdapters: BridgeAdapter[] = [];
  const usdc: Record<string, AssetRef> = {};
  for (const [chain, m] of Object.entries(assets)) if (m.USDC) usdc[chain] = m.USDC;
  const b = cfg.bridges ?? {};
  for (const kind of ["cctp_v2_standard", "cctp_v2_fast"] as const)
    if (b[kind]?.enabled)
      bridgeAdapters.push(new CctpV2Adapter({ mode: kind === "cctp_v2_fast" ? "fast" : "standard", envs: evm, usdc, sui: sui ? { env: sui } : undefined }));
  if (b.usdt0_oft?.enabled) {
    const tokens: Record<string, AssetRef> = {};
    for (const [chain, m] of Object.entries(assets)) {
      const t = m.USDT0 ?? (chain === "ethereum" ? m.USDT : undefined);
      if (t) tokens[chain] = t;
    }
    bridgeAdapters.push(new Usdt0OftAdapter({ envs: evm, tokens }));
  }
  const routes: RouteSpec[] = routerCfg.xchain?.routes ?? [];
  if (b.swap?.enabled) {
    const tol = Number((b.swap.options as { tolerance_bps?: number } | undefined)?.tolerance_bps ?? 2);
    bridgeAdapters.push(
      new SwapRouteAdapter({
        swappers,
        balance,
        maxCostBps: (from, to) => {
          const r = routes.find((x) => x.kind === "swap" && x.from.chain === from.chain && x.from.asset === from.symbol && x.to.asset === to.symbol);
          return r ? r.feeBps + tol : 0; // no planned route -> refuse
        },
      })
    );
  }
  const recipients = recipientsFromEnvs(evm, sui);
  const live = new LiveBridgeExecutor({ adapters: bridgeAdapters, registry: assets, recipients, ctx: { ...ctx, dryRun: mode !== "live" }, balance, now });
  const bexec: BridgeExecutor = mode === "live" ? live : new ShadowBridgeExecutor(live, now);
  const bridges: Record<string, BridgeExecutor> = {};
  for (const a of bridgeAdapters) bridges[a.kind] = bexec;
  if (bridgeAdapters.length)
    verifiers.push({
      id: "bridges",
      run: async () =>
        (
          await verifyBridges({
            cctp: b.cctp_v2_standard?.enabled || b.cctp_v2_fast?.enabled ? { envs: evm, usdc, sui: sui ? { env: sui } : undefined } : undefined,
            usdt0: b.usdt0_oft?.enabled ? { envs: evm } : undefined,
          })
        ).issues,
    });
  for (const r of routes.filter((x) => x.enabled))
    verifiers.push({
      id: `route:${r.id}`,
      run: async () => {
        const out: string[] = [];
        if (!assets[r.from.chain]?.[r.from.asset]) out.push(`${r.id}: ${r.from.chain}:${r.from.asset} not in assets`);
        if (!assets[r.to.chain]?.[r.to.asset]) out.push(`${r.id}: ${r.to.chain}:${r.to.asset} not in assets`);
        if (r.kind !== "noop" && !bridges[r.kind]) out.push(`${r.id}: no live executor for kind ${r.kind} (enable it under bridges)`);
        return out;
      },
    });

  // --- reward claimers + keeper --------------------------------------------------------
  const claimers: RewardClaimer[] = [];
  if (cfg.rewards?.merkl?.enabled)
    for (const chain of Object.keys(evm)) {
      const c = new MerklClaimer(evmEnv(chain), { chain, apiKey: env.MERKL_API_KEY || undefined });
      claimers.push(c);
      verifiers.push({ id: `merkl:${chain}`, run: async () => issuesOf(await c.verifyConfig()) });
    }
  const kopt = ((cfg.rewards as { keeper?: { interval_hours?: number; min_claim_usd?: number; min_sell_usd?: number } } | undefined)?.keeper ?? {});
  const sellables: Record<string, AssetRef[]> = {};
  for (const [chain, m] of Object.entries(rewardAssets)) sellables[chain] = Object.values(m);
  const keeper = new RewardKeeper({
    mode,
    ctx,
    claimers,
    lending: lendingForKeeper,
    owner: (chain) => (chainInfo(chain).family === "sui" ? sui?.address : evm[chain]?.account),
    sellables,
    cash,
    swappers,
    balance,
    statePath: join(cfg.state_dir, "rewards.json"),
    opts: { intervalHours: kopt.interval_hours ?? 4, minClaimUsd: kopt.min_claim_usd ?? 20, minSellUsd: kopt.min_sell_usd ?? 20 },
    now,
  });

  // --- wallet buckets ------------------------------------------------------------------
  const bucketAssets: AssetRef[] = [...Object.values(cash)];
  for (const l of cfg.lending ?? []) for (const w of wiringOf(l)) bucketAssets.push(w.collateral, w.debt);
  for (const r of routes.filter((x) => x.enabled)) {
    const f = assets[r.from.chain]?.[r.from.asset];
    const t = assets[r.to.chain]?.[r.to.asset];
    if (f) bucketAssets.push(f);
    if (t) bucketAssets.push(t);
  }
  const buckets = new BucketReader({ assets: bucketAssets, balance, priceUsd: (a) => prices.priceUsd(a), log });

  // --- token profiles for reward valuation -------------------------------------------
  const tokenCfg = ((cfg as { tokens?: Record<string, TokenProfile & { chain?: string }> }).tokens ?? {}) as Record<string, TokenProfile & { chain?: string }>;
  const tokens = async (): Promise<Record<string, TokenProfile>> => {
    const out: Record<string, TokenProfile> = {};
    for (const [sym, p] of Object.entries(tokenCfg)) {
      const { chain, ...prof } = p;
      const a = chain ? assets[chain]?.[sym] : Object.values(assets).map((m) => m[sym]).find(Boolean);
      let priceUsd = prof.priceUsd;
      if (a) priceUsd = await prices.priceUsd(a).catch(() => prof.priceUsd);
      out[sym] = { ...prof, priceUsd };
    }
    return out;
  };

  const verify = async () => {
    const issues: Record<string, string[]> = {};
    const warnings: Record<string, string[]> = {};
    for (const v of verifiers) {
      let lines: string[];
      try {
        lines = await v.run();
      } catch (e) {
        lines = [`verify threw: ${(e as Error).message}`];
      }
      // viem / SDK errors are multi-line; keep the first line (and "Details:" if present).
      lines = lines.map((l) => {
        const parts = String(l).split("\n").map((x) => x.trim()).filter(Boolean);
        const det = parts.find((x) => x.startsWith("Details:"));
        return [parts[0] ?? "", det].filter(Boolean).join(" | ").slice(0, 300);
      });
      issues[v.id] = lines.filter((l) => !/^WARN\b/i.test(l));
      const w = lines.filter((l) => /^WARN\b/i.test(l));
      if (w.length) warnings[v.id] = w;
    }
    if (cfg.mode === "live") {
      if (!evmKey && Object.keys(evm).length) issues["keys:evm"] = ["EVM_PRIVATE_KEY(_FILE) is not set: live mode cannot sign"];
      if (!suiKey && sui) issues["keys:sui"] = ["SUI_PRIVATE_KEY(_FILE) is not set: live mode cannot sign"];
    }
    return { issues, warnings };
  };

  return {
    cfg,
    routerCfg,
    hash,
    log,
    ctx,
    prices,
    evm,
    sui,
    assets,
    registry,
    sources,
    executor,
    executors,
    bridges,
    buckets,
    keeper,
    tokens,
    verify,
    canSign: { evm: !!evmKey, sui: !!suiKey },
  };
}

// ---------------------------------------------------------------------------
// Lending adapter factories (one per `lending[].type`)
// ---------------------------------------------------------------------------

export interface FactoryDeps {
  evmEnv: (chain: string) => EvmEnv;
  suiEnv: () => SuiEnv;
  swappers: Record<string, SwapAdapter>;
  suiPtbSwapper?: PtbSwapper;
  extraRewards?: RewardRateProvider;
  priceUsd: (a: AssetRef) => Promise<number>;
  log: Logger;
  /** Signed Pyth update data for Sui protocols that push prices in-PTB (Suilend). */
  pythUpdates?: { getPriceFeedsUpdateData(ids: string[]): Promise<Buffer[]> };
}

export function makeLendingAdapter(l: LendingSpec, wiring: PairWiring[], opt: Record<string, unknown>, d: FactoryDeps): LendingAdapter {
  switch (l.type) {
    case "aave-v3": {
      // Address-book market (e.g. AaveV3Plasma) or explicit addresses for markets the
      // book does not have (Monad, X Layer, forks): pool, poolAddressesProvider,
      // uiPoolDataProvider[, rewardsController]. verifyConfig() reads them back on-chain.
      let market: AaveMarketConfig;
      if (l.addresses?.pool) {
        const a = l.addresses;
        if (!a.poolAddressesProvider || !a.uiPoolDataProvider) throw new Error(`aave-v3@${l.chain}: addresses need pool, poolAddressesProvider, uiPoolDataProvider`);
        market = {
          protocol: l.protocol ?? "aave-v3",
          chain: l.chain,
          pool: a.pool as Address,
          poolAddressesProvider: a.poolAddressesProvider as Address,
          uiPoolDataProvider: a.uiPoolDataProvider as Address,
          rewardsController: a.rewardsController as Address | undefined,
          uiIncentiveDataProvider: a.uiIncentiveDataProvider as Address | undefined,
          key: a.key,
          evmChainId: chainInfo(l.chain).evmChainId,
        };
      } else {
        if (!l.market) throw new Error(`aave-v3@${l.chain}: set market (address-book name) or addresses`);
        market = aaveMarketFromAddressBook(l.market, { chain: l.chain, protocol: l.protocol });
      }
      return new AaveV3Adapter({
        env: d.evmEnv(l.chain),
        market,
        pairs: l.pairs.map((p, i) => ({
          pairId: p.pairId,
          collateral: wiring[i]!.collateral,
          debt: wiring[i]!.debt,
          eMode: (p as { emode?: "auto" | "none" | number }).emode,
        })),
        swapper: d.swappers[l.chain],
        extraRewards: d.extraRewards,
        log: d.log,
        ...(opt as object),
      });
    }
    case "aave-v4": {
      // Spoke + hub addresses come from AaveKit / Aave's address dashboard (not in the
      // address book yet); verifyConfig() checks code, ABI selectors and reserve hubs.
      const a = l.addresses ?? {};
      if (!a.spoke || !a.hub) throw new Error(`aave-v4@${l.chain}: addresses.spoke and addresses.hub are required`);
      const spoke = { chain: l.chain, spokeName: l.market ?? "spoke", spoke: a.spoke, hub: a.hub };
      // Merkl matches V4 campaigns by HUB address (merklRates "aave-v4-hub" matcher).
      const rewards = d.extraRewards;
      return new AaveV4Adapter({
        env: d.evmEnv(l.chain),
        spoke,
        pairs: l.pairs.map((p, i) => ({ pairId: p.pairId, collateral: wiring[i]!.collateral, debt: wiring[i]!.debt })),
        swapper: d.swappers[l.chain],
        extraRewards: rewards ? (q) => rewards({ ...q, marketId: a.hub }) : undefined,
        priceUsd: d.priceUsd,
        log: d.log,
        ...(opt as object),
      });
    }
    case "morpho":
    case "lista":
      return new MorphoBlueAdapter({
        env: d.evmEnv(l.chain),
        markets: l.pairs.map((p, i) => {
          if (!p.marketId) throw new Error(`morpho pair ${p.pairId}: marketId required`);
          return { pairId: p.pairId, marketId: p.marketId as Hex, collateral: wiring[i]!.collateral, debt: wiring[i]!.debt, lltv: (p as { lltv?: number }).lltv };
        }),
        priceUsd: d.priceUsd,
        morpho: l.addresses?.morpho as Address | undefined,
        flavor: l.type === "lista" ? "lista" : "morpho",
        protocol: l.protocol,
        swapper: d.swappers[l.chain],
        extraRewards: d.extraRewards,
        log: d.log,
        ...(opt as object),
      });
    case "scallop":
      return new ScallopAdapter({
        env: d.suiEnv(),
        pairs: l.pairs.map((p, i) => ({ pairId: p.pairId, collateral: wiring[i]!.collateral, debt: wiring[i]!.debt, obligationId: (p as { obligationId?: string }).obligationId })),
        swapper: d.suiPtbSwapper,
        extraRewards: d.extraRewards,
        sdkOptions: { pythApiKey: process.env.PYTH_API_KEY || undefined },
        ...(opt as object),
      });
    case "navi":
      return new NaviAdapter({
        env: d.suiEnv(),
        pairs: l.pairs.map((p, i) => ({
          pairId: p.pairId,
          collateral: wiring[i]!.collateral,
          debt: wiring[i]!.debt,
          market: p.market ?? l.market,
          emode: (p as { emode?: "auto" | "off" | number }).emode,
        })),
        swapper: d.suiPtbSwapper,
        extraRewards: d.extraRewards,
        log: d.log,
        ...(opt as object),
      });
    case "suilend":
      return new SuilendAdapter({
        env: d.suiEnv(),
        lendingMarket: l.market ?? "main",
        pairs: l.pairs.map((p, i) => ({ pairId: p.pairId, collateral: wiring[i]!.collateral, debt: wiring[i]!.debt })),
        swapper: d.suiPtbSwapper,
        extraRewards: d.extraRewards,
        priceUpdateSource: d.pythUpdates,
        log: d.log,
        ...(opt as object),
      });
    default:
      throw new Error(`lending type "${l.type}" is not wired in packages/live-runner/src/build.ts`);
  }
}
