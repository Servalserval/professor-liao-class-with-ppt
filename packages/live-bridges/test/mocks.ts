/** Offline mocks for EvmEnv / SuiEnv / fetch / LiveContext used by the bridge tests. */
import type { AssetRef, LiveContext, LogLevel } from "@incentive-router/live-common";
import { chainInfo } from "@incentive-router/live-common";
import { Mutex, viemChainFor, type EvmEnv } from "@incentive-router/live-evm-base";
import { Mutex as SuiMutex, Transaction, type SuiEnv } from "@incentive-router/live-sui";
import { keccak256, type Hex, type PublicClient, type WalletClient } from "viem";
import type { FetchLike } from "../src/common.js";

export type ReadHandler = (args: readonly unknown[], address: string) => unknown;

/** Raw "signed tx" bytes of the n-th signature from a mock wallet, and its hash (what sendTx returns). */
export const mockRaw = (n: number): Hex => `0x02${n.toString(16).padStart(8, "0")}`;
export const mockHash = (n: number): Hex => keccak256(mockRaw(n));

class NotFound extends Error {
  override name = "TransactionNotFoundError";
}

export interface MockEvm {
  env: EvmEnv;
  calls: { to: string; data: Hex; value?: bigint }[];
  sent: { to: string; data: Hex; value?: bigint }[];
  reads: { address: string; functionName: string; args: readonly unknown[] }[];
  setRead(fn: string, h: ReadHandler): void;
  logs: unknown[];
  /** fromBlock/toBlock of every getLogs call. */
  logQueries: { fromBlock: bigint; toBlock: bigint }[];
  receipts: Record<string, { logs: unknown[]; status?: "success" | "reverted" }>;
  blockNumber: bigint;
  /** Make eth_call simulation revert for calldata starting with this selector. */
  revertSelector?: string;
  revertMessage?: string;
  /** What waitForTransactionReceipt does after a broadcast. */
  receiptWait: "ok" | "timeout" | "reverted";
  /** sendRawTransaction throws this; with submitAccepted the tx is still in the mempool afterwards. */
  submitError?: string;
  submitAccepted?: boolean;
  /** Nonce the wallet signs the next tx with / the account's confirmed nonce (getTransactionCount latest). */
  nextNonce: number;
  confirmedNonce: number;
}

