import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { deepMerge, DEFAULT_CONFIG, validateConfig, type RouterConfig } from "./config.js";
import { PaperExecutor } from "./executor.js";
import { Router, type CycleReport } from "./monitor.js";
import { CollectingNotifier } from "./notify.js";
import { StaticSource, type StaticOppSpec, type StaticStreamSpec } from "./sources/static.js";
import type { Source, SourceContext } from "./sources/types.js";
import { MemoryStore, newState, sumIdle } from "./store.js";
import type { Opportunity, TokenProfile } from "./types.js";
import { PaperBridgeExecutor, type PaperBridgeBehavior } from "./xchain/paper.js";
import type { BridgeExecutor, RouteSpec } from "./xchain/types.js";

/**
 * Scenario = a scripted market timeline replayed through the real router with
 * a paper executor. Used both as tests and as a teaching tool
 * ("what would the bot have done in the Plasma / bank-run case?").
 */
export interface ScenarioPatch {
  capacity_usd?: number;
  streams?: Record<string, Partial<StaticStreamSpec>>;
  signals?: Record<string, number>;
  flags?: StaticOppSpec["flags"];
  metrics?: Record<string, number>;
  hidden?: boolean;
  health_value?: number;
}

export interface ScenarioEvent {
  at: number;
  note?: string;
  patch?: Record<string, ScenarioPatch>;
  tokens?: Record<string, Partial<TokenProfile>>;
  fail_exit_sim?: string[];
  fail_exit?: string[];
  /** Paper bridge behaviour per route id from this step on ("ok" | "stuck" | "fail" | "fail_refund" | "send_fail"). */
  bridge?: Record<string, PaperBridgeBehavior>;
}

/** Static spec + the asset that must be on hand to enter (defaults to `token` on `chain`). */
export type ScenarioOppSpec = StaticOppSpec & { funding_asset?: string };

export interface Scenario {
  name: string;
  /** Single idle bucket (legacy). Ignored when `idle` is given. */
  start_equity_usd?: number;
  /**
   * Idle USD per "chain:asset" (e.g. {"arbitrum:USDC": 150000}). Replaces
   * start_equity_usd and turns cross-chain funding on (xchain.enabled).
   */
  idle?: Record<string, number>;
  /** Extra routes appended to config xchain.routes (paper bridges are wired for every kind). */
  routes?: RouteSpec[];
  step_minutes: number;
  steps: number;
  start_at?: string;
  config?: unknown;
  tokens?: Record<string, TokenProfile>;
  opportunities: ScenarioOppSpec[];
  events?: ScenarioEvent[];
}

export interface ScenarioLine {
  step: number;
  note?: string;
  report: CycleReport;
  messages: { level: string; text: string }[];
}

export interface ScenarioResult {
  name: string;
  lines: ScenarioLine[];
  finalEquityUsd: number;
  startEquityUsd: number;
  finalPositions: { oppId: string; equityUsd: number }[];
  /** Idle per chain:asset at the end (empty in single-bucket scenarios). */
  finalIdle: Record<string, number>;
  finalInFlightUsd: number;
}

/** Sets `Opportunity.funding` from the spec's `funding_asset`. */
class FundingAssetSource implements Source {
  constructor(
    private readonly inner: StaticSource,
    private readonly fundingAsset: Record<string, { chain: string; asset: string }>
  ) {}
  get id(): string {
    return this.inner.id;
  }
  async fetch(ctx: SourceContext): Promise<Opportunity[]> {
    const out = await this.inner.fetch(ctx);
    for (const o of out) {
      const f = this.fundingAsset[o.id];
      if (f) o.funding = { ...f };
    }
    return out;
  }
}

export function loadScenario(path: string): Scenario {
  return parse(readFileSync(path, "utf8")) as Scenario;
}

function applyPatch(src: StaticSource, oppId: string, p: ScenarioPatch) {
  const spec = src.specs.find((s) => s.id === oppId);
  if (!spec) throw new Error(`scenario patch: unknown opportunity ${oppId}`);
  if (p.capacity_usd !== undefined) spec.capacity_usd = p.capacity_usd;
  for (const [label, sp] of Object.entries(p.streams ?? {})) {
    const s = spec.streams.find((x) => x.label === label);
    if (!s) throw new Error(`scenario patch: unknown stream ${oppId}.${label}`);
    Object.assign(s, sp);
  }
  for (const [name, v] of Object.entries(p.signals ?? {})) {
    const s = spec.signals?.find((x) => x.name === name);
    if (!s) throw new Error(`scenario patch: unknown signal ${oppId}.${name}`);
    s.value = v;
  }
  if (p.flags) spec.flags = p.flags;
  if (p.metrics) spec.metrics = { ...(spec.metrics ?? {}), ...p.metrics };
  if (p.health_value !== undefined && spec.health) spec.health.value = p.health_value;
  if (p.hidden !== undefined) {
    if (p.hidden) src.hidden.add(oppId);
    else src.hidden.delete(oppId);
  }
}

