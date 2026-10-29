/**
 * Small helpers shared by the bridge adapters: injectable fetch, a throttled
 * JSON client, 32-byte address padding, handle codecs and integer math.
 * No chain SDK imports here.
 */
import type { LiveContext } from "@incentive-router/live-common";
import { isAddress, pad, type Hex } from "viem";

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Subset of the WHATWG fetch we use, so tests can inject a mock. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<FetchResponseLike>;

export const defaultFetch: FetchLike = (url, init) => globalThis.fetch(url, init) as unknown as Promise<FetchResponseLike>;

export class HttpError extends Error {
  constructor(
    msg: string,
    readonly status: number
  ) {
    super(msg);
  }
}

/**
 * GET JSON with a minimum spacing between requests (Iris allows 40 req/s and
 * blocks the caller for 5 minutes on HTTP 429), a timeout, and a circuit
 * breaker after a 429. Returns null on 404 (the APIs use it for "not yet").
 */
export class JsonClient {
  private nextAt = 0;
  private blockedUntil = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchLike = defaultFetch,
    private readonly opts: { minIntervalMs?: number; timeoutMs?: number; blockOn429Ms?: number; now?: () => number } = {}
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async get<T = unknown>(path: string): Promise<T | null> {
    return this.request<T>("GET", path);
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T | null> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T | null> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
    if (this.now() < this.blockedUntil) throw new HttpError(`${url}: rate-limited until ${new Date(this.blockedUntil).toISOString()}`, 429);
    // serialize + space requests
    const turn = this.chain.then(async () => {
      const wait = this.nextAt - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.nextAt = this.now() + (this.opts.minIntervalMs ?? 50);
    });
    this.chain = turn.catch(() => undefined);
    await turn;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 15_000);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      const res = await this.fetchFn(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
      if (res.status === 404) return null;
      if (res.status === 429) {
        this.blockedUntil = this.now() + (this.opts.blockOn429Ms ?? 5 * 60_000);
        throw new HttpError(`${url}: HTTP 429 (rate limited)`, 429);
      }
      if (!res.ok) {
        let body = "";
        try {
          body = (await res.text()).slice(0, 200);
        } catch {
          /* ignore */
        }
        throw new HttpError(`${url}: HTTP ${res.status} ${body}`, res.status);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

/** Left-pad a 20-byte EVM address to bytes32 (CCTP mintRecipient, LayerZero `to`). */
export function evmAddressToBytes32(addr: string): Hex {
  if (!isAddress(addr, { strict: false })) throw new Error(`not an EVM address: ${addr}`);
  return pad(addr.toLowerCase() as Hex, { size: 32 });
}

/** A Sui address is already 32 bytes; normalize to 0x + 64 lowercase hex. */
export function suiAddressToBytes32(addr: string): Hex {
  const h = addr.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{1,64}$/.test(h)) throw new Error(`not a Sui address: ${addr}`);
  return `0x${h.padStart(64, "0")}` as Hex;
}

/** bytes32 -> EVM address when the top 12 bytes are zero, else undefined. */
export function bytes32ToEvmAddress(b: Hex): Hex | undefined {
  const h = b.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  if (!/^0{24}/.test(h)) return undefined;
  return `0x${h.slice(24)}` as Hex;
}

export function sameEvmAddress(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

// ---------------------------------------------------------------------------
// math
// ---------------------------------------------------------------------------

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv: non-positive divisor");
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

/** amount * (1 + bps/1e4), rounded up. */
export function plusBpsCeil(amount: bigint, bps: number): bigint {
  const b = BigInt(Math.max(0, Math.round(bps)));
  return ceilDiv(amount * (10_000n + b), 10_000n);
}

/** wei * gasUnits -> USD at a native price. */
export function gasToUsd(gasUnits: bigint, gasPriceWei: bigint, nativePriceUsd: number): number {
  return (Number(gasUnits * gasPriceWei) / 1e18) * nativePriceUsd;
}

// ---------------------------------------------------------------------------
// handles
// ---------------------------------------------------------------------------

/** Handles are colon-separated: `<prefix>:<field1>:<field2>...`. Fields must not contain ':'. */
export function encodeHandle(prefix: string, fields: (string | number | bigint)[]): string {
  const parts = fields.map((f) => String(f));
  for (const p of parts) if (p.includes(":")) throw new Error(`handle field contains ':': ${p}`);
  return [prefix, ...parts].join(":");
}

export function decodeHandle(prefix: string, handle: string, n: number, maxN: number = n): string[] {
  const parts = handle.split(":");
  if (parts[0] !== prefix || parts.length < n + 1 || parts.length > maxN + 1) throw new Error(`bad ${prefix} handle: ${handle}`);
  return parts.slice(1);
}

// ---------------------------------------------------------------------------
// status extensions (structurally assignable to live-common BridgeStatus)
// ---------------------------------------------------------------------------

/**
 * BridgeStatus plus optional extras the glue understands:
 *  - pending.unconfirmed: the adapter could not confirm progress (API down / unknown shape / tx not found);
 *    the glue escalates to "stuck" after 2x the route ETA.
 *  - failed.refunded: base units that provably never left / came back to the source wallet.
 *  - failed.detail starting with "recoverable:" -> core "stuck" (funds not lost, needs action).
 */
export type LiveBridgeStatus =
  | { state: "pending"; unconfirmed?: string }
  | { state: "claimable"; detail?: string }
  | { state: "completed"; dstTx?: string; received?: bigint }
  | { state: "failed"; detail: string; refunded?: bigint };

export const RECOVERABLE = "recoverable:";

// ---------------------------------------------------------------------------
// broadcast capture
// ---------------------------------------------------------------------------

/**
 * Wrap ctx so tx hashes / digests that sendTx / executePtb log right after
 * broadcasting are captured (sendTx logs `{ hash }` before waiting for the
 * receipt; executePtb logs `{ digest }` before waitForTransaction). Lets an
 * adapter return ok:true + a handle when a receipt wait times out after the
 * tx already left. Prototype-based so class-instance contexts keep their methods.
 */
export function captureBroadcasts(ctx: LiveContext): { ctx: LiveContext; ids: string[] } {
  const ids: string[] = [];
  const wrapped = Object.create(ctx) as LiveContext;
  wrapped.log = (level, msg, data) => {
    const id = data?.hash ?? data?.digest;
    if (typeof id === "string" && id.length > 0) ids.push(id);
    ctx.log(level, msg, data);
  };
  return { ctx: wrapped, ids };
}

/** sendTx / executePtb error after broadcast meaning the tx itself failed (so funds did not move). */
export function isOnChainFailure(e: unknown): boolean {
  return /reverted on-chain|failed on-chain/.test(errMsg(e));
}

export function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0]!;
}
