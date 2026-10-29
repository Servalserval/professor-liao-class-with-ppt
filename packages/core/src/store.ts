import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { newHistory, type History } from "./signals.js";
import type { Position } from "./types.js";
import type { FrictionLedgerEntry } from "./xchain/friction.js";
import type { InFlightTransfer } from "./xchain/types.js";

export interface RouterState {
  version: 1;
  /**
   * Capital not deployed anywhere (USD), always the authoritative TOTAL.
   * Live mode: refreshed from wallets by the accounting hook.
   * When `idle` is non-empty it always equals sum(idle) (see idleInvariantOk).
   */
  idleUsd: number;
  /**
   * Idle USD per `chain:asset` bucket. Empty = legacy single-bucket mode
   * (the router behaves exactly as before cross-chain funding existed).
   */
  idle: Record<string, number>;
  /** Cross-chain moves not finished yet (their USD counts in total equity). */
  transfers: InFlightTransfer[];
  /** Cross-chain costs paid (quoted all-in cost), for the rolling 24h budget. */
  frictionLedger: FrictionLedgerEntry[];
  positions: Position[];
  history: History;
  cooldownUntil: Record<string, number>;
  /** Current short hedge per reward token (USD notional). */
  hedges: Record<string, number>;
  /** Which executor (sourceId) holds each hedge, so it can be closed after the last position is gone. */
  hedgeExecutor: Record<string, string>;
  paused: boolean;
  killed: boolean;
  /** Manual exits requested via Telegram, executed next cycle. */
  manualExit: string[];
  /** Dedupe key -> last time a status alert with that key was sent. */
  alertSentAt: Record<string, number>;
  lastCycleAtMs: number | null;
}

/**
 * `idle` (optional) splits the idle money per `chain:asset`; then `idleUsd`
 * is ignored and set to its sum.
 */
export function newState(idleUsd: number, idle?: Record<string, number>): RouterState {
  const buckets = { ...(idle ?? {}) };
  return {
    version: 1,
    idleUsd: idle && Object.keys(buckets).length ? sumIdle(buckets) : idleUsd,
    idle: buckets,
    transfers: [],
    frictionLedger: [],
    positions: [],
    history: newHistory(),
    cooldownUntil: {},
    hedges: {},
    hedgeExecutor: {},
    paused: false,
    killed: false,
    manualExit: [],
    alertSentAt: {},
    lastCycleAtMs: null,
  };
}

// ---------------------------------------------------------------------------
// Idle buckets. Every change goes through credit/debit so that, in bucket
// mode, idleUsd == sum(idle) holds by construction.
// ---------------------------------------------------------------------------

export function sumIdle(idle: Record<string, number>): number {
  return Object.values(idle).reduce((a, v) => a + v, 0);
}

/** true when idle money is tracked per chain:asset. */
export function bucketMode(st: RouterState): boolean {
  return Object.keys(st.idle).length > 0;
}

/** Bucket mode: idleUsd must equal sum(idle). Legacy mode: always true. */
export function idleInvariantOk(st: RouterState, eps = 1e-6): boolean {
  if (!bucketMode(st)) return true;
  return Math.abs(st.idleUsd - sumIdle(st.idle)) <= eps * Math.max(1, Math.abs(st.idleUsd));
}

/** Add USD to a bucket (legacy mode: to the single idle total). */
export function creditIdle(st: RouterState, key: string, usd: number): void {
  if (!Number.isFinite(usd) || usd === 0) return;
  if (!bucketMode(st)) {
    st.idleUsd += usd;
    return;
  }
  st.idle[key] = (st.idle[key] ?? 0) + usd;
  st.idleUsd = sumIdle(st.idle);
}

export function debitIdle(st: RouterState, key: string, usd: number): void {
  creditIdle(st, key, -usd);
}

/** Replace all buckets (live wallet read). */
export function setIdleBuckets(st: RouterState, idle: Record<string, number>): void {
  st.idle = { ...idle };
  st.idleUsd = sumIdle(st.idle);
}

/** Default fields that older state files do not have. */
export function normalizeState(s: RouterState): RouterState {
  s.alertSentAt ??= {};
  s.manualExit ??= [];
  s.hedges ??= {};
  s.hedgeExecutor ??= {};
  // added with cross-chain funding: old files load as legacy single-bucket state
  s.idle ??= {};
  s.transfers ??= [];
  s.frictionLedger ??= [];
  if (Object.keys(s.idle).length) s.idleUsd = sumIdle(s.idle);
  return s;
}

export interface Store {
  load(): RouterState;
  save(s: RouterState): void;
  journal(event: Record<string, unknown>): void;
}

export class MemoryStore implements Store {
  private state: RouterState;
  readonly events: Record<string, unknown>[] = [];
  constructor(initial: RouterState) {
    this.state = normalizeState(structuredClone(initial));
  }
  load(): RouterState {
    return structuredClone(this.state);
  }
  save(s: RouterState): void {
    this.state = structuredClone(s);
  }
  journal(event: Record<string, unknown>): void {
    this.events.push(event);
  }
}

/** JSON state file (atomic write via rename) + append-only JSONL journal. */
export class FileStore implements Store {
  constructor(
    private readonly statePath: string,
    private readonly journalPath: string,
    private readonly initialIdleUsd = 0,
    /** Optional per chain:asset split of the initial idle money (bucket mode). */
    private readonly initialIdle?: Record<string, number>
  ) {
    mkdirSync(dirname(statePath), { recursive: true });
    mkdirSync(dirname(journalPath), { recursive: true });
  }
  load(): RouterState {
    if (!existsSync(this.statePath)) return newState(this.initialIdleUsd, this.initialIdle);
    const s = JSON.parse(readFileSync(this.statePath, "utf8")) as RouterState;
    if (s.version !== 1) throw new Error(`unsupported state version ${String(s.version)}`);
    return normalizeState(s);
  }
  save(s: RouterState): void {
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.statePath);
  }
  journal(event: Record<string, unknown>): void {
    appendFileSync(this.journalPath, JSON.stringify(event) + "\n");
  }
}
