/** Offline mocks for EvmEnv / SuiEnv / fetch / LiveContext used by the bridge tests. */
import type { AssetRef, LiveContext, LogLevel } from "@incentive-router/live-common";
import { chainInfo } from "@incentive-router/live-common";
import { Mutex, viemChainFor, type EvmEnv } from "@incentive-router/live-evm-base";
import { Mutex as SuiMutex, type SuiEnv } from "@incentive-router/live-sui";
import type { Hex, PublicClient, WalletClient } from "viem";
import type { FetchLike } from "../src/common.js";

export type ReadHandler = (args: readonly unknown[], address: string) => unknown;

export interface MockEvm {
  env: EvmEnv;
  calls: { to: string; data: Hex; value?: bigint }[];
  sent: { to: string; data: Hex; value?: bigint }[];
  reads: { address: string; functionName: string; args: readonly unknown[] }[];
  setRead(fn: string, h: ReadHandler): void;
  logs: unknown[];
  receipts: Record<string, { logs: unknown[] }>;
  blockNumber: bigint;
  /** Make eth_call simulation revert for calldata starting with this selector. */
  revertSelector?: string;
}

export function mockEvm(chain: string, account: Hex, opts: { readOnly?: boolean } = {}): MockEvm {
  const readers = new Map<string, ReadHandler>();
  let n = 0;
  const m: MockEvm = {
    env: undefined as unknown as EvmEnv,
    calls: [],
    sent: [],
    reads: [],
    setRead: (fn, h) => readers.set(fn, h),
    logs: [],
    receipts: {},
    blockNumber: 1_000n,
  };
  const publicClient = {
    async getChainId() {
      return chainInfo(chain).evmChainId!;
    },
    async call(req: { to: string; data: Hex; value?: bigint }) {
      m.calls.push({ to: req.to, data: req.data, value: req.value });
      if (m.revertSelector && req.data.startsWith(m.revertSelector)) throw new Error("execution reverted: mock");
      return { data: "0x" };
    },
    async estimateGas() {
      return 100_000n;
    },
    async getGasPrice() {
      return 1_000_000_000n; // 1 gwei
    },
    async waitForTransactionReceipt() {
      return { status: "success", gasUsed: 100_000n, effectiveGasPrice: 1_000_000_000n };
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
    async getLogs() {
      return m.logs;
    },
    async getTransactionReceipt(req: { hash: string }) {
      const r = m.receipts[req.hash];
      if (!r) throw new Error(`mock ${chain}: no receipt ${req.hash}`);
      return r;
    },
    async getCode() {
      return "0x6001";
    },
  };
  const walletClient = opts.readOnly
    ? undefined
    : {
        account: { address: account },
        async sendTransaction(req: { to: string; data: Hex; value?: bigint }) {
          m.sent.push({ to: req.to, data: req.data, value: req.value });
          n++;
          return `0x${n.toString(16).padStart(64, "0")}` as Hex;
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
}

export function mockSui(address: string): MockSui {
  const m: MockSui = { env: undefined as unknown as SuiEnv, simulated: [], executed: [], balance: 0n, nonceUsed: false, digest: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", objectTypes: {} };
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
    async signAndExecuteTransaction(o: { transaction: unknown }) {
      m.executed.push(o.transaction);
      return { $kind: "Transaction", Transaction: { digest: m.digest, effects: { gasUsed } } };
    },
    async waitForTransaction() {
      return {};
    },
    async getBalance() {
      return { balance: { balance: m.balance.toString() } };
    },
    async getObjects(o: { objectIds: string[] }) {
      return { objects: o.objectIds.map((id) => (m.objectTypes[id] ? { objectId: id, type: m.objectTypes[id] } : new Error("not found"))) };
    },
  };
  m.env = {
    network: "mainnet",
    grpc: { core } as unknown as SuiEnv["grpc"],
    jsonRpc: {} as unknown as SuiEnv["jsonRpc"],
    keypair: {} as unknown as SuiEnv["keypair"],
    address,
    lock: new SuiMutex(),
  };
  return m;
}

export interface MockFetch {
  fetch: FetchLike;
  urls: string[];
  route(prefix: string, h: (url: string) => { status: number; body?: unknown }): void;
}

export function mockFetch(): MockFetch {
  const routes: [string, (url: string) => { status: number; body?: unknown }][] = [];
  const urls: string[] = [];
  return {
    urls,
    route: (p, h) => routes.unshift([p, h]),
    fetch: async (url) => {
      urls.push(url);
      const r = routes.find(([p]) => url.includes(p));
      const res = r ? r[1](url) : { status: 404 };
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
