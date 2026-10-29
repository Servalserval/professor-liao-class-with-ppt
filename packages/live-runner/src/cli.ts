#!/usr/bin/env node
/**
 * Live runner CLI (see docs/runbook.md).
 *
 *   verify    read every configured address / asset / market / bridge back on-chain, write the verify stamp
 *   markets   live loop opportunities with net APR and entry verdicts
 *   balances  wallet buckets (chain:asset USD) the router treats as idle cash
 *   plan      one simulated router cycle on a copy of the state (nothing is sent)
 *   run       the loop: mode from config (shadow = simulate on-chain, live = broadcast behind the gate)
 *   status    stored state: positions, idle buckets, transfers in flight, 24h cross-chain costs
 *   rewards   run the reward keeper once now (claims / sells; simulated in shadow)
 */
import {
  checkSizedEntry,
  computeExposure,
  ConsoleNotifier,
  entryBlockers,
  FileStore,
  MemoryStore,
  MultiNotifier,
  newHistory,
  PaperBridgeExecutor,
  PaperExecutor,
  Router,
  statusText,
  TelegramNotifier,
  upsertPosition,
  valueAt,
  venueTier,
  type DecisionContext,
  type Notifier,
  type Opportunity,
  type RouterState,
} from "@incentive-router/core";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildRuntime, type Runtime } from "./build.js";
import { checkModeMarker, takeLock } from "./cli-lib.js";
import { liveBlockers, readStamp, writeStamp } from "./gate.js";
import { loadLiveConfig } from "./liveConfig.js";

type Flags = Record<string, string | boolean>;

/** Live gate state shared with the executors (entries + bridge sends refused while set). */
const gate = { reason: null as string | null };

function parseArgs(argv: string[]): { cmd: string; flags: Flags } {
  const [cmd = "help", ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const n = rest[i + 1];
    if (n !== undefined && !n.startsWith("--")) {
      flags[k] = n;
      i++;
    } else flags[k] = true;
  }
  return { cmd, flags };
}
const str = (f: Flags, k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : "n/a");
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeNotifier(stateDir: string): { notifier: Notifier; tg?: TelegramNotifier } {
  const tok = process.env.TG_BOT_TOKEN;
  const chat = process.env.TG_CHAT_ID;
  if (tok && chat) {
    // Offset persisted so commands (e.g. /resume) are not re-run after a restart.
    const tg = new TelegramNotifier(tok, chat, fetch, { offsetPath: join(stateDir, "telegram-offset.json") });
    return { notifier: new MultiNotifier([new ConsoleNotifier(), tg]), tg };
  }
  return { notifier: new ConsoleNotifier() };
}

function storeFor(rt: Runtime): FileStore {
  return new FileStore(join(rt.cfg.state_dir, "state.json"), join(rt.cfg.state_dir, "journal.jsonl"), 0);
}

async function fetchOpps(rt: Runtime, st: RouterState): Promise<Opportunity[]> {
  const my: Record<string, number> = {};
  for (const p of st.positions) my[p.oppId] = p.equityUsd;
  const res = await Promise.allSettled(rt.sources.map((s) => s.fetch({ cfg: rt.routerCfg, nowMs: Date.now(), myEquityByOpp: my })));
  const out: Opportunity[] = [];
  res.forEach((r, i) => {
    if (r.status === "fulfilled") out.push(...r.value);
    else console.error(`source ${rt.sources[i]!.id} failed: ${(r.reason as Error).message}`);
  });
  return out;
}

// --- commands -------------------------------------------------------------------------

async function cmdVerify(rt: Runtime, missingEnv: string[]): Promise<number> {
  const { issues, warnings } = await rt.verify();
  if (missingEnv.length) issues["env"] = missingEnv.map((v) => `environment variable ${v} is not set`);
  let bad = 0;
  for (const [id, list] of Object.entries(issues).sort()) {
    if (list.length) bad += list.length;
    console.log(`${list.length ? "FAIL" : " ok "} ${id}${list.length ? "" : ""}`);
    for (const l of list) console.log(`       - ${l}`);
    for (const w of warnings[id] ?? []) console.log(`       ~ ${w}`);
  }
  const path = join(rt.cfg.state_dir, "verify-stamp.json");
  writeStamp(path, { createdAtMs: Date.now(), configHash: rt.hash, results: issues, warnings });
  console.log(`\n${bad ? `${bad} issue(s): live mode stays blocked` : "no issues"}; stamp written to ${path} (config hash ${rt.hash.slice(0, 12)})`);
  return bad ? 1 : 0;
}

