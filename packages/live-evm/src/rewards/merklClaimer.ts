/**
 * Merkl reward claims through the Merkl Distributor.
 *
 * API (read 2026-10-29):
 *   GET https://api.merkl.xyz/v4/users/{address}/rewards/summary?chainId={id}   (default; Merkl's own integration guide)
 *   GET https://api.merkl.xyz/v4/users/{address}/rewards?chainId={id}           (legacy; used by the Morpho tutorial)
 *   SOURCE: https://developers.merkl.xyz/integrate-merkl/user-rewards
 *           https://developers.merkl.xyz/api-reference/get/v4/users/%7Baddress%7D/rewards/summary
 *           https://docs.morpho.org/developers/rewards/tutorials/claim-rewards/
 *   Response: [{ chain: { id }, rewards: [{ token: { address, chainId, symbol, decimals },
 *               amount (cumulative, wei string), claimed (cumulative, wei string),
 *               pending (not yet in a root), proofs: bytes32[] }] }]
 *   claimable = amount - claimed; NEVER add pending. `claimed` may lag ~5 min after a claim.
 *
 * Contract: Distributor.claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)
 *   amounts are CUMULATIVE (pass the API `amount` as-is; the contract sends amount - claimed).
 *   leaf = keccak256(abi.encode(user, token, amount)); sorted-pair keccak256(abi.encode(a, b)) up to getMerkleRoot().
 *   SOURCE: https://github.com/AngleProtocol/merkl-contracts/blob/main/contracts/Distributor.sol
 *
 * Before sending we (1) re-verify every proof locally against the on-chain
 * active root (drops entries whose proof belongs to a root still in its dispute
 * period), (2) read the on-chain `claimed` to get the exact amount that moves,
 * and (3) refuse tokens whose claim recipient was redirected away from us.
 */
import { concat, encodeAbiParameters, encodeFunctionData, getAddress, isAddress, keccak256, parseAbi, zeroAddress, type Hex } from "viem";
import { BroadcastUnconfirmedError, chainInfo, fromUnits, type AssetRef, type LiveContext, type LiveResult, type RewardClaimer, type TxRecord } from "@incentive-router/live-common";
import { assertChainId, sendTx, type Address, type EvmEnv } from "@incentive-router/live-evm-base";
import { arr, big, defaultFetch, httpJson, lc, num, obj, sameAddr, str, type HttpFetch } from "../swap/http.js";
import { merklDistributor } from "./addresses.js";

/** SOURCE: https://github.com/AngleProtocol/merkl-contracts/blob/main/contracts/Distributor.sol (claim, getMerkleRoot, claimed, claimRecipient) */
export const MERKL_DISTRIBUTOR_ABI = parseAbi([
  "function claim(address[] users, address[] tokens, uint256[] amounts, bytes32[][] proofs)",
  "function getMerkleRoot() view returns (bytes32)",
  "function claimed(address user, address token) view returns (uint208 amount, uint48 timestamp, bytes32 merkleRoot)",
  "function claimRecipient(address user, address token) view returns (address)",
]);

export interface MerklRewardEntry {
  token: AssetRef;
  /** Cumulative amount in the current tree (what goes into claim()). */
  amount: bigint;
  /** Cumulative amount already claimed (API view; may lag). */
  claimed: bigint;
  /** Earned but not yet in a merkle root (NOT claimable). */
  pending: bigint;
  proofs: Hex[];
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** Parse a /v4/users/{addr}/rewards[/summary] response for one chain. Malformed entries are dropped. */
export function parseMerklUserRewards(json: unknown, evmChainId: number, chain: string): MerklRewardEntry[] {
  const groups = Array.isArray(json) ? json : obj(json)?.rewards ? [json] : [];
  const out: MerklRewardEntry[] = [];
  for (const g of groups) {
    const go = obj(g);
    const gid = num(obj(go?.chain)?.id);
    if (gid !== undefined && gid !== evmChainId) continue;
    for (const r of arr(go?.rewards)) {
      const ro = obj(r);
      const t = obj(ro?.token);
      const address = str(t?.address);
      const decimals = num(t?.decimals);
      const tChain = num(t?.chainId);
      if (!ro || !address || !isAddress(address) || decimals === undefined) continue;
      if (tChain !== undefined && tChain !== evmChainId) continue;
      if (gid === undefined && tChain === undefined) continue; // cannot tell which chain it is on
      const amount = big(ro.amount);
      const claimed = big(ro.claimed ?? "0");
      const pending = big(ro.pending ?? "0") ?? 0n;
      if (amount === undefined || claimed === undefined) continue;
      const proofs = arr(ro.proofs).map((p) => str(p));
      if (!proofs.every((p): p is string => !!p && BYTES32.test(p))) continue;
      out.push({
        token: { chain, symbol: str(t?.symbol) ?? "?", address: getAddress(address), decimals },
        amount,
        claimed,
        pending,
        proofs: proofs as Hex[],
      });
    }
  }
  return out;
}

export function merklLeaf(user: Address, token: Address, amount: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [user, token, amount]));
}

