/**
 * Merkl campaign reward rates for one lending market side (RewardRateProvider).
 *
 * API (read 2026-10-29):
 *   GET https://api.merkl.xyz/v4/opportunities?chainId={id}&mainProtocolId={p}&status=LIVE&campaigns=true&items=100&page={n}
 *   GET https://api.merkl.xyz/v4/opportunities/{id}?campaigns=true   (only when the list lacks campaigns)
 *   SOURCE: https://developers.merkl.xyz/api-reference/get/v4/opportunities
 *           https://developers.merkl.xyz/integrate-merkl/campaigns ("?campaigns=true")
 *   Opportunity fields used: id, type, identifier, explorerAddress, action (LEND|BORROW), status, chainId,
 *     tvl (USD), dailyRewards (USD/day), latestCampaignEnd (unix s), protocol.id / mainProtocol,
 *     rewardsRecord.breakdowns[].token, campaigns[]
 *   Campaign fields used: campaignId, type, startTimestamp, endTimestamp (unix s), dailyRewards (USD/day),
 *     rewardToken.{address,symbol,type}, params.{targetToken, lendingToken, underlyingToken, tokens[], borrowTokens[],
 *     hubs[].{hubAddress, assets[].{assetId, underlyingToken, symbol}}, lendingAssetIds, supplyAssetIds, borrowAssetIds,
 *     hooks[].{hookType, healthFactorThreshold, borrowBytesLike}, whitelist, blacklist,
 *     distributionMethodParameters.distributionSettings.{assetId, targetAPR, apr}}
 *   (params shapes observed live on opportunities 8495869860536674397, 13158230964923482281,
 *    16069439808187088621 and the chainId=1 aave list; they are not in Merkl's static schema docs.)
 *
 * APR = campaign.dailyRewards * 365 / opportunity.tvl (a yearly APR on the pool side, not APY).
 *
 * Matching is deliberately conservative: an opportunity is used only when its
 * receipt-token identifier (explorerAddress / params.targetToken / lendingToken,
 * or an Aave v4 hub address) equals an identifier the caller supplied for the
 * market side (query.marketId or opts.resolveKeys). The bare underlying asset
 * address is never enough (several Aave v3 markets list the same underlying).
 */
import { chainInfo, type Logger, type RewardRateProvider, type RewardRateQuery } from "@incentive-router/live-common";
import type { RewardRate } from "@incentive-router/core";
import { arr, defaultFetch, httpJson, lc, num, obj, str, type HttpFetch, type J } from "../swap/http.js";

/**
 * RewardRate plus Merkl campaign conditions. netOf / perUserCapUsd / maxHealthFactor
 * are the core RewardRate fields (restated so this compiles against either core
 * version); aprCap / ineligibleIfBorrowing / note / merkl are extras the core
 * does not read yet.
 */
export type MerklRewardRate = RewardRate & {
  /** Rewards are paid on (this side) MINUS the listed assets on the other side. ["*"] = netting set unknown/all stables. */
  netOf?: string[];
  /** Eligible position size cap per user (USD). */
  perUserCapUsd?: number;
  /** Only positions with health factor <= this are rewarded ("looping required"). */
  maxHealthFactor?: number;
  /** Campaign APR ceiling (MAX_APR / targetAPR mode), yearly fraction. */
  aprCap?: number;
  /** Borrowing any of these debt tokens (lowercase addresses) makes the position ineligible. */
  ineligibleIfBorrowing?: string[];
  note?: string;
  merkl?: { opportunityId: string; campaignId?: string; type: string };
};

export interface MerklProtocolRule {
  /** Merkl mainProtocolId filter. */
  mainProtocolId: string;
  /** Opportunity / campaign `type` must match. */
  typePattern?: RegExp;
  /** Query side "collateral" may use LEND campaigns (collateral is a supply position: Aave, Euler). */
  collateralIsSupply?: boolean;
  matcher: "receipt" | "aave-v4-hub";
}

