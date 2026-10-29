/**
 * Circle Iris API (CCTP V2) client + CCTP V2 message decoding + fee math.
 *
 * Endpoints (SOURCE: https://developers.circle.com/api-reference/cctp/all/get-burn-usdc-fees,
 *            https://developers.circle.com/api-reference/cctp/all/get-messages-v2,
 *            https://developers.circle.com/api-reference/cctp/all/get-fast-burn-usdc-allowance):
 *   GET /v2/burn/USDC/fees/{sourceDomainId}/{destDomainId} -> [{ finalityThreshold, minimumFee (bps) }]
 *   GET /v2/messages/{sourceDomainId}?transactionHash=0x.. -> { messages: [...] }  (Sui source: base58 digest, no 0x)
 *   GET /v2/fastBurn/USDC/allowance -> { allowance (whole USDC, 6dp), lastUpdated }
 * Rate limit 40 req/s; 429 blocks the caller for 5 minutes (JsonClient throttles + backs off).
 */
import { hexToBigInt, hexToNumber, size, slice, type Hex } from "viem";
import { ceilDiv, JsonClient, type FetchLike } from "../common.js";
import { IRIS_MAINNET } from "./constants.js";

export interface IrisFeeEntry {
  finalityThreshold: number;
  /** bps; may be fractional (1.3 = 0.013%). */
  minimumFee: number;
}

export interface IrisDecodedBody {
  burnToken?: string;
  mintRecipient?: string;
  amount?: string;
  messageSender?: string;
  maxFee?: string;
  feeExecuted?: string;
  expirationBlock?: string;
  hookData?: string;
}

export interface IrisMessage {
  /** "0x" until attested. */
  message: string;
  eventNonce?: string;
  /** "PENDING" (or null) until attested. */
  attestation: string | null;
  /** "complete" | "pending_confirmations" */
  status: string;
  delayReason?: string | null;
  cctpVersion?: number;
  decodedMessage?: {
    sourceDomain?: string;
    destinationDomain?: string;
    nonce?: string;
    sender?: string;
    recipient?: string;
    destinationCaller?: string;
    minFinalityThreshold?: string;
    finalityThresholdExecuted?: string;
    messageBody?: string;
    decodedMessageBody?: IrisDecodedBody | null;
  } | null;
  destinationMintTxHash?: string;
}

export class IrisClient {
  private readonly http: JsonClient;
  constructor(baseUrl: string = IRIS_MAINNET, fetchFn?: FetchLike, opts?: { minIntervalMs?: number; now?: () => number }) {
    // 60 ms spacing: a fast + a standard instance together stay under Iris' 40 req/s.
    this.http = new JsonClient(baseUrl, fetchFn, { minIntervalMs: opts?.minIntervalMs ?? 60, now: opts?.now });
  }

  async fees(srcDomain: number, dstDomain: number): Promise<IrisFeeEntry[]> {
    const j = await this.http.get<unknown>(`/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`);
    if (j === null) throw new Error(`iris: no fee data for ${srcDomain}->${dstDomain}`);
    return parseFees(j);
  }

  /** Remaining global Fast Transfer allowance, USDC base units (6 dp). */
  async fastAllowance(): Promise<bigint> {
    const j = await this.http.get<{ allowance?: unknown }>(`/v2/fastBurn/USDC/allowance`);
    const a = j?.allowance;
    if (typeof a !== "number" || !Number.isFinite(a) || a < 0) throw new Error(`iris: bad fast allowance response ${JSON.stringify(j)}`);
    return BigInt(Math.floor(a * 1e6 + 1e-6));
  }

  /** Messages for a source tx; [] when Iris has not indexed it yet (404). */
  async messages(srcDomain: number, txHash: string): Promise<IrisMessage[]> {
    const j = await this.http.get<unknown>(`/v2/messages/${srcDomain}?transactionHash=${encodeURIComponent(txHash)}`);
    if (j === null) return [];
    return parseMessages(j);
  }
}

export function parseFees(j: unknown): IrisFeeEntry[] {
  if (!Array.isArray(j)) throw new Error(`iris: fee response is not an array: ${JSON.stringify(j).slice(0, 200)}`);
  return j.map((e) => {
    const ft = Number((e as Record<string, unknown>).finalityThreshold);
    const mf = Number((e as Record<string, unknown>).minimumFee);
    if (!Number.isFinite(ft) || !Number.isFinite(mf) || mf < 0) throw new Error(`iris: bad fee entry ${JSON.stringify(e)}`);
    return { finalityThreshold: ft, minimumFee: mf };
  });
}

export function parseMessages(j: unknown): IrisMessage[] {
  const arr = (j as { messages?: unknown })?.messages;
  if (!Array.isArray(arr)) throw new Error(`iris: messages response has no messages[]: ${JSON.stringify(j).slice(0, 200)}`);
  return arr.map((m) => {
    const r = m as Record<string, unknown>;
    return {
      message: typeof r.message === "string" ? r.message : "0x",
      eventNonce: typeof r.eventNonce === "string" ? r.eventNonce : undefined,
      attestation: typeof r.attestation === "string" ? r.attestation : null,
      status: typeof r.status === "string" ? r.status : "unknown",
      delayReason: typeof r.delayReason === "string" ? r.delayReason : null,
      cctpVersion: typeof r.cctpVersion === "number" ? r.cctpVersion : undefined,
      decodedMessage: (r.decodedMessage as IrisMessage["decodedMessage"]) ?? null,
      destinationMintTxHash: typeof r.destinationMintTxHash === "string" ? r.destinationMintTxHash : undefined,
    };
  });
}