function decisionCtx(rt: Runtime, st: RouterState, equity: number, tokens: DecisionContext["tokens"]): DecisionContext {
  return {
    cfg: rt.routerCfg,
    nowMs: Date.now(),
    tokens,
    totalEquityUsd: equity,
    positions: st.positions,
    exposure: computeExposure(st.positions),
    history: st.history ?? newHistory(),
    cooldownUntil: st.cooldownUntil,
    paused: st.paused,
    idleUsd: st.idleUsd,
    hedges: st.hedges,
  };
}

async function cmdMarkets(rt: Runtime, f: Flags): Promise<number> {
  const st = storeFor(rt).load();
  const probe = Number(str(f, "probe") ?? 10_000);
  const equity = Number(str(f, "equity") ?? Math.max(300_000, st.idleUsd + st.positions.reduce((a, p) => a + p.equityUsd, 0)));
  const opps = await fetchOpps(rt, st);
  const ctx = decisionCtx(rt, st, equity, await rt.tokens());
  const rows = opps
    .map((o) => {
      const v = valueAt(o, probe, ctx);
      const reasons = [...entryBlockers(o, ctx).filter((b) => !b.startsWith("discovery only")), ...checkSizedEntry(o, 0, probe, ctx).reasons];
      return { o, v, reasons };
    })
    .sort((a, b) => b.v.netApr - a.v.netApr);
  if (f["json"]) {
    console.log(JSON.stringify(rows.map((r) => ({ id: r.o.id, netApr: r.v.netApr, rawApr: r.v.rawApr, passes: !r.reasons.length, reasons: r.reasons, metrics: r.o.metrics, meta: r.o.meta })), null, 2));
    return 0;
  }
  console.log(`${opps.length} live loop opportunities, probe ${usd(probe)} on equity ${usd(equity)}\n`);
  for (const r of rows) {
    const m = r.o.metrics as Record<string, number>;
    const extra = [m.depeg !== undefined ? `depeg ${(m.depeg * 1e4).toFixed(1)}bp` : "", m.utilization_d !== undefined ? `u(debt) ${pct(m.utilization_d)}` : m.utilization !== undefined ? `u ${pct(m.utilization)}` : ""]
      .filter(Boolean)
      .join(" ");
    console.log(`${r.reasons.length ? "----" : "PASS"} net ${pct(r.v.netApr).padStart(8)} raw ${pct(r.v.rawApr).padStart(8)} T${venueTier(rt.routerCfg, r.o.primaryVenue)} ${r.o.name}  [${r.o.id}] ${extra}`);
    if (f["why"]) {
      for (const x of r.reasons.slice(0, 5)) console.log(`        - ${x}`);
      const notes = (r.o.meta as { rewardNotes?: Record<string, string[]> } | undefined)?.rewardNotes;
      if (notes) for (const [k, v] of Object.entries(notes)) console.log(`        ~ ${k}: ${v.join(", ")}`);
    }
  }
  return 0;
}

async function cmdBalances(rt: Runtime): Promise<number> {
  const b = await rt.buckets.read();
  let tot = 0;
  for (const [k, v] of Object.entries(b).sort()) {
    tot += v;
    console.log(`${k.padEnd(24)} ${usd(v).padStart(12)}`);
  }
  console.log(`${"total".padEnd(24)} ${usd(tot).padStart(12)}`);
  return 0;
}

