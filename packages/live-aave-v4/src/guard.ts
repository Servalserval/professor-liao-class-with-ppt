/**
 * Transaction guard. Every transaction this adapter sends — the ones it
 * encodes itself AND any request built server-side by AaveKit — is checked
 * here before it reaches sendTx (which then simulates, prices gas and stops
 * in dry-run).
 *
 * Rules
 *  - no native value, `from`/`chainId` (when present) must be ours;
 *  - `to` must be allowlisted: the configured spoke(s), configured position
 *    managers / extra targets, or an ERC20 we approve;
 *  - ERC20: only `approve`, spender allowlisted, amount == exactly what we
 *    asked for, never "unlimited" (>= 2^255);
 *  - Spoke: decoded with the verified ISpoke ABI; function, reserveId, amount,
 *    collateral flag and onBehalfOf (== our account) must match what we asked
 *    for; `multicall` is decoded one level deep (nested multicall refused);
 *  - calldata must be the canonical encoding of the decoded call (no trailing
 *    bytes smuggled past the decoder);
 *  - anything we cannot decode is refused unless its target is explicitly in
 *    `allowUndecoded` (listed in VERIFY_LIVE).
 */
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, isAddress, type Address, type Hex } from "viem";
import type { ExecutionPlan } from "@aave/client";
import { SPOKE_ABI } from "./abi.js";

const UNLIMITED = 1n << 255n;

export interface TxGuardPolicy {
  chainId: number;
  account: Address;
  spokes: Address[];
  positionManagers?: Address[];
  /** ERC20 tokens we may approve (pair assets). */
  tokens: Address[];
  /** Extra allowlisted call targets (constructor `allowedTargets`). Undecodable -> still refused unless also in allowUndecoded. */
  extraTargets?: Address[];
  /** Explicit opt-in: targets whose calldata may be sent without decoding (e.g. a rewards claimer). */
  allowUndecoded?: Address[];
}

export type SpokeCallSpec =
  | { fn: "supply" | "withdraw" | "borrow" | "repay"; reserveId: bigint; amount: bigint }
  | { fn: "setUsingAsCollateral"; reserveId: bigint; enabled: boolean };

export type ExpectedCall =
  | { kind: "approve"; token: Address; spender: Address; amount: bigint }
  /** One spoke call, or several (= Spoke.multicall with exactly these inner calls, in order). */
  | { kind: "spoke"; spoke: Address; calls: SpokeCallSpec[] }
  /** A call we cannot decode; allowed only when `to` is in policy.allowUndecoded. */
  | { kind: "opaque"; to: Address };

export interface TxLike {
  to: string;
  data: Hex | string;
  value?: bigint;
  from?: string;
  chainId?: number;
}

export class TxGuardError extends Error {
  constructor(
    readonly problems: string[],
    readonly tx: TxLike
  ) {
    super(`refusing transaction to ${tx.to}: ${problems.join("; ")}`);
  }
}

const lc = (a: string) => a.toLowerCase();
const inSet = (a: string, xs: readonly string[] | undefined) => !!xs && xs.some((x) => lc(x) === lc(a));

function allowlist(p: TxGuardPolicy): string[] {
  return [...p.spokes, ...(p.positionManagers ?? []), ...p.tokens, ...(p.extraTargets ?? []), ...(p.allowUndecoded ?? [])];
}

type SpokeDecoded = { functionName: string; args: readonly unknown[] };

function decodeSpoke(data: Hex): SpokeDecoded | string {
  try {
    const d = decodeFunctionData({ abi: SPOKE_ABI, data }) as unknown as SpokeDecoded;
    const re = encodeFunctionData({ abi: SPOKE_ABI, functionName: d.functionName, args: d.args } as Parameters<typeof encodeFunctionData>[0]);
    if (lc(re) !== lc(data)) return "non-canonical spoke calldata (trailing or malformed bytes)";
    return d;
  } catch (e) {
    return `undecodable spoke calldata (${(e as Error).message.split("\n")[0]})`;
  }
}

function checkSpokeCall(d: SpokeDecoded, want: SpokeCallSpec, account: Address, where: string): string[] {
  const out: string[] = [];
  if (d.functionName !== want.fn) return [`${where}: function ${d.functionName} != expected ${want.fn}`];
  const a = d.args;
  if (a[0] !== want.reserveId) out.push(`${where}: reserveId ${String(a[0])} != expected ${want.reserveId}`);
  if (want.fn === "setUsingAsCollateral") {
    if (a[1] !== want.enabled) out.push(`${where}: usingAsCollateral ${String(a[1])} != expected ${want.enabled}`);
  } else if (a[1] !== want.amount) out.push(`${where}: amount ${String(a[1])} != expected ${want.amount}`);
  const onBehalfOf = String(a[2]);
  if (lc(onBehalfOf) !== lc(account)) out.push(`${where}: onBehalfOf ${onBehalfOf} is not our account ${account}`);
  return out;
}