export function mockEvm(chain: string, account: Hex, opts: { readOnly?: boolean } = {}): MockEvm {
  const readers = new Map<string, ReadHandler>();
  const signed = new Map<Hex, { to: string; data: Hex; value?: bigint }>();
  const mempool = new Set<string>();
  let n = 0;
  const m: MockEvm = {
    env: undefined as unknown as EvmEnv,
    calls: [],
    sent: [],
    reads: [],
    setRead: (fn, h) => readers.set(fn, h),
    logs: [],
    logQueries: [],
    receipts: {},
    blockNumber: 1_000n,
    receiptWait: "ok",
    nextNonce: 0,
    confirmedNonce: 0,
  };
  const publicClient = {
    async getChainId() {
      return chainInfo(chain).evmChainId!;
    },
    async call(req: { to: string; data: Hex; value?: bigint }) {
      m.calls.push({ to: req.to, data: req.data, value: req.value });
      if (m.revertSelector && req.data.startsWith(m.revertSelector)) throw new Error(m.revertMessage ?? "execution reverted: mock");
      return { data: "0x" };
    },
    async estimateGas() {
      return 100_000n;
    },
    async getGasPrice() {
      return 1_000_000_000n; // 1 gwei
    },
    async waitForTransactionReceipt() {
      if (m.receiptWait === "timeout") throw new Error("Timed out while waiting for transaction receipt");
      return { status: m.receiptWait === "reverted" ? "reverted" : "success", gasUsed: 100_000n, effectiveGasPrice: 1_000_000_000n };
    },
    async readContract(req: { address: string; functionName: string; args?: readonly unknown[] }) {
      m.reads.push({ address: req.address, functionName: req.functionName, args: req.args ?? [] });
      const h = readers.get(req.functionName);
      if (!h) throw new Error(`mock ${chain}: no reader for ${req.functionName}`);
      return h(req.args ?? [], req.address);
    },
    async getBlockNumber() {
      return m.blockNumber;
    },
    async getLogs(q: { fromBlock: bigint; toBlock: bigint }) {
      m.logQueries.push({ fromBlock: q.fromBlock, toBlock: q.toBlock });
      return m.logs;
    },
    async getTransactionReceipt(req: { hash: string }) {
      const r = m.receipts[req.hash];
      if (!r) throw Object.assign(new Error(`Transaction receipt with hash "${req.hash}" could not be found.`), { name: "TransactionReceiptNotFoundError" });
      return { status: "success", ...r };
    },
    async sendRawTransaction(req: { serializedTransaction: Hex }) {
      const p = signed.get(req.serializedTransaction)!;
      if (m.submitError) {
        if (m.submitAccepted) mempool.add(keccak256(req.serializedTransaction));
        throw new Error(m.submitError);
      }
      m.sent.push(p);
      mempool.add(keccak256(req.serializedTransaction));
      return keccak256(req.serializedTransaction);
    },
    async getTransactionCount() {
      return m.confirmedNonce;
    },
    async getTransaction(req: { hash: Hex }) {
      if (!mempool.has(req.hash)) throw new NotFound(`Transaction with hash "${req.hash}" could not be found.`);
      return { hash: req.hash };
    },
    async getCode() {
      return "0x6001";
    },
  };
  const walletClient = opts.readOnly
    ? undefined
    : {
        account: { address: account },
        async prepareTransactionRequest(req: { to: string; data: Hex; value?: bigint }) {
          return { ...req, nonce: m.nextNonce++ };
        },
        async signTransaction(req: { to: string; data: Hex; value?: bigint }) {
          n++;
          const raw = mockRaw(n);
          signed.set(raw, { to: req.to, data: req.data, value: req.value });
          return raw;
        },
      };
  m.env = {
    chain,
    viemChain: viemChainFor(chain, "http://127.0.0.1:1"),
    publicClient: publicClient as unknown as PublicClient,
    walletClient: walletClient as unknown as WalletClient | undefined,
    account,
    lock: new Mutex(),
  };
  return m;
}

export interface MockSui {
  env: SuiEnv;
  simulated: unknown[];
  executed: unknown[];
  balance: bigint;
  nonceUsed: boolean;
  digest: string;
  objectTypes: Record<string, string>;
  /** getTransaction result kind per digest (missing -> throws "not found"). */
  txKinds: Record<string, "Transaction" | "FailedTransaction">;
  executeError?: string;
  executeFailed?: boolean;
  waitTimeout?: boolean;
  /** Gas coin the mock "build" selects (replay guard), and current object versions for getObjects. */
  gasRef?: { objectId: string; version: string; digest: string };
  objectVersions: Record<string, string>;
}

// executePtb builds + signs locally (tx.build / tx.getDigest need a real client):
// short-circuit them for mock clients only.
const proto = Transaction.prototype as unknown as Record<string, unknown> & { __mockPatched?: boolean };
if (!proto.__mockPatched) {
  const build = proto.build as (this: unknown, o?: { client?: { __mock?: MockSui } }) => Promise<Uint8Array>;
  const getDigest = proto.getDigest as (this: unknown, o?: { client?: { __mock?: MockSui } }) => Promise<string>;
  proto.build = function (this: unknown, o?: { client?: { __mock?: MockSui } }) {
    const mk = o?.client?.__mock;
    if (!mk) return build.call(this, o);
    if (mk.gasRef) (this as Transaction).setGasPayment([mk.gasRef]);
    return Promise.resolve(new Uint8Array([1, 2, 3]));
  };
  proto.getDigest = function (this: unknown, o?: { client?: { __mock?: MockSui } }) {
    return o?.client?.__mock ? Promise.resolve(o.client.__mock.digest) : getDigest.call(this, o);
  };
  proto.__mockPatched = true;
}