/** Root implied by a proof, exactly as Distributor._verifyProof walks it (sorted pairs). */
export function merklRootFromProof(leaf: Hex, proof: readonly Hex[]): Hex {
  let h = leaf;
  for (const p of proof) h = BigInt(h) < BigInt(p) ? keccak256(concat([h, p])) : keccak256(concat([p, h]));
  return h;
}

/** Distributor.claim calldata. `amounts` MUST be cumulative tree amounts. */
export function encodeMerklClaim(users: Address[], tokens: Address[], amounts: bigint[], proofs: Hex[][]): Hex {
  if (!(users.length && users.length === tokens.length && tokens.length === amounts.length && amounts.length === proofs.length))
    throw new Error("encodeMerklClaim: array lengths differ or empty");
  return encodeFunctionData({ abi: MERKL_DISTRIBUTOR_ABI, functionName: "claim", args: [users, tokens, amounts, proofs] });
}

export interface MerklClaimerConfig {
  chain: string;
  /** Default `merkl:<chain>`. */
  id?: string;
  /** Default merklDistributor(chain) (SOURCE in ./addresses.ts); verified on-chain by verifyConfig(). */
  distributor?: Address;
  /** Default https://api.merkl.xyz/v4 */
  baseUrl?: string;
  apiKey?: string;
  /** Default "rewards/summary". */
  endpoint?: "rewards/summary" | "rewards";
  /** Only claim these token addresses (default: every token with something claimable). */
  tokens?: string[];
  /** Skip tokens whose claimable value is below this (USD, via ctx.priceUsd). Default 0. */
  minClaimUsd?: number;
  /** Merkl roots update every few hours; do not claim more often than this. Default 2 h. */
  minClaimIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export type ClaimResult = LiveResult & { claimed: { token: string; amount: bigint; decimals: number }[] };

export class MerklClaimer implements RewardClaimer {
  readonly id: string;
  readonly chain: string;
  readonly distributor: Address;
  private readonly evmChainId: number;
  private readonly now: () => number;
  private lastClaimAtMs = 0;

  constructor(
    private readonly env: EvmEnv,
    private readonly cfg: MerklClaimerConfig,
    private readonly fetchImpl: HttpFetch = defaultFetch
  ) {
    if (env.chain !== cfg.chain) throw new Error(`MerklClaimer: env chain ${env.chain} != config chain ${cfg.chain}`);
    const id = chainInfo(cfg.chain).evmChainId;
    if (id === undefined) throw new Error(`MerklClaimer: ${cfg.chain} is not EVM`);
    this.evmChainId = id;
    this.chain = cfg.chain;
    this.id = cfg.id ?? `merkl:${cfg.chain}`;
    this.distributor = getAddress(cfg.distributor ?? merklDistributor(cfg.chain));
    this.now = cfg.now ?? Date.now;
  }

  async fetchRewards(owner: string): Promise<MerklRewardEntry[]> {
    if (!isAddress(owner)) throw new Error(`${this.id}: bad owner ${owner}`);
    const base = (this.cfg.baseUrl ?? "https://api.merkl.xyz/v4").replace(/\/+$/, "");
    const url = `${base}/users/${lc(owner)}/${this.cfg.endpoint ?? "rewards/summary"}?chainId=${this.evmChainId}`;
    const headers = this.cfg.apiKey ? { "X-API-Key": this.cfg.apiKey } : undefined;
    const json = await httpJson(this.fetchImpl, url, { headers, timeoutMs: this.cfg.timeoutMs });
    if (!Array.isArray(json) && !obj(json)) throw new Error(`${this.id}: unexpected response shape`);
    const all = parseMerklUserRewards(json, this.evmChainId, this.chain);
    const only = this.cfg.tokens?.map(lc);
    return only ? all.filter((e) => only.includes(lc(e.token.address))) : all;
  }

  /** amount - claimed per token (API view; excludes pending). */
  async claimable(owner: string): Promise<{ token: AssetRef; amount: bigint }[]> {
    return (await this.fetchRewards(owner)).filter((e) => e.amount > e.claimed).map((e) => ({ token: e.token, amount: e.amount - e.claimed }));
  }

