#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { planAllocation } from "./allocator.js";
import { loadConfig, type RouterConfig } from "./config.js";
import { PaperExecutor } from "./executor.js";
import { computeExposure } from "./exposure.js";
import type { DecisionContext } from "./gates/common.js";
import { checkSizedEntry, entryBlockers } from "./gates/entry.js";
import { Router } from "./monitor.js";
import { ConsoleNotifier, MultiNotifier, TelegramNotifier, type Notifier } from "./notify.js";
import { formatScenario, loadScenario, runScenario } from "./scenario.js";
import { newHistory } from "./signals.js";
import { checkMerklShape, MerklSource } from "./sources/merkl.js";
import { DefiLlamaSource } from "./sources/defillama.js";
import { StaticSource, type StaticOppSpec } from "./sources/static.js";
import type { FetchLike, Source, SourceContext } from "./sources/types.js";
import { FileStore } from "./store.js";
import { venueTier } from "./tiers.js";
import type { Opportunity, TokenProfile } from "./types.js";
import { valueAt } from "./valuation.js";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Flags } {
  const [cmd = "help", ...rest] = argv;
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

const s = (f: Flags, k: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : undefined);

/** A FetchLike that serves local JSON files (offline fixtures), routed by URL substring. */
function fileFetch(routes: Record<string, string | undefined>, fallback: string): FetchLike {
  return async (url: string) => {
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const path = hit ? hit[1] : fallback;
    if (!path) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(path, "utf8")) };
  };
}

function buildSources(f: Flags): Source[] {
  const out: Source[] = [];
  const staticPath = s(f, "static");
  if (staticPath) {
    const doc = parse(readFileSync(staticPath, "utf8")) as { opportunities: StaticOppSpec[] };
    out.push(new StaticSource(doc.opportunities ?? []));
  }
  const merkl = s(f, "merkl-fixture");
  if (merkl) out.push(new MerklSource({}, fileFetch({}, merkl)));
  else if (f["live"]) out.push(new MerklSource({ apiKey: process.env.MERKL_API_KEY }));
  const llama = s(f, "llama-fixture");
  if (llama) {
    const lb = s(f, "llama-lendborrow-fixture");
    out.push(new DefiLlamaSource({}, fileFetch({ lendBorrow: lb ?? "" }, llama)));
  }
  else if (f["live"]) out.push(new DefiLlamaSource({}));
  return out;
}

function loadTokens(f: Flags): Record<string, TokenProfile> {
  const p = s(f, "tokens");
  return p ? ((parse(readFileSync(p, "utf8")) as { tokens?: Record<string, TokenProfile> }).tokens ?? {}) : {};
}

async function fetchAll(sources: Source[], ctx: SourceContext): Promise<Opportunity[]> {
  const res = await Promise.allSettled(sources.map((x) => x.fetch(ctx)));
  const out: Opportunity[] = [];
  res.forEach((r, i) => {
    if (r.status === "fulfilled") out.push(...r.value);
    else console.error(`source ${sources[i]!.id} failed: ${(r.reason as Error).message}`);
  });
  return out;
}

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : "n/a");

