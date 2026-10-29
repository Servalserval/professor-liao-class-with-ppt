/**
 * EVM plumbing shared by every EVM live package.
 *
 * The one rule: nothing is broadcast without first being simulated with
 * eth_call from our own address and priced in USD against the per-chain gas
 * cap. In dry-run mode the pipeline stops after simulation and returns a
 * TxRecord with simulated=true.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { chainInfo, type AssetRef, type LiveContext, type TxRecord } from "@incentive-router/live-common";

export { erc20Abi };
export type { Abi, Address, Hex, PublicClient, WalletClient };

export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

export interface EvmEnv {
  chain: string;
  viemChain: Chain;
  publicClient: PublicClient;
  /** Absent in read-only mode. */
  walletClient?: WalletClient;
  account: Address;
  /** Serializes writes per chain so nonces never race. */
  lock: Mutex;
}

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

export function viemChainFor(chain: string, rpcUrl: string): Chain {
  const info = chainInfo(chain);
  if (info.family !== "evm" || info.evmChainId === undefined) throw new Error(`${chain} is not an EVM chain`);
  return defineChain({
    id: info.evmChainId,
    name: chain,
    nativeCurrency: { name: info.nativeSymbol, symbol: info.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}

/**
 * Build an EvmEnv. Pass `privateKey` for write access; omit it (and pass
 * `address`) for read-only monitoring.
 */
export function makeEvmEnv(args: { chain: string; rpcUrl: string; privateKey?: string; address?: Address }): EvmEnv {
  const viemChain = viemChainFor(args.chain, args.rpcUrl);
  const transport = http(args.rpcUrl, { retryCount: 2, timeout: 20_000 });
  const publicClient = createPublicClient({ chain: viemChain, transport }) as PublicClient;
  let account: PrivateKeyAccount | undefined;
  if (args.privateKey) {
    const pk = (args.privateKey.startsWith("0x") ? args.privateKey : `0x${args.privateKey}`) as Hex;
    account = privateKeyToAccount(pk);
  }
  const address = account?.address ?? args.address;
  if (!address) throw new Error(`makeEvmEnv(${args.chain}): need privateKey or address`);
  const walletClient = account ? (createWalletClient({ account, chain: viemChain, transport }) as WalletClient) : undefined;
  return { chain: args.chain, viemChain, publicClient, walletClient, account: address, lock: new Mutex() };
}

/** Check the RPC really serves the chain we think it does. */
export async function assertChainId(env: EvmEnv): Promise<void> {
  const id = await env.publicClient.getChainId();
  if (id !== env.viemChain.id) throw new Error(`${env.chain}: RPC reports chainId ${id}, expected ${env.viemChain.id}`);
}

export interface TxRequest {
  to: Address;
  data: Hex;
  value?: bigint;
  description: string;
  /** Override gas cap for this tx (USD). */
  maxGasUsd?: number;
}

export class SimulationError extends Error {
  constructor(
    msg: string,
    readonly request: TxRequest
  ) {
    super(msg);
  }
}

/**
 * Simulate -> price gas -> (dry-run stop) -> send -> wait receipt.
 * Throws SimulationError on revert, Error on gas cap or failed receipt.
 */
export async function sendTx(env: EvmEnv, ctx: LiveContext, req: TxRequest): Promise<TxRecord> {
  return env.lock.run(async () => {
    try {
      await env.publicClient.call({ account: env.account, to: req.to, data: req.data, value: req.value });
    } catch (e) {
      throw new SimulationError(`${env.chain}: simulation reverted for "${req.description}": ${(e as Error).message.split("\n")[0]}`, req);
    }
    const gas = await env.publicClient.estimateGas({ account: env.account, to: req.to, data: req.data, value: req.value });
    const gasPrice = await env.publicClient.getGasPrice();
    const native = await ctx.nativePriceUsd(env.chain);
    const gasUsd = (Number(gas * gasPrice) / 1e18) * native;
    const cap = req.maxGasUsd ?? ctx.limits.maxGasUsd[env.chain] ?? ctx.limits.maxGasUsd.default ?? 5;
    if (gasUsd > cap) throw new Error(`${env.chain}: "${req.description}" gas $${gasUsd.toFixed(2)} > cap $${cap}`);

    if (ctx.dryRun) {
      ctx.log("info", `[dry-run] ${env.chain}: ${req.description}`, { gasUsd });
      return { chain: env.chain, description: req.description, gasUsd, simulated: true };
    }
    if (!env.walletClient) throw new Error(`${env.chain}: no signer (read-only env) for "${req.description}"`);
    const hash = await env.walletClient.sendTransaction({
      account: env.walletClient.account!,
      chain: env.viemChain,
      to: req.to,
      data: req.data,
      value: req.value,
      gas: (gas * 12n) / 10n,
    });
    ctx.log("info", `${env.chain}: sent ${req.description}`, { hash });
    const receipt = await env.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`${env.chain}: tx ${hash} reverted on-chain (${req.description})`);
    const realGasUsd = (Number(receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice)) / 1e18) * native;
    return { chain: env.chain, id: hash, description: req.description, gasUsd: realGasUsd, simulated: false };
  });
}

export function call(abi: Abi, functionName: string, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
}

export async function erc20Balance(env: EvmEnv, token: Address, owner: Address = env.account): Promise<bigint> {
  return env.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

export async function erc20Meta(env: EvmEnv, token: Address): Promise<{ symbol: string; decimals: number }> {
  const [symbol, decimals] = await Promise.all([
    env.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    env.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { symbol, decimals };
}

/**
 * Approve exactly what is needed (never infinite). Some tokens (USDT on
 * Ethereum) require resetting to 0 before changing a non-zero allowance.
 */
export async function ensureAllowance(env: EvmEnv, ctx: LiveContext, token: Address, spender: Address, amount: bigint): Promise<TxRecord[]> {
  const cur = await env.publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [env.account, spender] });
  if (cur >= amount) return [];
  const out: TxRecord[] = [];
  if (cur > 0n)
    out.push(await sendTx(env, ctx, { to: token, data: call(erc20Abi, "approve", [spender, 0n]), description: `reset allowance ${token} -> ${spender}` }));
  out.push(await sendTx(env, ctx, { to: token, data: call(erc20Abi, "approve", [spender, amount]), description: `approve ${amount} ${token} -> ${spender}` }));
  return out;
}

/** Sanity check an AssetRef against the chain (symbol + decimals). Used by verify. */
export async function verifyAsset(env: EvmEnv, a: AssetRef): Promise<string[]> {
  const issues: string[] = [];
  const code = await env.publicClient.getCode({ address: a.address as Address });
  if (!code || code === "0x") return [`${a.chain}:${a.symbol} ${a.address} has no code`];
  const m = await erc20Meta(env, a.address as Address);
  if (m.decimals !== a.decimals) issues.push(`${a.chain}:${a.symbol} decimals ${m.decimals} != config ${a.decimals}`);
  if (m.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "") !== a.symbol.toUpperCase().replace(/[^A-Z0-9]/g, ""))
    issues.push(`${a.chain}:${a.symbol} on-chain symbol is "${m.symbol}" (check the address)`);
  return issues;
}