export async function runScenario(sc: Scenario): Promise<ScenarioResult> {
  const cfg: RouterConfig = deepMerge(DEFAULT_CONFIG, sc.config ?? {});
  const bucketed = !!sc.idle && Object.keys(sc.idle).length > 0;
  if (bucketed) cfg.xchain = { ...cfg.xchain, enabled: true };
  if (sc.routes?.length) cfg.xchain = { ...cfg.xchain, routes: [...cfg.xchain.routes, ...sc.routes] };
  const errs = validateConfig(cfg);
  if (errs.length) throw new Error("scenario config invalid: " + errs.join("; "));

  const start = sc.start_at ? Date.parse(sc.start_at) : Date.UTC(2026, 9, 1);
  const stepMs = sc.step_minutes * 60_000;
  let step = 0;
  const now = () => start + step * stepMs;

  const src = new StaticSource(sc.opportunities, "static", start);
  const fundingAsset: Record<string, { chain: string; asset: string }> = {};
  for (const o of sc.opportunities) if (o.funding_asset) fundingAsset[o.id] = { chain: o.chain, asset: o.funding_asset };
  const failSim = new Set<string>();
  const failExit = new Set<string>();
  const exec = new PaperExecutor({ failExitSim: (p) => failSim.has(p.oppId), failExit: (p) => failExit.has(p.oppId) });
  const startEquity = bucketed ? sumIdle(sc.idle!) : (sc.start_equity_usd ?? 0);
  const store = new MemoryStore(newState(startEquity, bucketed ? sc.idle : undefined));
  const bridgeBehavior: Record<string, PaperBridgeBehavior> = {};
  const paperBridge = new PaperBridgeExecutor(now, { behavior: (t) => bridgeBehavior[t.path[t.hop]?.id ?? ""] ?? "ok" });
  const bridges: Record<string, BridgeExecutor> = {};
  for (const r of cfg.xchain.routes) bridges[r.kind] = paperBridge;
  const notifier = new CollectingNotifier();
  const tokens: Record<string, TokenProfile> = structuredClone(sc.tokens ?? {});

  const router = new Router({
    cfg,
    sources: [Object.keys(fundingAsset).length ? new FundingAssetSource(src, fundingAsset) : src],
    executors: { static: exec },
    store,
    notifier,
    tokens: () => tokens,
    now,
    paperAccrual: true,
    bridges,
  });

  const lines: ScenarioLine[] = [];
  for (step = 0; step < sc.steps; step++) {
    const notes: string[] = [];
    for (const ev of (sc.events ?? []).filter((e) => e.at === step)) {
      if (ev.note) notes.push(ev.note);
      for (const [id, p] of Object.entries(ev.patch ?? {})) applyPatch(src, id, p);
      for (const [t, p] of Object.entries(ev.tokens ?? {})) tokens[t] = { ...(tokens[t] ?? {}), ...p };
      for (const id of ev.fail_exit_sim ?? []) failSim.add(id);
      for (const id of ev.fail_exit ?? []) failExit.add(id);
      Object.assign(bridgeBehavior, ev.bridge ?? {});
    }
    const before = notifier.messages.length;
    const report = await router.cycle();
    lines.push({ step, note: notes.join(" / ") || undefined, report, messages: notifier.messages.slice(before) });
  }
  const st = store.load();
  const last = lines[lines.length - 1]?.report;
  return {
    name: sc.name,
    lines,
    startEquityUsd: startEquity,
    finalEquityUsd: last?.totalEquityUsd ?? startEquity,
    finalPositions: st.positions.map((p) => ({ oppId: p.oppId, equityUsd: p.equityUsd })),
    finalIdle: { ...st.idle },
    finalInFlightUsd: last?.inFlightUsd ?? 0,
  };
}

const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const FUNDING_RULES = /\b(dest_apr|one_day_yield|payback|book_budget|min_move|in_flight|no enabled route|disabled|no idle bucket|after move cost)\b/g;