export function mockSui(address: string): MockSui {
  const m: MockSui = { env: undefined as unknown as SuiEnv, simulated: [], executed: [], balance: 0n, nonceUsed: false, digest: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", objectTypes: {}, txKinds: {}, objectVersions: {} };
  const gasUsed = { computationCost: "1000000", storageCost: "2000000", storageRebate: "1000000", nonRefundableStorageFee: "0" };
  const core = {
    async simulateTransaction(o: { transaction: unknown; include?: { commandResults?: boolean } }) {
      m.simulated.push(o.transaction);
      return {
        $kind: "Transaction",
        Transaction: { effects: { gasUsed } },
        commandResults: o.include?.commandResults ? [{ returnValues: [{ bcs: new Uint8Array([m.nonceUsed ? 1 : 0]) }], mutatedReferences: [] }] : undefined,
        gasPaymentMocked: false,
      };
    },
    async executeTransaction(o: { transaction: unknown }) {
      if (m.executeError) throw new Error(m.executeError);
      m.executed.push(o.transaction);
      if (m.executeFailed) return { $kind: "FailedTransaction", FailedTransaction: { digest: m.digest, status: { success: false, error: "abort" } } };
      return { $kind: "Transaction", Transaction: { digest: m.digest, effects: { gasUsed } } };
    },
    async waitForTransaction() {
      if (m.waitTimeout) throw new Error("timeout waiting for checkpoint");
      return {};
    },
    async getTransaction(o: { digest: string }) {
      const k = m.txKinds[o.digest];
      if (!k) throw new Error(`mock sui: tx ${o.digest} not found`);
      return { $kind: k, [k]: { digest: o.digest } };
    },
    async getBalance() {
      return { balance: { balance: m.balance.toString() } };
    },
    async getObjects(o: { objectIds: string[] }) {
      return {
        objects: o.objectIds.map((id) =>
          m.objectTypes[id] || m.objectVersions[id] ? { objectId: id, type: m.objectTypes[id] ?? "0x2::coin::Coin<0x2::sui::SUI>", version: m.objectVersions[id] ?? "1" } : new Error("not found")
        ),
      };
    },
  };
  m.env = {
    network: "mainnet",
    grpc: { core, __mock: m } as unknown as SuiEnv["grpc"],
    jsonRpc: {} as unknown as SuiEnv["jsonRpc"],
    keypair: { signTransaction: async () => ({ signature: "c2ln", bytes: "AQID" }) } as unknown as SuiEnv["keypair"],
    address,
    lock: new SuiMutex(),
  };
  return m;
}

export interface MockFetch {
  fetch: FetchLike;
  urls: string[];
  /** "METHOD url" for every request. */
  requests: string[];
  route(prefix: string, h: (url: string, method: string) => { status: number; body?: unknown }): void;
}

export function mockFetch(): MockFetch {
  const routes: [string, (url: string, method: string) => { status: number; body?: unknown }][] = [];
  const urls: string[] = [];
  const requests: string[] = [];
  return {
    urls,
    requests,
    route: (p, h) => routes.unshift([p, h]),
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      urls.push(url);
      requests.push(`${method} ${url}`);
      const r = routes.find(([p]) => url.includes(p));
      const res = r ? r[1](url, method) : { status: 404 };
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => res.body,
        text: async () => JSON.stringify(res.body ?? ""),
      };
    },
  };
}

export function mockCtx(dryRun = false, price = 1, logs: { level: LogLevel; msg: string }[] = []): LiveContext {
  return {
    dryRun,
    log: (level, msg) => logs.push({ level, msg }),
    limits: { maxGasUsd: { default: 1_000 }, maxSlippageBps: 30, maxLoopIterations: 5 },
    priceUsd: async (_a: AssetRef) => price,
    nativePriceUsd: async (chain: string) => (chain === "sui" ? 2 : 3_000),
  };
}
