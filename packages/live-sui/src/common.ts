/**
 * Sui plumbing shared by every Sui adapter in this package (Navi, Suilend,
 * Scallop, AlphaLend, Cetus swaps). All of them use the same @mysten/sui 2.x,
 * so one Transaction (PTB) can contain calls into several protocols.
 *
 * The one rule (same as EVM): nothing is executed without first being
 * simulated from our own address with real gas coins and priced against the
 * gas cap. dry-run stops after simulation.
 */
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import type { LiveContext, TxRecord } from "@incentive-router/live-common";

export { Transaction, normalizeStructTag, normalizeSuiAddress };

export const SUI_TYPE = "0x2::sui::SUI";
const MIST_PER_SUI = 1_000_000_000n;

export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export interface SuiEnv {
  network: "mainnet" | "testnet";
  grpc: SuiGrpcClient;
  /** Some protocol SDKs still take a JSON-RPC client. */
  jsonRpc: SuiJsonRpcClient;
  keypair?: Ed25519Keypair;
  address: string;
  /** Serializes writes: owned coins/objects must not be used by two txs at once. */
  lock: Mutex;
}

export function keypairFromSecret(secret: string): Ed25519Keypair {
  if (secret.startsWith("suiprivkey")) {
    const { scheme, secretKey } = decodeSuiPrivateKey(secret);
    if (scheme !== "ED25519") throw new Error(`unsupported Sui key scheme ${scheme} (only ED25519)`);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  return Ed25519Keypair.fromSecretKey(Buffer.from(secret, "base64").subarray(-32));
}

export function makeSuiEnv(args: {
  grpcUrl: string;
  jsonRpcUrl: string;
  network?: "mainnet" | "testnet";
  secret?: string;
  address?: string;
}): SuiEnv {
  const network = args.network ?? "mainnet";
  const keypair = args.secret ? keypairFromSecret(args.secret) : undefined;
  const address = keypair?.toSuiAddress() ?? (args.address ? normalizeSuiAddress(args.address) : undefined);
  if (!address) throw new Error("makeSuiEnv: need secret or address");
  return {
    network,
    grpc: new SuiGrpcClient({ network, baseUrl: args.grpcUrl }),
    jsonRpc: new SuiJsonRpcClient({ network, url: args.jsonRpcUrl }),
    keypair,
    address,
    lock: new Mutex(),
  };
}

export class SuiSimulationError extends Error {}

function gasMist(g: { computationCost: string; storageCost: string; storageRebate: string }): bigint {
  return BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
}

/**
 * Simulate -> price gas -> (dry-run stop) -> sign + execute -> wait.
 * Throws SuiSimulationError when the simulation fails (Move abort etc.).
 */
export async function executePtb(env: SuiEnv, ctx: LiveContext, tx: Transaction, description: string): Promise<TxRecord> {
  return env.lock.run(async () => {
    tx.setSenderIfNotSet(env.address);
    const sim = await env.grpc.core.simulateTransaction({ transaction: tx, include: { effects: true } });
    if (sim.$kind === "FailedTransaction") {
      const err = sim.FailedTransaction.status.success ? "unknown" : JSON.stringify(sim.FailedTransaction.status.error);
      throw new SuiSimulationError(`sui: simulation failed for "${description}": ${err}`);
    }
    if (sim.gasPaymentMocked) ctx.log("warn", `sui: "${description}" simulated with mocked gas (wallet has no SUI?)`);
    const g = sim.Transaction.effects?.gasUsed;
    const suiPrice = await ctx.nativePriceUsd("sui");
    const gasUsd = g ? (Number(gasMist(g)) / Number(MIST_PER_SUI)) * suiPrice : 0;
    const cap = ctx.limits.maxGasUsd.sui ?? ctx.limits.maxGasUsd.default ?? 2;
    if (gasUsd > cap) throw new Error(`sui: "${description}" gas $${gasUsd.toFixed(3)} > cap $${cap}`);

    if (ctx.dryRun) {
      ctx.log("info", `[dry-run] sui: ${description}`, { gasUsd });
      return { chain: "sui", description, gasUsd, simulated: true };
    }
    if (!env.keypair) throw new Error(`sui: no signer (read-only env) for "${description}"`);
    const res = await env.grpc.core.signAndExecuteTransaction({ transaction: tx, signer: env.keypair, include: { effects: true } });
    if (res.$kind === "FailedTransaction") {
      throw new Error(`sui: tx ${res.FailedTransaction.digest} failed on-chain (${description}): ${JSON.stringify(res.FailedTransaction.status)}`);
    }
    const digest = res.Transaction.digest;
    ctx.log("info", `sui: executed ${description}`, { digest });
    await env.grpc.core.waitForTransaction({ digest, timeout: 60_000 });
    const realGas = res.Transaction.effects?.gasUsed;
    return {
      chain: "sui",
      id: digest,
      description,
      gasUsd: realGas ? (Number(gasMist(realGas)) / Number(MIST_PER_SUI)) * suiPrice : gasUsd,
      simulated: false,
    };
  });
}

/** Simulate only; true when it would succeed. Used for exit-path probes. */
export async function simulateOk(env: SuiEnv, tx: Transaction): Promise<boolean> {
  tx.setSenderIfNotSet(env.address);
  try {
    const sim = await env.grpc.core.simulateTransaction({ transaction: tx, include: { effects: true } });
    return sim.$kind === "Transaction";
  } catch {
    return false;
  }
}

export async function coinBalance(env: SuiEnv, coinType: string, owner: string = env.address): Promise<bigint> {
  const r = await env.grpc.core.getBalance({ owner, coinType: normalizeStructTag(coinType) });
  return BigInt(r.balance.balance);
}

// ---------------------------------------------------------------------------
// Swaps inside a PTB (stable-pair loops convert debt -> collateral in the same tx)
// ---------------------------------------------------------------------------

import type { TransactionObjectArgument } from "@mysten/sui/transactions";
export type { TransactionObjectArgument };

export interface PtbSwapQuote {
  amountIn: bigint;
  amountOut: bigint;
  /** Fees + price impact vs mid, bps. */
  costBps: number;
  /** Opaque route data for appendSwap (must be from this quote). */
  routeData: unknown;
}

/**
 * Implemented by the Cetus aggregator module (src/swap). Lending adapters take
 * one by injection and never call an aggregator API directly.
 */
export interface PtbSwapper {
  quote(fromType: string, toType: string, amountIn: bigint): Promise<PtbSwapQuote>;
  /**
   * Append swap commands to `tx` consuming `coinIn` and return the output coin
   * argument. `minOut` must be enforced on-chain (the PTB aborts below it).
   */
  appendSwap(
    tx: Transaction,
    args: { fromType: string; toType: string; coinIn: TransactionObjectArgument; quote: PtbSwapQuote; minOut: bigint }
  ): Promise<TransactionObjectArgument>;
}
