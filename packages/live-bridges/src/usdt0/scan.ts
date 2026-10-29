/**
 * LayerZero Scan API, used ONLY to detect failed / blocked messages. The
 * authoritative completion signal is the destination OFTReceived(guid) log.
 *
 * Endpoint and shape are UNVERIFIED in this sandbox (docs.layerzero.network
 * blocked): GET {base}/messages/tx/{srcTxHash} -> { data: [{ guid, status: { name },
 * destination: { tx: { txHash } } }] }. Parsing is defensive: anything
 * unrecognized maps to "unknown" (treated as pending).
 */
import { JsonClient, type FetchLike } from "../common.js";
import { LZ_SCAN_MAINNET } from "./constants.js";

export type LzScanState = "delivered" | "inflight" | "failed" | "recoverable" | "unknown";

export interface LzScanMessage {
  guid?: string;
  statusName: string;
  state: LzScanState;
  dstTxHash?: string;
  message?: string;
}

/** Status names -> our states. Names not listed are "unknown" (pending). */
const STATUS_MAP: Record<string, LzScanState> = {
  DELIVERED: "delivered",
  INFLIGHT: "inflight",
  CONFIRMING: "inflight",
  // lzReceive reverted / pathway blocked: the payload can be retried, money is not lost
  PAYLOAD_STORED: "recoverable",
  BLOCKED: "recoverable",
  FAILED: "failed",
  APPLICATION_BURNED: "failed",
  APPLICATION_SKIPPED: "failed",
  UNRESOLVABLE_COMMAND: "failed",
  MALFORMED_COMMAND: "failed",
};

export function mapScanStatus(name: string | undefined): LzScanState {
  if (!name) return "unknown";
  return STATUS_MAP[name.toUpperCase()] ?? "unknown";
}

export function parseScanMessages(j: unknown): LzScanMessage[] {
  const root = j as { data?: unknown; messages?: unknown } | null;
  const arr = Array.isArray(root?.data) ? root!.data : Array.isArray(root?.messages) ? root!.messages : [];
  return (arr as Record<string, unknown>[]).map((m) => {
    const st = m.status as { name?: unknown; message?: unknown } | string | undefined;
    const name = typeof st === "string" ? st : typeof st?.name === "string" ? st.name : "";
    const dst = m.destination as { tx?: { txHash?: unknown } } | undefined;
    const dstTx = typeof dst?.tx?.txHash === "string" ? dst.tx.txHash : typeof m.dstTxHash === "string" ? m.dstTxHash : undefined;
    return {
      guid: typeof m.guid === "string" ? m.guid : undefined,
      statusName: name,
      state: mapScanStatus(name),
      dstTxHash: dstTx,
      message: typeof st === "object" && typeof st?.message === "string" ? st.message : undefined,
    };
  });
}

export class LzScanClient {
  private readonly http: JsonClient;
  constructor(baseUrl: string = LZ_SCAN_MAINNET, fetchFn?: FetchLike) {
    this.http = new JsonClient(baseUrl, fetchFn, { minIntervalMs: 200 });
  }

  async byTx(txHash: string): Promise<LzScanMessage[]> {
    const j = await this.http.get<unknown>(`/messages/tx/${txHash}`);
    return j === null ? [] : parseScanMessages(j);
  }
}
