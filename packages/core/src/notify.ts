import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./store.js";
import type { AlertLevel } from "./types.js";

export interface Notifier {
  send(level: AlertLevel, text: string): Promise<void>;
}

const ICON: Record<AlertLevel, string> = { info: "ℹ️", warn: "⚠️", critical: "🚨" };

export class ConsoleNotifier implements Notifier {
  constructor(private readonly minLevel: AlertLevel = "info") {}
  async send(level: AlertLevel, text: string): Promise<void> {
    const order: AlertLevel[] = ["info", "warn", "critical"];
    if (order.indexOf(level) < order.indexOf(this.minLevel)) return;
    const line = `${ICON[level]} [${level}] ${text}`;
    if (level === "critical") console.error(line);
    else console.log(line);
  }
}

export class CollectingNotifier implements Notifier {
  readonly messages: { level: AlertLevel; text: string }[] = [];
  async send(level: AlertLevel, text: string): Promise<void> {
    this.messages.push({ level, text });
  }
}

export class MultiNotifier implements Notifier {
  constructor(private readonly targets: Notifier[]) {}
  async send(level: AlertLevel, text: string): Promise<void> {
    await Promise.allSettled(this.targets.map((t) => t.send(level, text)));
  }
}

export interface Command {
  cmd: string;
  args: string[];
}

/**
 * Telegram bot (same pattern as loop-farm: only the configured chat id may
 * issue commands). Levels: info = digest, warn = attention, critical = the
 * router already acted (auto-exit) and is telling you after the fact.
 */
export class TelegramNotifier implements Notifier {
  private offset = 0;
  /**
   * `offsetPath`: file that persists the last processed update id, so a
   * restart does not re-run commands Telegram still returns (/exitall twice).
   */
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly opts: { offsetPath?: string } = {}
  ) {
    if (opts.offsetPath && existsSync(opts.offsetPath)) {
      try {
        const v = Number(JSON.parse(readFileSync(opts.offsetPath, "utf8")).offset);
        if (Number.isInteger(v) && v >= 0) this.offset = v;
      } catch (e) {
        console.error("telegram offset file unreadable, starting from 0:", (e as Error).message);
      }
    }
  }

  /** Last processed update id (persisted when offsetPath is set). */
  get lastUpdateId(): number {
    return this.offset;
  }

  async send(level: AlertLevel, text: string): Promise<void> {
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: `${ICON[level]} ${text}`.slice(0, 4000),
          disable_notification: level === "info",
        }),
      });
      if (!res.ok) console.error(`telegram send failed: HTTP ${res.status}`);
    } catch (e) {
      console.error("telegram send failed:", (e as Error).message);
    }
  }

  async pollCommands(): Promise<Command[]> {
    const out: Command[] = [];
    try {
      const res = await this.fetchImpl(
        `https://api.telegram.org/bot${this.token}/getUpdates?timeout=0&offset=${this.offset + 1}`
      );
      const body = (await res.json()) as {
        ok: boolean;
        result?: { update_id: number; message?: { chat: { id: number | string }; text?: string } }[];
      };
      if (!body.ok || !body.result) return [];
      const before = this.offset;
      for (const u of body.result) {
        this.offset = Math.max(this.offset, u.update_id);
        const msg = u.message;
        if (!msg?.text || String(msg.chat.id) !== String(this.chatId)) continue; // allowlist
        if (!msg.text.startsWith("/")) continue;
        const [cmd, ...args] = msg.text.trim().split(/\s+/);
        out.push({ cmd: (cmd ?? "").toLowerCase().replace(/@.*$/, ""), args });
      }
      // persist BEFORE the caller runs the commands: a crash then skips them rather than re-running them
      if (this.offset !== before && this.opts.offsetPath) {
        try {
          writeFileAtomic(this.opts.offsetPath, JSON.stringify({ offset: this.offset }));
        } catch (e) {
          console.error("telegram offset save failed:", (e as Error).message);
        }
      }
    } catch (e) {
      console.error("telegram poll failed:", (e as Error).message);
    }
    return out;
  }
}