async function cmdScan(cfg: RouterConfig, f: Flags) {
  const now = Date.now();
  const equity = Number(s(f, "equity") ?? 100_000);
  const probe = Number(s(f, "probe") ?? 10_000);
  const tokens = loadTokens(f);
  const sources = buildSources(f);
  if (!sources.length) throw new Error("no sources: pass --static <yaml>, --merkl-fixture/--llama-fixture <json> or --live");
  const opps = await fetchAll(sources, { cfg, nowMs: now, myEquityByOpp: {} });
  const ctx: DecisionContext = {
    cfg,
    nowMs: now,
    tokens,
    totalEquityUsd: equity,
    positions: [],
    exposure: computeExposure([]),
    history: newHistory(),
    cooldownUntil: {},
    paused: false,
    idleUsd: equity,
    hedges: {},
  };
  const rows = opps.map((o) => {
    const v = valueAt(o, probe, ctx);
    const blockers = entryBlockers(o, ctx).filter((b) => !b.startsWith("discovery only"));
    const sized = checkSizedEntry(o, 0, probe, ctx);
    return { o, v, ok: !blockers.length && sized.ok, reasons: [...blockers, ...sized.reasons] };
  });
  rows.sort((a, b) => b.v.netApr - a.v.netApr);
  const top = Number(s(f, "top") ?? 30);
  if (f["json"]) {
    console.log(
      JSON.stringify(
        rows.slice(0, top).map((r) => ({
          id: r.o.id,
          kind: r.o.kind,
          venue: r.o.primaryVenue,
          tier: venueTier(cfg, r.o.primaryVenue),
          netApr: r.v.netApr,
          rawApr: r.v.rawApr,
          speculativeApr: r.v.speculativeApr,
          discoveryOnly: !!r.o.discoveryOnly,
          passes: r.ok,
          reasons: r.reasons,
        })),
        null,
        2
      )
    );
    return;
  }
  console.log(`probe size $${probe} on equity $${equity}; ${opps.length} opportunities, showing ${Math.min(top, rows.length)}\n`);
  for (const r of rows.slice(0, top)) {
    const t = venueTier(cfg, r.o.primaryVenue);
    console.log(
      `${r.ok ? "PASS" : "----"} net ${pct(r.v.netApr).padStart(8)} raw ${pct(r.v.rawApr).padStart(8)} T${t} ${r.o.kind.padEnd(18)} ${r.o.name}${r.o.discoveryOnly ? "  [discovery]" : ""}`
    );
    if (!r.ok && f["why"]) for (const x of r.reasons.slice(0, 4)) console.log(`        - ${x}`);
  }
}

function makeNotifier(cfg: RouterConfig): { notifier: Notifier; tg?: TelegramNotifier } {
  const tokEnv = cfg.telegram?.bot_token_env ?? "TG_BOT_TOKEN";
  const chatEnv = cfg.telegram?.chat_id_env ?? "TG_CHAT_ID";
  const tok = process.env[tokEnv];
  const chat = process.env[chatEnv];
  if (tok && chat) {
    const tg = new TelegramNotifier(tok, chat);
    return { notifier: new MultiNotifier([new ConsoleNotifier(), tg]), tg };
  }
  return { notifier: new ConsoleNotifier() };
}

async function cmdPlan(cfg: RouterConfig, f: Flags) {
  const dir = s(f, "state") ?? "state";
  const store = new FileStore(`${dir}/state.json`, `${dir}/journal.jsonl`, Number(s(f, "equity") ?? 100_000));
  const st = store.load();
  const now = Date.now();
  const my: Record<string, number> = {};
  for (const p of st.positions) my[p.oppId] = p.equityUsd;
  const opps = await fetchAll(buildSources(f), { cfg, nowMs: now, myEquityByOpp: my });
  if (f["paper"]) for (const o of opps) if (o.sourceId === "static") o.discoveryOnly = false;
  const total = st.idleUsd + st.positions.reduce((a, p) => a + p.equityUsd, 0);
  const plan = planAllocation(opps, {
    cfg,
    nowMs: now,
    tokens: loadTokens(f),
    totalEquityUsd: total,
    positions: st.positions,
    exposure: computeExposure(st.positions),
    history: st.history,
    cooldownUntil: st.cooldownUntil,
    paused: st.paused,
    idleUsd: st.idleUsd,
    hedges: st.hedges,
  });
  console.log(`deployable $${Math.round(plan.deployableUsd)} of $${Math.round(total)}`);
  for (const e of plan.entries)
    console.log(`ENTER ${e.oppId} +$${Math.round(e.deltaUsd)} net ${pct(e.netApr)} marginal ${pct(e.marginalApr)}`);
  if (f["why"]) for (const [id, r] of Object.entries(plan.rejected)) console.log(`skip ${id}: ${r.slice(0, 3).join("; ")}`);
}

