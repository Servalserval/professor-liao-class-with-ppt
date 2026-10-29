/**
 * Live gate (ported from loop-farm): the bot refuses to broadcast anything
 * unless a fresh `verify` stamp exists whose hash matches the current config.
 *
 *   verify  -> reads every configured address / asset / market / bridge back
 *              on-chain, writes <state>/verify-stamp.json with the config hash
 *   live    -> requires: stamp exists, age < maxAgeDays, hash matches, zero
 *              issues recorded, mode: live in config, and LIVE_CONFIRM=yes in env
 *
 * Anything that changes the config (a new pair, a new address, a different
 * cap) changes the hash and forces a new verify.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface VerifyStamp {
  createdAtMs: number;
  configHash: string;
  /** component id -> issues found (all must be empty for live). */
  results: Record<string, string[]>;
}

/** Stable JSON (sorted keys) so the hash does not depend on key order. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function configHash(cfg: unknown): string {
  return createHash("sha256").update(stableStringify(cfg)).digest("hex");
}

export function writeStamp(path: string, stamp: VerifyStamp): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(stamp, null, 2));
}

export function readStamp(path: string): VerifyStamp | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as VerifyStamp;
}

export interface GateInput {
  stamp: VerifyStamp | null;
  configHash: string;
  nowMs: number;
  maxAgeDays: number;
  modeIsLive: boolean;
  env: NodeJS.ProcessEnv;
}

/** Returns the reasons live mode is NOT allowed (empty = allowed). */
export function liveBlockers(g: GateInput): string[] {
  const r: string[] = [];
  if (!g.modeIsLive) r.push("config mode is not 'live'");
  if (g.env.LIVE_CONFIRM !== "yes") r.push("LIVE_CONFIRM=yes is not set in the environment");
  if (!g.stamp) {
    r.push("no verify stamp — run `verify` first");
    return r;
  }
  if (g.stamp.configHash !== g.configHash) r.push("config changed since the last verify — run `verify` again");
  const ageDays = (g.nowMs - g.stamp.createdAtMs) / 86_400_000;
  if (ageDays > g.maxAgeDays) r.push(`verify stamp is ${ageDays.toFixed(1)} days old (max ${g.maxAgeDays})`);
  const bad = Object.entries(g.stamp.results).filter(([, issues]) => issues.length);
  for (const [k, issues] of bad) r.push(`verify issues in ${k}: ${issues.slice(0, 3).join("; ")}`);
  return r;
}
