import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { deepMerge, DEFAULT_CONFIG, validateConfig, type RouterConfig } from "./config.js";
import { PaperExecutor } from "./executor.js";
import { Router, type CycleReport } from "./monitor.js";
import { CollectingNotifier } from "./notify.js";
import { StaticSource, type StaticOppSpec, type StaticStreamSpec } from "./sources/static.js";
import { MemoryStore, newState } from "./store.js";
import type { TokenProfile } from "./types.js";

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
}

export interface Scenario {
  name: string;
  start_equity_usd: number;
  step_minutes: number;
  steps: number;
  start_at?: string;
  config?: unknown;
  tokens?: Record<string, TokenProfile>;
  opportunities: StaticOppSpec[];
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
  const errs = validateConfig(cfg);
  if (errs.length) throw new Error("scenario config invalid: " + errs.join("; "));

  const start = sc.start_at ? Date.parse(sc.start_at) : Date.UTC(2026, 9, 1);
  const stepMs = sc.step_minutes * 60_000;
  let step = 0;
  const now = () => start + step * stepMs;

  const src = new StaticSource(sc.opportunities, "static", start);
  const failSim = new Set<string>();
  const failExit = new Set<string>();
  const exec = new PaperExecutor({ failExitSim: (p) => failSim.has(p.oppId), failExit: (p) => failExit.has(p.oppId) });
  const store = new MemoryStore(newState(sc.start_equity_usd));
  const notifier = new CollectingNotifier();
  const tokens: Record<string, TokenProfile> = structuredClone(sc.tokens ?? {});

  const router = new Router({
    cfg,
    sources: [src],
    executors: { static: exec },
    store,
    notifier,
    tokens: () => tokens,
    now,
    paperAccrual: true,
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
    }
    const before = notifier.messages.length;
    const report = await router.cycle();
    lines.push({ step, note: notes.join(" / ") || undefined, report, messages: notifier.messages.slice(before) });
  }
  const st = store.load();
  return {
    name: sc.name,
    lines,
    startEquityUsd: sc.start_equity_usd,
    finalEquityUsd: lines[lines.length - 1]?.report.totalEquityUsd ?? sc.start_equity_usd,
    finalPositions: st.positions.map((p) => ({ oppId: p.oppId, equityUsd: p.equityUsd })),
  };
}

export function formatScenario(r: ScenarioResult, verbose = false): string {
  const out = [`# ${r.name}`];
  for (const l of r.lines) {
    const acts = l.report.executed.filter((x) => verbose || x.action.type !== "claim");
    if (!l.note && !acts.length && !l.messages.some((m) => m.level !== "info")) continue;
    out.push(`step ${l.step}${l.note ? `  [${l.note}]` : ""}  equity $${Math.round(l.report.totalEquityUsd)}`);
    for (const a of acts) {
      const x = a.action;
      const desc =
        x.type === "enter"
          ? `ENTER ${x.oppId} +$${Math.round(x.deltaUsd)} (net ${(x.netApr * 100).toFixed(2)}%)`
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
    for (const m of l.messages.filter((m) => m.level !== "info")) out.push(`   [${m.level}] ${m.text}`);
  }
  const pnl = r.finalEquityUsd - r.startEquityUsd;
  out.push(`final equity $${Math.round(r.finalEquityUsd)} (${pnl >= 0 ? "+" : ""}${Math.round(pnl)})`);
  return out.join("\n");
}
