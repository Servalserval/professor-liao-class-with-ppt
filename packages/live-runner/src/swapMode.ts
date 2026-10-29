/**
 * Entry vs exit swap budgets for lending adapters.
 *
 * Loop legs swap debt -> collateral on the way in and collateral -> debt on
 * the way out. A tight cost ceiling is right for entries (never enter at a bad
 * price) but WRONG for exits: during a depeg the exit swap may cost 50-200
 * bps and must still be possible. Adapters take one swapper, so they get a
 * modal wrapper over two instances: "exit" (loose ceiling, the default — also
 * used for markets() probes so measured depth is real) and "entry" (strict),
 * which the LoopExecutor selects around open().
 *
 * Calls are serialized by the router (one action at a time), so a single
 * mutable mode is safe. Each quote remembers which inner swapper produced it,
 * so execution always goes to the same instance.
 */
import type { AssetRef, LiveContext, SwapAdapter, SwapQuote } from "@incentive-router/live-common";
import type { PtbSwapper, PtbSwapQuote } from "@incentive-router/live-sui";

export type SwapMode = "entry" | "exit";

export class SwapModeSwitch {
  mode: SwapMode = "exit";
  async run<T>(mode: SwapMode, fn: () => Promise<T>): Promise<T> {
    const prev = this.mode;
    this.mode = mode;
    try {
      return await fn();
    } finally {
      this.mode = prev;
    }
  }
}

export class ModalSwapAdapter implements SwapAdapter {
  readonly id: string;
  readonly chain: string;
  private readonly owner = new WeakMap<SwapQuote, SwapAdapter>();
  constructor(
    private readonly sw: SwapModeSwitch,
    private readonly entry: SwapAdapter,
    private readonly exit: SwapAdapter
  ) {
    this.id = entry.id;
    this.chain = entry.chain;
  }
  private cur(): SwapAdapter {
    return this.sw.mode === "entry" ? this.entry : this.exit;
  }
  async quote(from: AssetRef, to: AssetRef, amountIn: bigint, ctx: LiveContext): Promise<SwapQuote> {
    const inner = this.cur();
    const q = await inner.quote(from, to, amountIn, ctx);
    this.owner.set(q, inner);
    return q;
  }
  swap(q: SwapQuote, from: AssetRef, to: AssetRef, ctx: LiveContext) {
    return (this.owner.get(q) ?? this.cur()).swap(q, from, to, ctx);
  }
}

export class ModalPtbSwapper implements PtbSwapper {
  private readonly owner = new WeakMap<PtbSwapQuote, PtbSwapper>();
  constructor(
    private readonly sw: SwapModeSwitch,
    private readonly entry: PtbSwapper,
    private readonly exit: PtbSwapper
  ) {}
  private cur(): PtbSwapper {
    return this.sw.mode === "entry" ? this.entry : this.exit;
  }
  async quote(fromType: string, toType: string, amountIn: bigint): Promise<PtbSwapQuote> {
    const inner = this.cur();
    const q = await inner.quote(fromType, toType, amountIn);
    this.owner.set(q, inner);
    return q;
  }
  appendSwap(...args: Parameters<PtbSwapper["appendSwap"]>): ReturnType<PtbSwapper["appendSwap"]> {
    const q = args[1].quote;
    return (this.owner.get(q) ?? this.cur()).appendSwap(...args);
  }
}