/** Attestation is signed and the message bytes are available. */
export function isAttested(m: IrisMessage): m is IrisMessage & { message: Hex; attestation: Hex } {
  return (
    m.status === "complete" &&
    typeof m.attestation === "string" &&
    m.attestation.startsWith("0x") &&
    m.attestation.length > 2 &&
    typeof m.message === "string" &&
    m.message.startsWith("0x") &&
    m.message.length > 2
  );
}

// ---------------------------------------------------------------------------
// Fee math
// ---------------------------------------------------------------------------

/**
 * maxFee for depositForBurn: ceil(amount * minimumFeeBps / 1e4 * (1 + marginBps / 1e4)).
 * Integer math in micro-bps so fractional bps (1.3) are exact. 0 bps -> 0.
 * A non-zero fee is at least 1 unit (TokenMessengerV2._calcMinFeeAmount floors at 1).
 */
export function cctpMaxFee(amount: bigint, minimumFeeBps: number, marginBps: number): bigint {
  if (!(minimumFeeBps >= 0) || !Number.isFinite(minimumFeeBps)) throw new Error(`cctpMaxFee: bad fee bps ${minimumFeeBps}`);
  if (!(marginBps >= 0)) throw new Error(`cctpMaxFee: bad margin ${marginBps}`);
  if (minimumFeeBps === 0 || amount <= 0n) return 0n;
  const microBps = BigInt(Math.round(minimumFeeBps * 1_000_000));
  const margin = BigInt(10_000 + Math.round(marginBps));
  const fee = ceilDiv(amount * microBps * margin, 10_000n * 1_000_000n * 10_000n);
  return fee < 1n ? 1n : fee;
}

export function pickFee(entries: IrisFeeEntry[], finalityThreshold: number): IrisFeeEntry | undefined {
  return entries.find((e) => e.finalityThreshold === finalityThreshold);
}

// ---------------------------------------------------------------------------
// Message decoding (packed layout)
// SOURCE: https://github.com/circlefin/evm-cctp-contracts/blob/master/src/messages/v2/MessageV2.sol
// SOURCE: https://github.com/circlefin/evm-cctp-contracts/blob/master/src/messages/v2/BurnMessageV2.sol
// ---------------------------------------------------------------------------

export interface DecodedCctpMessage {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body?: {
    version: number;
    burnToken: Hex;
    mintRecipient: Hex;
    amount: bigint;
    messageSender: Hex;
    maxFee: bigint;
    feeExecuted: bigint;
    expirationBlock: bigint;
  };
}

const MESSAGE_BODY_INDEX = 148;
const BURN_BODY_MIN = 228;

export function decodeCctpMessage(message: Hex): DecodedCctpMessage {
  if (size(message) < MESSAGE_BODY_INDEX) throw new Error(`cctp message too short (${size(message)} bytes)`);
  const u32 = (s: number) => hexToNumber(slice(message, s, s + 4));
  const b32 = (s: number) => slice(message, s, s + 32);
  const out: DecodedCctpMessage = {
    version: u32(0),
    sourceDomain: u32(4),
    destinationDomain: u32(8),
    nonce: b32(12),
    sender: b32(44),
    recipient: b32(76),
    destinationCaller: b32(108),
    minFinalityThreshold: u32(140),
    finalityThresholdExecuted: u32(144),
  };
  if (size(message) >= MESSAGE_BODY_INDEX + BURN_BODY_MIN) {
    const o = MESSAGE_BODY_INDEX;
    out.body = {
      version: u32(o),
      burnToken: b32(o + 4),
      mintRecipient: b32(o + 36),
      amount: hexToBigInt(b32(o + 68)),
      messageSender: b32(o + 100),
      maxFee: hexToBigInt(b32(o + 132)),
      feeExecuted: hexToBigInt(b32(o + 164)),
      expirationBlock: hexToBigInt(b32(o + 196)),
    };
  }
  return out;
}

/** Net amount minted on the destination (amount - feeExecuted), from bytes first then Iris' decoded view. */
export function receivedFromMessage(m: IrisMessage): bigint | undefined {
  try {
    if (m.message && m.message !== "0x") {
      const d = decodeCctpMessage(m.message as Hex);
      if (d.body) return d.body.amount - d.body.feeExecuted;
    }
  } catch {
    /* fall through */
  }
  const b = m.decodedMessage?.decodedMessageBody;
  if (b?.amount !== undefined) {
    try {
      return BigInt(b.amount) - BigInt(b.feeExecuted ?? b.maxFee ?? "0");
    } catch {
      return undefined;
    }
  }
  return undefined;
}
