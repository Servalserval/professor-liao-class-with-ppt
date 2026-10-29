import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { newHistory, type History } from "./signals.js";
import type { Position } from "./types.js";

export interface RouterState {
  version: 1;
  /** Capital not deployed anywhere (USD). Live mode: refreshed from wallets by the accounting hook. */
  idleUsd: number;
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

export function newState(idleUsd: number): RouterState {
  return {
    version: 1,
    idleUsd,
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

export interface Store {
  load(): RouterState;
  save(s: RouterState): void;
  journal(event: Record<string, unknown>): void;
}

export class MemoryStore implements Store {
  private state: RouterState;
  readonly events: Record<string, unknown>[] = [];
  constructor(initial: RouterState) {
    this.state = structuredClone(initial);
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
    private readonly initialIdleUsd = 0
  ) {
    mkdirSync(dirname(statePath), { recursive: true });
    mkdirSync(dirname(journalPath), { recursive: true });
  }
  load(): RouterState {
    if (!existsSync(this.statePath)) return newState(this.initialIdleUsd);
    const s = JSON.parse(readFileSync(this.statePath, "utf8")) as RouterState;
    if (s.version !== 1) throw new Error(`unsupported state version ${String(s.version)}`);
    s.alertSentAt ??= {};
    s.manualExit ??= [];
    s.hedges ??= {};
    s.hedgeExecutor ??= {};
    return s;
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