/** Returns the list of problems (empty = the transaction is exactly what we asked for). */
export function checkTx(tx: TxLike, expected: ExpectedCall, policy: TxGuardPolicy): string[] {
  const problems: string[] = [];
  if (!isAddress(tx.to)) return [`invalid target ${tx.to}`];
  if (typeof tx.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(tx.data)) return ["invalid calldata"];
  const data = tx.data as Hex;
  if (tx.value !== undefined && tx.value !== 0n) problems.push(`native value ${tx.value} not allowed`);
  if (tx.from !== undefined && lc(tx.from) !== lc(policy.account)) problems.push(`from ${tx.from} is not our account ${policy.account}`);
  if (tx.chainId !== undefined && tx.chainId !== policy.chainId) problems.push(`chainId ${tx.chainId} != ${policy.chainId}`);
  if (!inSet(tx.to, allowlist(policy))) problems.push(`target ${tx.to} is not allowlisted`);

  switch (expected.kind) {
    case "approve": {
      if (lc(tx.to) !== lc(expected.token)) problems.push(`approve sent to ${tx.to}, expected token ${expected.token}`);
      if (!inSet(tx.to, policy.tokens)) problems.push(`token ${tx.to} is not a configured pair asset`);
      let d: { functionName: string; args: readonly unknown[] };
      try {
        d = decodeFunctionData({ abi: erc20Abi, data }) as unknown as typeof d;
      } catch {
        problems.push("calldata is not an ERC20 call");
        break;
      }
      if (d.functionName !== "approve") {
        problems.push(`ERC20 ${d.functionName} not allowed (only approve)`);
        break;
      }
      const re = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: d.args as [Address, bigint] });
      if (lc(re) !== lc(data)) problems.push("non-canonical approve calldata");
      const [spender, amount] = d.args as [string, bigint];
      if (!inSet(spender, [...policy.spokes, ...(policy.positionManagers ?? [])])) problems.push(`approve spender ${spender} is not an allowlisted spoke/position manager`);
      if (lc(spender) !== lc(expected.spender)) problems.push(`approve spender ${spender} != expected ${expected.spender}`);
      if (amount >= UNLIMITED) problems.push(`unlimited approval (${amount}) refused`);
      if (amount !== expected.amount) problems.push(`approve amount ${amount} != requested ${expected.amount}`);
      break;
    }
    case "spoke": {
      if (lc(tx.to) !== lc(expected.spoke)) problems.push(`spoke call sent to ${tx.to}, expected ${expected.spoke}`);
      if (!inSet(tx.to, policy.spokes)) problems.push(`${tx.to} is not a configured spoke`);
      const d = decodeSpoke(data);
      if (typeof d === "string") {
        problems.push(d);
        break;
      }
      if (d.functionName === "multicall") {
        const inner = d.args[0] as readonly Hex[];
        if (inner.length !== expected.calls.length) {
          problems.push(`multicall has ${inner.length} calls, expected ${expected.calls.length}`);
          break;
        }
        inner.forEach((cd, i) => {
          const di = decodeSpoke(cd);
          if (typeof di === "string") problems.push(`multicall[${i}]: ${di}`);
          else if (di.functionName === "multicall") problems.push(`multicall[${i}]: nested multicall refused`);
          else problems.push(...checkSpokeCall(di, expected.calls[i]!, policy.account, `multicall[${i}]`));
        });
      } else {
        if (expected.calls.length !== 1) problems.push(`expected multicall of ${expected.calls.length} calls, got ${d.functionName}`);
        else problems.push(...checkSpokeCall(d, expected.calls[0]!, policy.account, d.functionName));
      }
      break;
    }
    case "opaque": {
      if (lc(tx.to) !== lc(expected.to)) problems.push(`call sent to ${tx.to}, expected ${expected.to}`);
      if (!inSet(tx.to, policy.allowUndecoded)) problems.push(`calldata to ${tx.to} cannot be decoded and the target is not in allowUndecoded`);
      break;
    }
  }
  return problems;
}

export function assertTx(tx: TxLike, expected: ExpectedCall, policy: TxGuardPolicy): void {
  const p = checkTx(tx, expected, policy);
  if (p.length) throw new TxGuardError(p, tx);
}

/**
 * Validate an AaveKit ExecutionPlan (server-built) against what we asked for.
 * `approval` = the exact ERC20 approval we would accept as part of the plan
 * (token, spender = spoke, amount). Returns problems; empty = OK.
 */
export function checkExecutionPlan(
  plan: ExecutionPlan,
  expected: { main: ExpectedCall; approval?: { token: Address; spender: Address; amount: bigint } },
  policy: TxGuardPolicy
): string[] {
  switch (plan.__typename) {
    case "TransactionRequest":
      return checkTx(plan, expected.main, policy).map((p) => `transaction: ${p}`);
    case "Erc20ApprovalRequired": {
      const out: string[] = [];
      if (!expected.approval) out.push("plan requires an ERC20 approval we did not expect");
      else
        plan.approvals.forEach((a, i) => {
          out.push(...checkTx(a.byTransaction, { kind: "approve", ...expected.approval! }, policy).map((p) => `approval[${i}]: ${p}`));
        });
      out.push(...checkTx(plan.originalTransaction, expected.main, policy).map((p) => `originalTransaction: ${p}`));
      return out;
    }
    case "PreContractActionRequired":
      return [`plan requires a pre-contract action we do not support (${plan.reason}) to ${plan.transaction.to}`];
    case "InsufficientBalanceError":
      return [`AaveKit: insufficient balance (required ${plan.required.value.toString()})`];
    default:
      return [`unknown execution plan type ${(plan as { __typename?: string }).__typename}`];
  }
}

export function normalizeAddresses(xs: readonly string[] | undefined): Address[] {
  return (xs ?? []).map((x) => {
    if (!isAddress(x)) throw new Error(`invalid address in config: ${x}`);
    return getAddress(x);
  });
}