  async claim(owner: string, ctx: LiveContext): Promise<ClaimResult> {
    const txs: TxRecord[] = [];
    if (!sameAddr(owner, this.env.account))
      return { ok: false, txs, claimed: [], detail: `${this.id}: owner ${owner} is not the signer ${this.env.account} (Distributor only lets users claim for themselves)` };
    const minInt = this.cfg.minClaimIntervalMs ?? 2 * 3600_000;
    if (this.lastClaimAtMs && this.now() - this.lastClaimAtMs < minInt)
      return { ok: true, txs, claimed: [], detail: `${this.id}: skipped, last claim ${Math.round((this.now() - this.lastClaimAtMs) / 60_000)} min ago` };
    try {
      const user = this.env.account;
      const entries = (await this.fetchRewards(owner)).filter((e) => e.amount > e.claimed && e.proofs.length > 0);
      if (!entries.length) return { ok: true, txs, claimed: [], detail: "nothing claimable" };
      const pc = this.env.publicClient;
      const root = await pc.readContract({ address: this.distributor, abi: MERKL_DISTRIBUTOR_ABI, functionName: "getMerkleRoot" });
      if (BigInt(root) === 0n) throw new Error("distributor root is 0");
      let redirectAll: Address | undefined;
      try {
        redirectAll = await pc.readContract({ address: this.distributor, abi: MERKL_DISTRIBUTOR_ABI, functionName: "claimRecipient", args: [user, zeroAddress] });
      } catch {
        redirectAll = undefined; // older Distributor without recipient redirection
      }
      const pick: { e: MerklRewardEntry; toSend: bigint }[] = [];
      for (const e of entries) {
        const token = e.token.address as Address;
        const leaf = merklLeaf(user, token, e.amount);
        if (lc(merklRootFromProof(leaf, e.proofs)) !== lc(root)) {
          ctx.log("warn", `${this.id}: proof for ${e.token.symbol} does not match the active root (new tree in dispute period?) — skipped`);
          continue;
        }
        let onchainClaimed = e.claimed;
        try {
          const c = await pc.readContract({ address: this.distributor, abi: MERKL_DISTRIBUTOR_ABI, functionName: "claimed", args: [user, token] });
          onchainClaimed = c[0];
        } catch {
          /* fall back to the API view; the simulation is the final check */
        }
        const toSend = e.amount - onchainClaimed;
        if (toSend <= 0n) continue;
        let redirect = redirectAll;
        try {
          const r = await pc.readContract({ address: this.distributor, abi: MERKL_DISTRIBUTOR_ABI, functionName: "claimRecipient", args: [user, token] });
          if (r !== zeroAddress) redirect = r;
        } catch {
          /* see above */
        }
        if (redirect && redirect !== zeroAddress && !sameAddr(redirect, user)) {
          ctx.log("error", `${this.id}: claim recipient for ${e.token.symbol} is redirected to ${redirect} — refusing`);
          continue;
        }
        const minUsd = this.cfg.minClaimUsd ?? 0;
        if (minUsd > 0) {
          let usd: number | undefined;
          try {
            usd = fromUnits(toSend, e.token.decimals) * (await ctx.priceUsd(e.token));
          } catch {
            usd = undefined;
          }
          if (usd === undefined || usd < minUsd) continue;
        }
        pick.push({ e, toSend });
      }
      if (!pick.length) return { ok: true, txs, claimed: [], detail: "nothing claimable after on-chain checks" };
      const data = encodeMerklClaim(
        pick.map(() => user),
        pick.map((p) => p.e.token.address as Address),
        pick.map((p) => p.e.amount),
        pick.map((p) => p.e.proofs)
      );
      const description = `merkl claim ${pick.map((p) => `${p.toSend} ${p.e.token.symbol}`).join(", ")}`;
      try {
        txs.push(await sendTx(this.env, ctx, { to: this.distributor, data, description }));
      } catch (e) {
        if (!(e instanceof BroadcastUnconfirmedError)) throw e;
        // May have landed: start the interval anyway so the same claim is not re-sent immediately.
        this.lastClaimAtMs = this.now();
        txs.push({ chain: this.chain, id: e.id, description, simulated: false, unconfirmed: true, nonce: e.nonce });
        const msg = `${this.id}: claim broadcast unconfirmed (may have landed) hash=${e.id}: ${e.message}`;
        ctx.log("error", msg);
        return { ok: false, txs, claimed: [], detail: msg };
      }
      if (!ctx.dryRun) this.lastClaimAtMs = this.now();
      return {
        ok: true,
        txs,
        claimed: pick.map((p) => ({ token: p.e.token.address, amount: p.toSend, decimals: p.e.token.decimals })),
        detail: ctx.dryRun ? "dry-run" : undefined,
      };
    } catch (e) {
      const msg = `${this.id}: claim failed: ${(e as Error).message}`;
      ctx.log("error", msg);
      return { ok: false, txs, claimed: [], detail: msg };
    }
  }

  /** Distributor has code and a non-zero active root; RPC serves the right chain. */
  async verifyConfig(): Promise<string[]> {
    const issues: string[] = [];
    try {
      await assertChainId(this.env);
    } catch (e) {
      issues.push((e as Error).message);
    }
    const code = await this.env.publicClient.getCode({ address: this.distributor });
    if (!code || code === "0x") return [...issues, `${this.id}: distributor ${this.distributor} has no code`];
    try {
      const root = await this.env.publicClient.readContract({ address: this.distributor, abi: MERKL_DISTRIBUTOR_ABI, functionName: "getMerkleRoot" });
      if (BigInt(root) === 0n) issues.push(`${this.id}: distributor ${this.distributor} getMerkleRoot() is 0`);
    } catch (e) {
      issues.push(`${this.id}: distributor ${this.distributor} getMerkleRoot() failed: ${(e as Error).message.split("\n")[0]}`);
    }
    return issues;
  }
}