export function formatScenario(r: ScenarioResult, verbose = false): string {
  const out = [`# ${r.name}`];
  // funding refusals are printed when they start or their rule changes, not every step
  const lastFunding: Record<string, string> = {};
  for (const l of r.lines) {
    const acts = l.report.executed.filter((x) => verbose || x.action.type !== "claim");
    const refusals: string[] = [];
    for (const [id, reasons] of Object.entries(l.report.allocationRejected ?? {})) {
      const f = reasons.find((x) => x.startsWith("funding"));
      if (!f) continue;
      const key = [...new Set(f.match(FUNDING_RULES) ?? ["?"])].join(",");
      if (lastFunding[id] === key) continue;
      lastFunding[id] = key;
      refusals.push(`   ✗ NO MOVE for ${id}: ${f}`);
    }
    const xf = l.report.transfers ?? [];
    if (!l.note && !acts.length && !xf.length && !refusals.length && !l.messages.some((m) => m.level !== "info")) continue;
    const buckets = Object.entries(l.report.idle ?? {});
    const idleTxt = buckets.length
      ? `  | idle ${buckets.map(([k, v]) => `${k} ${usd(v)}`).join(", ")}${l.report.inFlightUsd > 0 ? ` | in flight ${usd(l.report.inFlightUsd)}` : ""}`
      : "";
    out.push(`step ${l.step}${l.note ? `  [${l.note}]` : ""}  equity $${Math.round(l.report.totalEquityUsd)}${idleTxt}`);
    const xfLine = (t: (typeof xf)[number]) => {
      const what =
        t.kind === "sent"
          ? `BRIDGE ${usd(t.amountUsd)} ${t.from} -> ${t.to} via ${t.route}${t.forOppId ? ` for ${t.forOppId}` : ""} (all-in cost $${(t.costUsd ?? 0).toFixed(2)})`
          : t.kind === "arrived"
            ? `ARRIVED ${usd(t.amountUsd)} on ${t.to}${t.forOppId ? ` (for ${t.forOppId})` : ""}`
            : `${t.kind.toUpperCase()} ${t.id} ${usd(t.amountUsd)} ${t.from} -> ${t.to}${t.detail ? `: ${t.detail}` : ""}`;
      return `   ⇄ ${what}`;
    };
    // cycle order: transfers are polled first (arrivals), sends happen during allocation
    const early = xf.filter((t) => t.kind !== "sent" && t.kind !== "send_failed");
    const late = xf.filter((t) => t.kind === "sent" || t.kind === "send_failed");
    out.push(...early.map(xfLine));
    for (const a of acts) {
      const x = a.action;
      const desc =
        x.type === "enter"
          ? `ENTER ${x.oppId} +$${Math.round(x.deltaUsd)} (net ${(x.netApr * 100).toFixed(2)}%)${x.funding?.source ? ` from ${x.funding.source.chain}:${x.funding.source.asset}` : ""}`
          : x.type === "exit"
            ? `${x.fraction >= 1 ? "EXIT" : `TRIM ${(x.fraction * 100).toFixed(0)}%`} ${x.oppId}${x.urgent ? " URGENT" : ""}: ${x.reason}`
            : x.type === "sell"
              ? `SELL ${x.token} $${Math.round(x.amountUsd)} (${x.reason})`
              : x.type === "claim"
                ? `CLAIM ${x.token} $${Math.round(x.amountUsd)} (${x.reason})`
                : x.type === "hedge"
                  ? `HEDGE ${x.token} -> $${Math.round(x.targetShortUsd)}`
                  : x.type === "rebalance"
                    ? `REBALANCE ${x.oppId}: ${x.reason}`
                    : x.type;
      out.push(`   ${a.ok ? "✓" : "✗"} ${desc}`);
    }
    out.push(...late.map(xfLine));
    out.push(...refusals);
    for (const m of l.messages.filter((m) => m.level !== "info")) out.push(`   [${m.level}] ${m.text}`);
  }
  const pnl = r.finalEquityUsd - r.startEquityUsd;
  out.push(`final equity $${Math.round(r.finalEquityUsd)} (${pnl >= 0 ? "+" : ""}${Math.round(pnl)})`);
  const fi = Object.entries(r.finalIdle);
  if (fi.length) out.push(`final idle: ${fi.map(([k, v]) => `${k} ${usd(v)}`).join(", ")}${r.finalInFlightUsd > 0 ? `; in flight ${usd(r.finalInFlightUsd)}` : ""}`);
  for (const p of r.finalPositions) if (fi.length) out.push(`  ${p.oppId} ${usd(p.equityUsd)}`);
  return out.join("\n");
}