/** Query protocol id (core venue) -> Merkl filter + matching rule. Morpho/Euler ids: VERIFY_LIVE. */
export const DEFAULT_MERKL_PROTOCOLS: Record<string, MerklProtocolRule> = {
  "aave-v3": { mainProtocolId: "aave", typePattern: /^AAVE_(?!V4)/, collateralIsSupply: true, matcher: "receipt" },
  "aave-v4": { mainProtocolId: "aave", typePattern: /^AAVE_V4/, collateralIsSupply: true, matcher: "aave-v4-hub" },
  morpho: { mainProtocolId: "morpho", typePattern: /^MORPHO/, collateralIsSupply: false, matcher: "receipt" },
  "euler-v2": { mainProtocolId: "euler", typePattern: /^EULER/, collateralIsSupply: true, matcher: "receipt" },
  // Fluid fTokens (ERC-4626 vault adapter). No type filter: Fluid campaign type names are not
  // pinned yet, so matching relies on the receipt (fToken address) alone. VERIFY_LIVE.
  fluid: { mainProtocolId: "fluid", collateralIsSupply: true, matcher: "receipt" },
};

export interface MerklRateProviderOptions {
  /** Default https://api.merkl.xyz/v4 */
  baseUrl?: string;
  apiKey?: string;
  protocols?: Record<string, MerklProtocolRule>;
  /** Response cache TTL. Default 10 min. */
  cacheMinutes?: number;
  /** Pages of 100 opportunities per (chain, protocol). Default 5. */
  maxPages?: number;
  timeoutMs?: number;
  /**
   * Identifiers of the queried market side, in addition to query.marketId:
   * Aave v3 aToken (supply/collateral) or variableDebtToken (borrow); Aave v4 hub
   * address; Euler vault; Morpho market id / vault. Without one, nothing matches.
   */
  resolveKeys?: (q: RewardRateQuery) => string[] | Promise<string[]>;
  /** Our address: campaigns whose whitelist excludes it, or whose blacklist includes it, are skipped. */
  owner?: string;
  /** Reward token address (lowercase) -> symbol to report (e.g. a Merkl-wrapped aToken -> "USDe"). */
  rewardSymbols?: Record<string, string>;
  /** Rates above this APR are treated as garbage. Default 5 (500 %). */
  maxApr?: number;
  fetch?: HttpFetch;
  now?: () => number;
  log?: Logger;
}

/** Underlying symbols used to strip Aave receipt-token prefixes (aPlaUSDe -> USDe, variableDebtHorRwaRLUSD -> RLUSD). */
const KNOWN_UNDERLYINGS = [
  "USDC", "USDT", "USDT0", "USDe", "sUSDe", "GHO", "RLUSD", "USDG", "frxUSD", "sfrxUSD", "DAI", "sDAI", "USDS", "sUSDS", "PYUSD",
  "FDUSD", "LUSD", "crvUSD", "USDtb", "USD1", "EURC", "USDC.e", "USDbC", "AUSD", "USDai", "syrupUSDC", "USR", "mUSD",
  "WETH", "ETH", "wstETH", "weETH", "rsETH", "ezETH", "cbETH", "rETH", "WBTC", "cbBTC", "tBTC", "LBTC",
  "WXPL", "XPL", "WAVAX", "WPOL", "WMATIC", "WBNB", "wS", "WHYPE", "LINK", "AAVE", "ARB", "OP",
];

