import { routeCostUsd } from "./routes.js";
import type { BridgeExecutor, BridgePollResult, InFlightTransfer } from "./types.js";

export type PaperBridgeBehavior =
  | "ok"
  /** never completes (stuck detection) */
  | "stuck"
  /** fails after the hop's eta, funds lost (manual recovery) */
  | "fail"
  /** fails after the hop's eta, the protocol refunds the hop's input to its source wallet */
  | "fail_refund"
  /** send() refuses (nothing leaves the wallet) */
  | "send_fail";

export interface PaperBridgeOptions {
  behavior?: (t: InFlightTransfer) => PaperBridgeBehavior;
}

/**
 * Dry-run bridge: a hop completes once `etaMinutes` of ROUTER time have passed
 * since it was started and delivers its input minus the route's cash cost
 * (fees + gas, see routeCostUsd). Timing uses `t.hopStartedAtMs`, which the
 * router persists, so it survives restarts like a real bridge would.
 */
export class PaperBridgeExecutor implements BridgeExecutor {
  readonly log: string[] = [];
  constructor(
    private readonly now: () => number,
    public opts: PaperBridgeOptions = {}
  ) {}

  private behavior(t: InFlightTransfer): PaperBridgeBehavior {
    return this.opts.behavior?.(t) ?? "ok";
  }

  async send(t: InFlightTransfer): Promise<{ ok: boolean; ref?: string; detail?: string }> {
    const hop = t.path[t.hop];
    if (!hop) return { ok: false, detail: `paper: no hop ${t.hop}` };
    if (this.behavior(t) === "send_fail") return { ok: false, detail: "paper: send forced to fail" };
    const amt = t.receivedUsd ?? t.amountUsd;
    this.log.push(`send ${t.id} hop ${t.hop} ${hop.id} ${amt.toFixed(2)}`);
    return { ok: true, ref: `paper:${t.id}:${t.hop}`, detail: `paper ${hop.kind} ${hop.from.chain}->${hop.to.chain}` };
  }

  async poll(t: InFlightTransfer): Promise<BridgePollResult> {
    const hop = t.path[t.hop];
    if (!hop) return { state: "failed", detail: `paper: no hop ${t.hop}` };
    const started = t.hopStartedAtMs ?? t.createdAtMs;
    const due = this.now() - started >= hop.etaMinutes * 60_000;
    const b = this.behavior(t);
    const input = t.receivedUsd ?? t.amountUsd;
    if (b === "stuck" || !due) return { state: "in_flight", ref: t.ref };
    if (b === "fail") return { state: "failed", ref: t.ref, detail: "paper: bridge failed, funds not returned" };
    if (b === "fail_refund")
      return { state: "failed", ref: t.ref, detail: "paper: bridge failed, refunded", refundedUsd: input - hop.gasSrcUsd };
    const receivedUsd = Math.max(0, input - routeCostUsd(hop, input));
    this.log.push(`arrive ${t.id} hop ${t.hop} ${receivedUsd.toFixed(2)}`);
    return { state: "completed", ref: t.ref, receivedUsd, detail: `paper: arrived on ${hop.to.chain}` };
  }
}
