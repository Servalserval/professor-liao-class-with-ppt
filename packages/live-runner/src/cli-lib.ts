/** Process-level safety helpers for the CLI (kept import-safe for tests). */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * One runner per state dir: two processes on one wallet would double-send.
 * The lock file is created atomically (O_EXCL). A stale lock (holder dead) is
 * taken over by an atomic rename of our own freshly created file, so two
 * starters cannot both win. EPERM from kill(pid, 0) means "alive, other user".
 */
export function takeLock(dir: string, cmdlineHint = "live-runner"): () => void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "runner.lock");
  const holderAlive = (pid: number): boolean => {
    if (pid === process.pid) return true; // already held by this process
    if (!(pid > 0)) return false;
    try {
      process.kill(pid, 0);
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
    // pid exists: make sure it is really a runner (pid reuse after a crash)
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return cmd.includes(cmdlineHint) || cmd.includes("cli.ts");
    } catch {
      return true; // no /proc (non-Linux): assume alive, be safe
    }
  };
  const write = (target: string) => {
    const fd = openSync(target, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
  };
  try {
    write(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8").trim());
    if (holderAlive(pid)) throw new Error(`another runner (pid ${pid}) holds ${path}; refusing to start`);
    const mine = `${path}.${process.pid}`;
    write(mine);
    renameSync(mine, path); // atomic takeover of the stale lock
    if (Number(readFileSync(path, "utf8").trim()) !== process.pid) throw new Error(`lost the race for ${path}`);
  }
  return () => {
    try {
      if (Number(readFileSync(path, "utf8").trim()) === process.pid) unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
}

/** A state dir belongs to ONE mode: paper (shadow) books must never be mixed with real ones. */
export function checkModeMarker(dir: string, mode: string): void {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "mode.json");
  if (!existsSync(p)) {
    writeFileSync(p, JSON.stringify({ mode, createdAtMs: Date.now() }));
    return;
  }
  const m = JSON.parse(readFileSync(p, "utf8")) as { mode?: string };
  if (m.mode !== mode)
    throw new Error(`state_dir ${dir} was used in ${m.mode} mode; use a separate state_dir for ${mode} (e.g. state/${mode}) — paper positions and transfers must not mix with real ones`);
}

