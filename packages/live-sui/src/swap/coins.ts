/**
 * Input-coin selection for standalone swaps: which wallet coins to merge and
 * how much to split. `planInputCoin` is pure; `buildInputCoin` reads the
 * wallet and applies the plan to a Transaction.
 *
 * Sources of funds on Sui 2.x:
 *  - SUI: always split from the gas coin (the gas resolver merges SUI coins
 *    and address balance into it), keeping a reserve for gas.
 *  - other coins: coin objects (largest first, merged, then split). When the
 *    objects alone are not enough but coin + address balance is, fall back to
 *    the SDK's `coinWithBalance` intent, which also draws from the address
 *    balance (FundsWithdrawal) and is resolved at build time.
 */
import { coinWithBalance } from "@mysten/sui/transactions";
import { SUI_TYPE, normalizeStructTag, type SuiEnv, type Transaction, type TransactionObjectArgument } from "../common.js";
import { SwapRejected } from "./math.js";

export interface WalletCoin {
  objectId: string;
  balance: bigint;
}

export type InputCoinPlan =
  | { kind: "gas"; amount: bigint }
  | { kind: "objects"; amount: bigint; primary: string; merge: string[]; split: boolean; selected: bigint }
  | { kind: "intent"; amount: bigint };

export interface PlanInputArgs {
  coinType: string;
  amount: bigint;
  /** Coin objects of coinType owned by the wallet (any order; may be a partial listing). */
  coins: WalletCoin[];
  /** Total balance of coinType = coin objects + address balance. */
  totalBalance: bigint;
  /** SUI kept for gas when coinType is SUI (MIST). */
  suiGasReserve: bigint;
  /** Max coin objects merged into one input. */
  maxCoins: number;
}

export function isSuiType(coinType: string): boolean {
  return normalizeStructTag(coinType) === normalizeStructTag(SUI_TYPE);
}

export function planInputCoin(a: PlanInputArgs): InputCoinPlan {
  if (a.amount <= 0n) throw new SwapRejected(`input coin: amount must be > 0 (got ${a.amount})`);
  if (isSuiType(a.coinType)) {
    const need = a.amount + a.suiGasReserve;
    if (a.totalBalance < need) {
      throw new SwapRejected(`input coin: SUI balance ${a.totalBalance} < amount ${a.amount} + gas reserve ${a.suiGasReserve}`);
    }
    return { kind: "gas", amount: a.amount };
  }
  if (a.totalBalance < a.amount) throw new SwapRejected(`input coin: ${a.coinType} balance ${a.totalBalance} < ${a.amount}`);
  const sorted = [...a.coins]
    .filter((c) => c.balance > 0n)
    .sort((x, y) => (y.balance > x.balance ? 1 : y.balance < x.balance ? -1 : x.objectId < y.objectId ? -1 : 1));
  const picked: WalletCoin[] = [];
  let sum = 0n;
  for (const c of sorted) {
    if (sum >= a.amount || picked.length >= a.maxCoins) break;
    picked.push(c);
    sum += c.balance;
  }
  if (sum >= a.amount && picked.length > 0) {
    return {
      kind: "objects",
      amount: a.amount,
      primary: picked[0]!.objectId,
      merge: picked.slice(1).map((c) => c.objectId),
      split: sum !== a.amount,
      selected: sum,
    };
  }
  // coin objects are not enough within maxCoins: let the SDK intent combine
  // coins + address balance at build time.
  return { kind: "intent", amount: a.amount };
}

/** Max sources per MergeCoins command (protocol max_arguments is 512). */
const MERGE_CHUNK = 500;

export function applyInputCoinPlan(tx: Transaction, coinType: string, plan: InputCoinPlan): TransactionObjectArgument {
  switch (plan.kind) {
    case "gas": {
      const [c] = tx.splitCoins(tx.gas, [plan.amount]);
      return c!;
    }
    case "objects": {
      const primary = tx.object(plan.primary);
      for (let i = 0; i < plan.merge.length; i += MERGE_CHUNK) {
        tx.mergeCoins(primary, plan.merge.slice(i, i + MERGE_CHUNK).map((id) => tx.object(id)));
      }
      if (!plan.split) return primary;
      const [c] = tx.splitCoins(primary, [plan.amount]);
      return c!;
    }
    case "intent":
      return tx.add(coinWithBalance({ type: normalizeStructTag(coinType), balance: plan.amount, useGasCoin: false }));
  }
}

/** List coin objects until their sum covers `amount` (or pages run out). */
export async function listCoinsCovering(
  env: Pick<SuiEnv, "grpc" | "address">,
  coinType: string,
  amount: bigint,
  maxPages = 20
): Promise<WalletCoin[]> {
  const out: WalletCoin[] = [];
  let sum = 0n;
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const r = await env.grpc.core.listCoins({ owner: env.address, coinType: normalizeStructTag(coinType), cursor });
    for (const c of r.objects) {
      const b = BigInt(c.balance);
      out.push({ objectId: c.objectId, balance: b });
      sum += b;
    }
    if (sum >= amount || !r.hasNextPage || !r.cursor) break;
    cursor = r.cursor;
  }
  return out;
}

/** Read the wallet, plan, and append the commands producing a coin of exactly `amount`. */
export async function buildInputCoin(
  env: Pick<SuiEnv, "grpc" | "address">,
  tx: Transaction,
  coinType: string,
  amount: bigint,
  opts: { suiGasReserve: bigint; maxCoins: number }
): Promise<{ coin: TransactionObjectArgument; plan: InputCoinPlan }> {
  const bal = await env.grpc.core.getBalance({ owner: env.address, coinType: normalizeStructTag(coinType) });
  const totalBalance = BigInt(bal.balance.balance);
  const coins = isSuiType(coinType) || totalBalance < amount ? [] : await listCoinsCovering(env, coinType, amount);
  const plan = planInputCoin({ coinType, amount, coins, totalBalance, suiGasReserve: opts.suiGasReserve, maxCoins: opts.maxCoins });
  return { coin: applyInputCoinPlan(tx, coinType, plan), plan };
}
