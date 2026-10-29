/**
 * Shadow-mode bridge executor: every hop is first BUILT AND SIMULATED by the
 * live bridge executor (constructed with a dry-run context, so nothing is
 * broadcast); if that simulation fails the hop fails exactly like it would
 * live. If it succeeds, the hop's lifecycle (ETA, arrival, route cost) is
 * played by the core PaperBridgeExecutor on router time.
 *
 * Note: an ERC20 approval that does not exist yet can only be simulated as
 * the approval itself (the bridge call after it needs the allowance
 * on-chain); such hops are reported as "simulated (approval pending)".
 */
import { PaperBridgeExecutor, type BridgeExecutor, type BridgePollResult, type InFlightTransfer } from "@incentive-router/core";

export class ShadowBridgeExecutor implements BridgeExecutor {
  private readonly paper: PaperBridgeExecutor;
  constructor(
    private readonly dryRunLive: BridgeExecutor,
    now: () => number
  ) {
    this.paper = new PaperBridgeExecutor(now);
  }

  async send(t: InFlightTransfer): Promise<{ ok: boolean; ref?: string; detail?: string }> {
    const sim = await this.dryRunLive.send(t);
    if (!sim.ok) return { ok: false, detail: `shadow: live simulation refused: ${sim.detail ?? ""}` };
    const p = await this.paper.send(t);
    return { ...p, detail: `shadow: ${sim.detail ?? "simulated"} | ${p.detail ?? ""}` };
  }

  poll(t: InFlightTransfer): Promise<BridgePollResult> {
    return this.paper.poll(t);
  }
}
