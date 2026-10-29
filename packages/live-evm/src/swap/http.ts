/**
 * Minimal injectable HTTP layer (GET + JSON POST) with timeouts. Every
 * third-party API call in live-evm/swap and live-evm/rewards goes through an
 * `HttpFetch` passed in the constructor so tests run offline.
 */
export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text?(): Promise<string> }>;

export const defaultFetch: HttpFetch = (url, init) => fetch(url, init);

export interface HttpOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** JSON-serialized when present. */
  body?: unknown;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    msg: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(msg);
  }
}

const shortUrl = (u: string) => u.split("?")[0];

export async function httpJson(f: HttpFetch, url: string, opts: HttpOptions = {}): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 15_000);
  try {
    const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    }
    let res: Awaited<ReturnType<HttpFetch>>;
    try {
      res = await f(url, { method: opts.method ?? (body !== undefined ? "POST" : "GET"), headers, body, signal: ac.signal });
    } catch (e) {
      throw new Error(`HTTP request to ${shortUrl(url)} failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      let detail: unknown;
      try {
        detail = await res.json();
      } catch {
        detail = undefined;
      }
      const msg = detail && typeof detail === "object" ? JSON.stringify(detail).slice(0, 300) : "";
      throw new HttpError(`HTTP ${res.status} from ${shortUrl(url)} ${msg}`.trim(), res.status, detail);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// --- defensive JSON readers -------------------------------------------------

export type J = Record<string, unknown>;
export const obj = (v: unknown): J | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : undefined);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | undefined => (typeof v === "string" && v.length ? v : undefined);
export const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;

/** Non-negative integer from a decimal string / safe integer number / bigint. */
export function big(v: unknown): bigint | undefined {
  if (typeof v === "bigint") return v >= 0n ? v : undefined;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return BigInt(v.trim());
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  return undefined;
}

export const lc = (s: string | undefined | null): string => (s ?? "").toLowerCase();
export const sameAddr = (a: string | undefined | null, b: string | undefined | null): boolean => !!a && !!b && lc(a) === lc(b);