async function cmdPlan(rt: Runtime, f: Flags): Promise<number> {
  const st = storeFor(rt).load();
  const copy = structuredClone(st);
  if (rt.cfg.mode === "live" || !Object.keys(copy.idle ?? {}).length) {
    copy.idle = await rt.buckets.read();
    copy.idleUsd = Object.values(copy.idle).reduce((a, x) => a + x, 0);
  }
  const now = Date.now();
  const paper = new PaperExecutor();
  const pb = new PaperBridgeExecutor(() => now);
  const bridges = Object.fromEntries(Object.keys(rt.bridges).map((k) => [k, pb]));
  const router = new Router({
    cfg: rt.routerCfg,
    sources: rt.sources,
    executors: Object.fromEntries(rt.sources.map((s) => [s.id, paper])),
    store: new MemoryStore(copy),
    notifier: { send: async () => {} },
    tokens: rt.tokens,
    bridges,
    now: () => now,
  });
  const r = await router.cycle();
  console.log(`simulated cycle (nothing sent): equity ${usd(r.totalEquityUsd)}, idle ${usd(r.idleUsd)}, ${r.opportunities} opportunities`);
  for (const [k, v] of Object.entries(r.idle).sort()) console.log(`  idle ${k} ${usd(v)}`);
  for (const x of r.executed) console.log(`  ${x.ok ? "✓" : "✗"} ${x.action.type.toUpperCase()} ${JSON.stringify(x.action).slice(0, 160)}`);
  for (const t of r.transfers) console.log(`  ⇄ ${t.kind} ${usd(t.amountUsd)} ${t.from} -> ${t.to} via ${t.route}${t.costUsd !== undefined ? ` (cost $${t.costUsd.toFixed(2)})` : ""}`);
  if (f["why"] && r.allocationRejected)
    for (const [id, why] of Object.entries(r.allocationRejected)) console.log(`  skip ${id}: ${why.slice(0, 3).join("; ")}`);
  for (const e of r.sourceErrors) console.log(`  source error: ${e}`);
  return 0;
}

function cmdStatus(rt: Runtime): number {
  const st = storeFor(rt).load();
  console.log(statusText(st));
  for (const [k, v] of Object.entries(st.idle ?? {}).sort()) console.log(`  idle ${k} ${usd(v)}`);
  for (const t of st.transfers ?? [])
    console.log(`  transfer ${t.id} ${t.state} hop ${t.hop + 1}/${t.path.length} ${usd(t.amountUsd)} ${t.path.map((h) => h.id).join(" > ")} ref=${t.ref ?? "-"} ${t.detail ?? ""}`);
  const dayAgo = Date.now() - 86_400_000;
  const fr = (st.frictionLedger ?? []).filter((x) => x.t >= dayAgo).reduce((a, x) => a + x.costUsd, 0);
  console.log(`  cross-chain costs, last 24h: $${fr.toFixed(2)}`);
  const stamp = readStamp(join(rt.cfg.state_dir, "verify-stamp.json"));
  console.log(
    stamp
      ? `  verify stamp: ${new Date(stamp.createdAtMs).toISOString()} ${stamp.configHash === rt.hash ? "(matches config)" : "(CONFIG CHANGED since)"}`
      : "  verify stamp: none"
  );
  return 0;
}

/**
 * Adopt on-chain loop positions the router does not know about (a crash
 * between broadcast and save, an RPC error on the post-trade read). Without
 * this an orphaned leveraged loop would get no health checks at all.
 * Requires a DEDICATED wallet: anything found in a configured pair is managed.
 */
async function reconcile(rt: Runtime, store: FileStore, notifier: Notifier): Promise<void> {
  try {
    const st = store.load();
    const opps = await fetchOpps(rt, st);
    let changed = false;
    for (const opp of opps) {
      if (st.positions.some((p) => p.oppId === opp.id)) continue;
      const b = rt.registry.bind(opp.id);
      if (!b) continue;
      const v = await b.adapter.position(b.pairId).catch(() => null);
      if (!v || !(v.equityUsd > 10)) continue;
      upsertPosition(st, opp, v.equityUsd, Date.now());
      changed = true;
      await notifier.send("critical", `adopted untracked on-chain position ${opp.id} ($${v.equityUsd.toFixed(2)}, LTV ${v.ltv.toFixed(3)}) — it is now managed by the router`);
    }
    if (changed) store.save(st);
  } catch (e) {
    await notifier.send("warn", `position reconcile failed: ${(e as Error).message}`);
  }
}