/** Strip an Aave receipt prefix ("a<Market>", "variableDebt<Market>") and return the underlying symbol, or undefined. */
export function underlyingOfReceiptSymbol(sym: string, extra: string[] = []): string | undefined {
  let rest: string;
  if (sym.startsWith("variableDebt")) rest = sym.slice("variableDebt".length);
  else if (sym.startsWith("stableDebt")) rest = sym.slice("stableDebt".length);
  else if (/^a[A-Z]/.test(sym)) rest = sym.slice(1);
  else return undefined;
  const cands = [...new Set([...extra, ...KNOWN_UNDERLYINGS].filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const c of cands) {
    if (rest === c) return c;
    if (rest.endsWith(c) && /^[A-Z][A-Za-z]*$/.test(rest.slice(0, rest.length - c.length))) return c;
  }
  return undefined;
}

const isHexId = (s: string | undefined): s is string => !!s && /^0x([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(s);
const nowSec = (ms: number) => Math.floor(ms / 1000);

interface Ctx {
  q: RewardRateQuery;
  keys: Set<string>;
  actions: string[];
  rule: MerklProtocolRule;
  nowMs: number;
  owner?: string;
}

function hubAssets(params: J): { hub: string; assets: Map<string, { underlying: string; symbol?: string }> }[] {
  return arr(params.hubs).flatMap((h) => {
    const ho = obj(h);
    const hub = str(ho?.hubAddress);
    if (!ho || !hub) return [];
    const assets = new Map<string, { underlying: string; symbol?: string }>();
    for (const a of arr(ho.assets)) {
      const ao = obj(a);
      const id = ao?.assetId !== undefined ? String(ao.assetId) : undefined;
      const u = str(ao?.underlyingToken);
      if (id !== undefined && u) assets.set(id, { underlying: lc(u), symbol: str(ao?.symbol) });
    }
    return [{ hub: lc(hub), assets }];
  });
}

const ids = (v: unknown): string[] => arr(v).map((x) => String(x));

/** Asset ids a v4 campaign pays on, and the ids it nets against. */
function v4Sides(type: string, params: J, action: string): { paid: string[]; netted: string[] } {
  const ds = obj(obj(params.distributionMethodParameters)?.distributionSettings);
  const lending = ids(params.lendingAssetIds).length ? ids(params.lendingAssetIds) : ids(params.supplyAssetIds);
  const borrowing = ids(params.borrowAssetIds);
  const single = ds?.assetId !== undefined ? [String(ds.assetId)] : undefined;
  if (action === "BORROW") return { paid: single ?? borrowing, netted: /NET/.test(type) ? lending : [] };
  return { paid: single ?? lending, netted: /NET/.test(type) ? borrowing : [] };
}

function findNumericKeys(v: unknown, test: (k: string) => boolean, depth = 0, out: number[] = []): number[] {
  if (depth > 4) return out;
  const o = obj(v);
  if (o) {
    for (const [k, x] of Object.entries(o)) {
      const n = num(x);
      if (test(k) && n !== undefined && n > 0) out.push(n);
      else findNumericKeys(x, test, depth + 1, out);
    }
  } else for (const x of arr(v)) findNumericKeys(x, test, depth + 1, out);
  return out;
}

/** A RewardRateProvider whose rates carry the Merkl-specific extras; `clearCache()` drops cached API responses. */
export type MerklRewardRateProvider = ((q: RewardRateQuery) => Promise<MerklRewardRate[]>) & { clearCache(): void };

export function merklRewardRateProvider(opts: MerklRateProviderOptions = {}): MerklRewardRateProvider {
  const base = (opts.baseUrl ?? "https://api.merkl.xyz/v4").replace(/\/+$/, "");
  const fetchImpl = opts.fetch ?? defaultFetch;
  const now = opts.now ?? Date.now;
  const ttl = (opts.cacheMinutes ?? 10) * 60_000;
  const protocols = opts.protocols ?? DEFAULT_MERKL_PROTOCOLS;
  const headers = opts.apiKey ? { "X-API-Key": opts.apiKey } : undefined;
  const cache = new Map<string, { at: number; p: Promise<unknown> }>();
  const log: Logger = opts.log ?? (() => {});

  const cachedJson = (url: string): Promise<unknown> => {
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttl) return hit.p;
    const p = httpJson(fetchImpl, url, { headers, timeoutMs: opts.timeoutMs });
    cache.set(url, { at: now(), p });
    p.catch(() => cache.delete(url));
    return p;
  };

  const listOpps = async (chainId: number, pid: string): Promise<J[]> => {
    const out: J[] = [];
    const maxPages = opts.maxPages ?? 5;
    for (let page = 0; page < maxPages; page++) {
      const url = `${base}/opportunities?chainId=${chainId}&mainProtocolId=${encodeURIComponent(pid)}&status=LIVE&campaigns=true&items=100&page=${page}`;
      const j = await cachedJson(url);
      if (!Array.isArray(j)) throw new Error(`merkl opportunities: unexpected response shape from ${url}`);
      for (const it of j) {
        const o = obj(it);
        if (o) out.push(o);
      }
      if (j.length < 100) break;
    }
    return out;
  };

  const campaignsOf = async (opp: J): Promise<J[] | undefined> => {
    if (Array.isArray(opp.campaigns)) return opp.campaigns.map(obj).filter((x): x is J => !!x);
    const id = str(opp.id);
    if (!id) return undefined;
    const d = obj(await cachedJson(`${base}/opportunities/${encodeURIComponent(id)}?campaigns=true`));
    return Array.isArray(d?.campaigns) ? d!.campaigns.map(obj).filter((x): x is J => !!x) : undefined;
  };

  const symbolOf = (addrSymbols: Map<string, string>, a: string, extra: string[]): string | undefined => {
    const s = addrSymbols.get(lc(a));
    return s ? underlyingOfReceiptSymbol(s, extra) ?? (/^(a[A-Z]|variableDebt)/.test(s) ? undefined : s) : undefined;
  };

  /** Rates for one matched campaign, or null when it is not live / not eligible. */
  const campaignRate = (c: Ctx, opp: J, camp: J | undefined, v4?: { hub: { hub: string; assets: Map<string, { underlying: string; symbol?: string }> }; netted: string[] }): MerklRewardRate | null => {
    const type = str(camp?.type) ?? str(opp.type) ?? "?";
    const params = obj(camp?.params) ?? {};
    const tvl = num(opp.tvl);
    if (!(tvl !== undefined && tvl > 0)) return null;
    let daily: number | undefined;
    let endSec: number | undefined;
    let rewardTok: J | undefined;
    if (camp) {
      const start = num(camp.startTimestamp);
      const end = num(camp.endTimestamp);
      const t = nowSec(c.nowMs);
      if (start === undefined || end === undefined || !(start <= t && t < end)) return null;
      daily = num(camp.dailyRewards);
      endSec = end;
      rewardTok = obj(camp.rewardToken);
    } else {
      daily = num(opp.dailyRewards);
      endSec = num(opp.latestCampaignEnd);
      rewardTok = obj(obj(arr(obj(opp.rewardsRecord)?.breakdowns)[0])?.token);
    }
    if (!(daily !== undefined && daily > 0)) return null;
    const rtType = str(rewardTok?.type);
    if (rtType === "POINT" || rtType === "PRETGE") return null; // no reliable USD value
    // eligibility lists
    const wl = arr(params.whitelist).map((x) => lc(str(x)));
    const bl = arr(params.blacklist).map((x) => lc(str(x)));
    if (wl.length && (!c.owner || !wl.includes(lc(c.owner)))) return null;
    if (c.owner && bl.includes(lc(c.owner))) return null;

    const apr = (daily * 365) / tvl;
    if (apr > (opts.maxApr ?? 5)) {
      log("warn", `merkl: dropping implausible APR ${apr} on opportunity ${String(opp.id)}`);
      return null;
    }
    const notes: string[] = [];
    // reward token symbol (aTokens reported as their underlying)
    const extraSyms = [c.q.asset.symbol, str(params.symbolUnderlyingToken) ?? ""];
    const rAddr = lc(str(rewardTok?.address));
    const rSym = str(rewardTok?.symbol) ?? str(params.symbolRewardToken) ?? "MERKL_REWARD";
    let token = (rAddr && opts.rewardSymbols?.[rAddr]) || undefined;
    if (!token) {
      const u = underlyingOfReceiptSymbol(rSym, extraSyms);
      token = u ?? rSym;
      if (u) notes.push(`paid in ${rSym} (Aave receipt of ${u})`);
    }
    const rate: MerklRewardRate = {
      token,
      apr,
      endsAtMs: endSec !== undefined && endSec > 0 ? (endSec < 1e12 ? endSec * 1000 : endSec) : null,
      merkl: { opportunityId: String(opp.id ?? "?"), campaignId: str(camp?.campaignId) ?? (camp?.id !== undefined ? String(camp.id) : undefined), type },
    };
    // netting
    if (/NET_(LENDING|BORROWING)/.test(type)) {
      let net: string[] | undefined;
      if (v4) {
        const syms = v4.netted.map((id) => v4.hub.assets.get(id)?.symbol);
        net = syms.length && syms.every((s): s is string => !!s) ? syms : undefined;
      } else {
        const addrSymbols = new Map<string, string>();
        for (const t of arr(params.tokens)) {
          const to = obj(t);
          const a = str(to?.address);
          const s = str(to?.symbol);
          if (a && s) addrSymbols.set(lc(a), s);
        }
        const nettedAddrs = (/NET_LENDING/.test(type) ? arr(params.borrowTokens) : arr(params.lendingTokens ?? params.supplyTokens)).map((x) => str(x));
        const syms = nettedAddrs.map((a) => (a ? symbolOf(addrSymbols, a, extraSyms) : undefined));
        net = syms.length && syms.every((s): s is string => !!s) ? syms : undefined;
      }
      rate.netOf = net ? [...new Set(net)] : ["*"];
      if (!net) notes.push("net campaign: netting set not parsed, assume all stables");
    }
    // hooks
    const unknownHooks: string[] = [];
    for (const h of arr(params.hooks)) {
      const ho = obj(h);
      const ht = num(ho?.hookType);
      const hf = num(ho?.healthFactorThreshold);
      const borrowBl = arr(ho?.borrowBytesLike).map((x) => lc(str(x))).filter(Boolean);
      if (hf !== undefined) rate.maxHealthFactor = Math.min(rate.maxHealthFactor ?? Infinity, hf);
      else if (borrowBl.length) rate.ineligibleIfBorrowing = [...new Set([...(rate.ineligibleIfBorrowing ?? []), ...borrowBl])];
      else unknownHooks.push(String(ht ?? "?"));
    }
    if (rate.maxHealthFactor !== undefined) notes.push(`requires health factor <= ${rate.maxHealthFactor} (looping)`);
    if (rate.ineligibleIfBorrowing) notes.push(`ineligible while borrowing ${rate.ineligibleIfBorrowing.join(",")}`);
    if (unknownHooks.length) notes.push(`unparsed hook types ${unknownHooks.join(",")} — extra eligibility conditions`);
    // caps
    const caps = findNumericKeys(params, (k) => /cap/i.test(k) && /usd/i.test(k));
    if (caps.length) rate.perUserCapUsd = Math.min(...caps);
    const ds = obj(obj(params.distributionMethodParameters)?.distributionSettings);
    const aprCap = num(ds?.targetAPR) ?? num(ds?.apr);
    if (aprCap !== undefined && aprCap > 0) rate.aprCap = aprCap;
    if (notes.length) rate.note = notes.join("; ");
    return rate;
  };

  const matchReceipt = (c: Ctx, opp: J, camp: J | undefined): boolean => {
    const params = obj(camp?.params) ?? {};
    const action = str(opp.action) ?? "";
    const cands = [str(opp.explorerAddress), isHexId(str(opp.identifier)) ? str(opp.identifier) : undefined, str(params.targetToken)];
    if (action === "LEND") cands.push(str(params.lendingToken));
    if (!cands.some((a) => !!a && c.keys.has(lc(a)))) return false;
    const u = str(params.underlyingToken);
    if (u && lc(u) !== lc(c.q.asset.address)) return false; // receipt matched but for a different underlying: refuse
    return true;
  };

  const fn = async (q: RewardRateQuery): Promise<MerklRewardRate[]> => {
    const rule = protocols[q.protocol];
    if (!rule) return [];
    let chainId: number | undefined;
    try {
      chainId = chainInfo(q.chain).evmChainId;
    } catch {
      return [];
    }
    if (chainId === undefined) return [];
    const actions = q.side === "borrow" ? ["BORROW"] : q.side === "supply" || rule.collateralIsSupply ? ["LEND"] : [];
    if (!actions.length) return [];
    const extra = opts.resolveKeys ? await opts.resolveKeys(q) : [];
    const keys = new Set([q.marketId, ...extra].filter((x): x is string => !!x).map(lc));
    if (!keys.size) return [];
    const c: Ctx = { q, keys, actions, rule, nowMs: now(), owner: opts.owner };
    const out: MerklRewardRate[] = [];
    for (const opp of await listOpps(chainId, rule.mainProtocolId)) {
      if (str(opp.status) && opp.status !== "LIVE") continue;
      if (num(opp.chainId) !== undefined && num(opp.chainId) !== chainId) continue;
      const type = str(opp.type) ?? "";
      if (rule.typePattern && !rule.typePattern.test(type)) continue;
      if (!actions.includes(str(opp.action) ?? "")) continue;
      const proto = str(obj(opp.protocol)?.id) ?? str(opp.mainProtocol);
      if (proto && lc(proto) !== lc(rule.mainProtocolId)) continue;

      const listed = Array.isArray(opp.campaigns) ? opp.campaigns.map(obj).filter((x): x is J => !!x) : undefined;
      if (rule.matcher === "receipt") {
        let camps = listed;
        if (!camps) {
          // list came without campaigns: only fetch details for opportunities whose own ids already match
          if (!matchReceipt(c, opp, undefined)) continue;
          camps = await campaignsOf(opp);
        }
        if (!camps?.length) {
          if (!matchReceipt(c, opp, undefined)) continue;
          const r = campaignRate(c, opp, undefined);
          if (r) out.push(r);
          continue;
        }
        for (const k of camps) {
          const kt = str(k.type);
          if (rule.typePattern && kt && !rule.typePattern.test(kt)) continue;
          if (!matchReceipt(c, opp, k)) continue;
          const r = campaignRate(c, opp, k);
          if (r) out.push(r);
        }
      } else {
        let camps = listed;
        if (!camps) {
          // hub/asset can only be matched from campaign params; fetch details only when the asset is listed
          if (!arr(opp.tokens).some((t) => lc(str(obj(t)?.address)) === lc(q.asset.address))) continue;
          camps = await campaignsOf(opp);
        }
        if (!camps) continue;
        const action = str(opp.action) ?? "";
        for (const k of camps) {
          const params = obj(k.params) ?? {};
          const kType = str(k.type) ?? type;
          const hubs = hubAssets(params).filter((h) => keys.has(h.hub));
          if (hubs.length !== 1) continue;
          const hub = hubs[0]!;
          const { paid, netted } = v4Sides(kType, params, action);
          if (!paid.some((id) => hub.assets.get(id)?.underlying === lc(q.asset.address))) continue;
          const r = campaignRate(c, opp, k, { hub, netted });
          if (r) out.push(r);
        }
      }
    }
    return out;
  };

  return Object.assign(fn, { clearCache: () => cache.clear() });
}

// compile-time check: usable wherever the core expects a RewardRateProvider
const _assignable: (p: MerklRewardRateProvider) => RewardRateProvider = (p) => p;
void _assignable;
