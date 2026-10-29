/**
 * Dry-run of a dependent tx sequence (approve -> supplyCollateral -> borrow).
 *
 * `sendTx` simulates each tx with eth_call against the CURRENT state, so the
 * 2nd tx of a sequence reverts in dry-run (the approve / supply never
 * happened). viem's `simulateCalls` (eth_simulateV1) runs the calls
 * sequentially on one simulated block, so the whole sequence is checked.
 * RPCs without eth_simulateV1 fall back to simulating step 1 only via sendTx.
 * Gas caps are enforced like sendTx (per call, USD).
 */
import { sendTx, SimulationError, type EvmEnv, type TxRequest } from "@incentive-router/live-evm-base";
import type { LiveContext, TxRecord } from "@incentive-router/live-common";

export interface BundleSimulation {
  records: TxRecord[];
  /** true = every call was simulated in sequence; false = only the first (RPC lacks eth_simulateV1). */
  bundled: boolean;
  note?: string;
}

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

export async function simulateBundle(env: EvmEnv, ctx: LiveContext, reqs: TxRequest[]): Promise<BundleSimulation> {
  const dry: LiveContext = { ...ctx, dryRun: true };
  if (reqs.length === 0) return { records: [], bundled: true };
  if (reqs.length === 1) return { records: [await sendTx(env, dry, reqs[0]!)], bundled: true };

  let results: Awaited<ReturnType<EvmEnv["publicClient"]["simulateCalls"]>>["results"];
  try {
    const sim = await env.publicClient.simulateCalls({
      account: env.account,
      calls: reqs.map((r) => ({ to: r.to, data: r.data, value: r.value })),
    });
    results = sim.results;
  } catch (e) {
    const first = await sendTx(env, dry, reqs[0]!);
    const note = `eth_simulateV1 unavailable (${firstLine(e)}); simulated step 1/${reqs.length} only ("${reqs[0]!.description}")`;
    ctx.log("warn", `${env.chain}: ${note}`);
    return { records: [first], bundled: false, note };
  }
  if (results.length < reqs.length) throw new Error(`${env.chain}: simulateCalls returned ${results.length} results for ${reqs.length} calls`);

  const gasPrice = await env.publicClient.getGasPrice();
  const native = await ctx.nativePriceUsd(env.chain);
  const records: TxRecord[] = [];
  for (let i = 0; i < reqs.length; i++) {
    const req = reqs[i]!;
    const r = results[i]!;
    if (r.status !== "success")
      throw new SimulationError(`${env.chain}: bundle step ${i + 1}/${reqs.length} reverted for "${req.description}": ${firstLine(r.error)}`, req);
    const gasUsd = (Number(r.gasUsed * gasPrice) / 1e18) * native;
    const cap = req.maxGasUsd ?? ctx.limits.maxGasUsd[env.chain] ?? ctx.limits.maxGasUsd.default ?? 5;
    if (gasUsd > cap) throw new Error(`${env.chain}: "${req.description}" gas $${gasUsd.toFixed(2)} > cap $${cap}`);
    ctx.log("info", `[dry-run] ${env.chain}: ${req.description} (bundle ${i + 1}/${reqs.length})`, { gasUsd });
    records.push({ chain: env.chain, description: req.description, gasUsd, simulated: true });
  }
  return { records, bundled: true };
}