async function cmdRun(cfg: RouterConfig, f: Flags) {
  if (!f["paper"]) throw new Error("only --paper is wired in this repo; live executors come from the protocol adapters (see README)");
  const dir = s(f, "state") ?? "state";
  const store = new FileStore(`${dir}/state.json`, `${dir}/journal.jsonl`, Number(s(f, "equity") ?? 100_000));
  const sources = buildSources(f);
  const { notifier, tg } = makeNotifier(cfg);
  const exec = new PaperExecutor();
  const executors = Object.fromEntries(sources.map((x) => [x.id, exec]));
  const router = new Router({ cfg, sources, executors, store, notifier, tokens: () => loadTokens(f), paperAccrual: true });
  const cycles = Number(s(f, "cycles") ?? Infinity);
  const interval = Number(s(f, "interval") ?? cfg.poll_seconds) * 1000;
  for (let i = 0; i < cycles; i++) {
    if (tg) for (const c of await tg.pollCommands()) await tg.send("info", router.handleCommand(c));
    const r = await router.cycle();
    console.log(`[${new Date(r.nowMs).toISOString()}] equity $${Math.round(r.totalEquityUsd)} idle $${Math.round(r.idleUsd)} actions ${r.executed.length}`);
    if (i + 1 < cycles) await new Promise((res) => setTimeout(res, interval));
  }
}

async function cmdVerify(cfg: RouterConfig) {
  const now = Date.now();
  const ctx = { cfg, nowMs: now, myEquityByOpp: {} };
  try {
    const raw = await (await fetch("https://api.merkl.xyz/v4/opportunities?status=LIVE&items=5")).json();
    const issues = checkMerklShape(raw);
    console.log(`merkl: ${Array.isArray(raw) ? raw.length : "?"} items; ${issues.length ? "ISSUES: " + issues.join("; ") : "shape OK"}`);
    const opps = await new MerklSource({}).fetch(ctx);
    console.log(`merkl: mapped ${opps.length} live opportunities`);
  } catch (e) {
    console.log(`merkl: FAILED ${(e as Error).message}`);
  }
  try {
    const opps = await new DefiLlamaSource({}).fetch(ctx);
    console.log(`defillama: mapped ${opps.length} candidates (${opps.filter((o) => o.kind === "lending_loop").length} loop candidates)`);
  } catch (e) {
    console.log(`defillama: FAILED ${(e as Error).message}`);
  }
}

const HELP = `incentive-router

  scan   [--static f.yaml] [--merkl-fixture f.json] [--llama-fixture f.json [--llama-lendborrow-fixture f.json]] [--live]
         [--tokens tokens.yaml] [--probe 10000] [--equity 100000] [--top 30] [--why] [--json]
  plan   (same source flags) [--state dir] [--paper] [--why]
  sim    <scenario.yaml> [--verbose]
  run    --paper (same source flags) [--state dir] [--cycles N] [--interval sec]
  verify-sources        check live Merkl / DefiLlama response shapes (needs internet)

  global: --config <yaml>   (default: config/default.yaml when present)`;

async function main() {
  const { cmd, pos, flags } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(s(flags, "config") ?? (existsSync("config/default.yaml") ? "config/default.yaml" : undefined));
  switch (cmd) {
    case "scan":
      return cmdScan(cfg, flags);
    case "plan":
      return cmdPlan(cfg, flags);
    case "run":
      return cmdRun(cfg, flags);
    case "verify-sources":
      return cmdVerify(cfg);
    case "sim": {
      if (!pos[0]) throw new Error("usage: sim <scenario.yaml>");
      const r = await runScenario(loadScenario(pos[0]));
      console.log(formatScenario(r, !!flags["verbose"]));
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