async function cmdRun(rt: Runtime, f: Flags): Promise<number> {
  const mode = rt.cfg.mode;
  const stampPath = join(rt.cfg.state_dir, "verify-stamp.json");
  const blockers = () =>
    liveBlockers({ stamp: readStamp(stampPath), configHash: rt.hash, nowMs: Date.now(), maxAgeDays: rt.cfg.verify_max_age_days, modeIsLive: true, env: process.env });
  if (mode === "live") {
    const b = blockers();
    // Only an EXPIRED stamp is survivable: then the runner starts in exits-only
    // mode so open loops keep their risk management (deleverage, depeg exits,
    // kill switch). A missing LIVE_CONFIRM, a changed config or verify issues
    // refuse to start: those are explicit operator states.
    const fatal = b.filter((x) => !/days old/.test(x));
    if (fatal.length) {
      console.error("live mode is blocked:\n  - " + fatal.join("\n  - "));
      return 1;
    }
    if (!rt.canSign.evm && Object.keys(rt.evm).length) throw new Error("live mode without EVM_PRIVATE_KEY");
    if (!rt.canSign.sui && rt.sui) throw new Error("live mode without SUI_PRIVATE_KEY");
    gate.reason = b.length ? `live gate closed: ${b.join("; ")}` : null;
    if (gate.reason) console.error(`${gate.reason} — starting EXITS-ONLY (re-run verify to resume entries)`);
  }
  checkModeMarker(rt.cfg.state_dir, mode);
  const release = takeLock(rt.cfg.state_dir);
  const store = storeFor(rt);
  // Shadow: seed the paper book from the real wallet once, so the simulation starts
  // from the money the bot would actually have (per chain:asset bucket).
  if (mode === "shadow") {
    const st = store.load();
    if (st.lastCycleAtMs === null && !st.positions.length && !Object.keys(st.idle ?? {}).length) {
      st.idle = await rt.buckets.read();
      st.idleUsd = Object.values(st.idle).reduce((a, x) => a + x, 0);
      store.save(st);
      rt.log("info", `shadow: seeded idle buckets from wallet (${usd(st.idleUsd)})`);
    }
  }
  const { notifier, tg } = makeNotifier(rt.cfg.state_dir);
  const router = new Router({
    cfg: rt.routerCfg,
    sources: rt.sources,
    executors: rt.executors,
    store,
    notifier,
    tokens: rt.tokens,
    paperAccrual: mode === "shadow",
    bridges: rt.bridges,
    idleBalances: mode === "live" ? () => rt.buckets.read() : undefined,
  });
  let stopping = false;
  const stop = () => {
    if (!stopping) rt.log("info", "stop requested; finishing the current cycle");
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await notifier.send("info", `runner started in ${mode.toUpperCase()} mode (config ${rt.hash.slice(0, 12)})`);

  const cycles = Number(str(f, "cycles") ?? Infinity);
  const interval = Number(str(f, "interval") ?? rt.cfg.poll_seconds) * 1000;
  let gateAlerted = false;
  try {
    for (let i = 0; i < cycles && !stopping; i++) {
      if (tg) for (const c of await tg.pollCommands()) await tg.send("info", router.handleCommand(c));
      if (mode === "live") {
        // Re-evaluated EVERY cycle and enforced in the executors themselves
        // (entries + bridge sends refused), so /resume cannot bypass it.
        const b = blockers();
        gate.reason = b.length ? `live gate closed: ${b.join("; ")}` : null;
        if (gate.reason && !gateAlerted) {
          gateAlerted = true;
          await notifier.send("critical", `${gate.reason}. Entries and bridge sends are refused; exits continue. Re-run verify (same config) to reopen.`);
        } else if (!gate.reason && gateAlerted) {
          gateAlerted = false;
          await notifier.send("info", "live gate open again");
        }
        if (i % 10 === 0) await reconcile(rt, store, notifier);
      }
      try {
        const r = await router.cycle();
        rt.log(
          "info",
          `cycle: equity ${usd(r.totalEquityUsd)} idle ${usd(r.idleUsd)} in-flight ${usd(r.inFlightUsd)} actions ${r.executed.length} transfers ${r.transfers.length}${r.killed ? " KILLED" : ""}`
        );
      } catch (e) {
        await notifier.send("critical", `cycle crashed: ${(e as Error).message}`);
      }
      try {
        const lines = gate.reason ? [] : await rt.keeper.run();
        if (lines.length) await notifier.send("info", `rewards:\n${lines.join("\n")}`);
      } catch (e) {
        await notifier.send("warn", `reward keeper failed: ${(e as Error).message}`);
      }
      if (i + 1 < cycles && !stopping) {
        const until = Date.now() + interval;
        while (Date.now() < until && !stopping) await sleep(Math.min(1000, until - Date.now()));
      }
    }
  } finally {
    release();
  }
  return 0;
}

const HELP = `incentive-router live runner

  npm run live -- <command> [--config config/live.yaml]

  verify               on-chain checks of every configured component; writes the verify stamp
  markets [--why] [--probe 10000] [--json]
  balances             wallet buckets (chain:asset)
  plan [--why]         one simulated cycle on a copy of the state
  run [--cycles N] [--interval sec]
                       mode from config: shadow (simulate) | live (needs fresh verify + LIVE_CONFIRM=yes)
  status               positions, idle buckets, transfers, 24h cross-chain costs, stamp
  rewards              run the reward keeper once now
  cmd "/<command> ..." same commands as Telegram, e.g. cmd "/transfer <id> arrived 1000"`;

async function main(): Promise<number> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (cmd === "help" || cmd === "--help") {
    console.log(HELP);
    return 0;
  }
  const { raw, cfg, missingEnv } = loadLiveConfig(str(flags, "config") ?? "config/live.yaml");
  if (missingEnv.length && cmd !== "verify") console.error(`warning: unset environment variables: ${missingEnv.join(", ")}`);
  let store: FileStore | undefined;
  const rt = await buildRuntime(cfg, raw, {
    positions: () => (store ??= new FileStore(join(cfg.state_dir, "state.json"), join(cfg.state_dir, "journal.jsonl"), 0)).load().positions,
    entriesAllowed: () => gate.reason,
  });
  switch (cmd) {
    case "verify":
      return cmdVerify(rt, missingEnv);
    case "markets":
      return cmdMarkets(rt, flags);
    case "balances":
      return cmdBalances(rt);
    case "plan":
      return cmdPlan(rt, flags);
    case "run":
      return cmdRun(rt, flags);
    case "status":
      return cmdStatus(rt);
    case "cmd": {
      // Same commands as Telegram (/status /pause /resume /exit <id> /exitall /transfer <id> arrived|failed|refunded [usd]),
      // for operators without a bot. Takes the lock: state is mutated.
      const text = process.argv.slice(3).find((a) => a.startsWith("/"));
      if (!text) {
        console.error('usage: cmd "/transfer <id> arrived 1000" [--config ...]');
        return 1;
      }
      const release = takeLock(cfg.state_dir);
      try {
        const st = storeFor(rt);
        const router = new Router({ cfg: rt.routerCfg, sources: [], executors: {}, store: st, notifier: new ConsoleNotifier(), tokens: rt.tokens });
        const [c, ...args] = text.trim().split(/\s+/);
        console.log(router.handleCommand({ cmd: (c ?? "").toLowerCase(), args }));
      } finally {
        release();
      }
      return 0;
    }
    case "rewards": {
      if (cfg.mode === "live") {
        const b = liveBlockers({ stamp: readStamp(join(cfg.state_dir, "verify-stamp.json")), configHash: rt.hash, nowMs: Date.now(), maxAgeDays: cfg.verify_max_age_days, modeIsLive: true, env: process.env });
        if (b.length) {
          console.error("live gate closed:\n  - " + b.join("\n  - "));
          return 1;
        }
      }
      const release = takeLock(cfg.state_dir);
      try {
        for (const l of await rt.keeper.run(true)) console.log(l);
      } finally {
        release();
      }
      return 0;
    }
    default:
      console.log(HELP);
      return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  }
);
