/**
 * Aave v3 RewardsController claims (native Aave incentives, not Merkl).
 *
 * The controller address comes from the installed address book, e.g.
 *   import { AaveV3Arbitrum } from "@bgd-labs/aave-address-book";
 *   new AaveRewardsClaimer(env, { chain: "arbitrum", rewardsController: AaveV3Arbitrum.DEFAULT_INCENTIVES_CONTROLLER, assets: [aUSDC, variableDebtUSDC] })
 * and verifyConfig() checks on-chain that every configured aToken / debtToken
 * reports that controller via getIncentivesController().
 */
import { encodeFunctionData, getAddress, parseAbi, type Hex } from "viem";
import type { AssetRef, LiveContext, RewardClaimer, TxRecord } from "@incentive-router/live-common";
import { assertChainId, erc20Meta, sendTx, type Address, type EvmEnv } from "@incentive-router/live-evm-base";
import { sameAddr } from "../swap/http.js";
import type { ClaimResult } from "./merklClaimer.js";

/**
 * The address book's IRewardsController_ABI is not re-exported from a public
 * subpath, so the entries we use are restated here.
 * SOURCE: node_modules/@bgd-labs/aave-address-book/dist/abis/IRewardsController.d.ts
 *   (getAllUserRewards, claimAllRewardsToSelf, getRewardsList, getRewardsByAsset)
 * SOURCE: node_modules/@bgd-labs/aave-address-book/dist/abis/IATokenWithDelegation.d.ts (getIncentivesController)
 */
export const AAVE_REWARDS_CONTROLLER_ABI = parseAbi([
  "function getAllUserRewards(address[] assets, address user) view returns (address[], uint256[])",
  "function claimAllRewardsToSelf(address[] assets) returns (address[] rewardsList, uint256[] claimedAmounts)",
  "function getRewardsList() view returns (address[])",
  "function getRewardsByAsset(address asset) view returns (address[])",
]);
export const AAVE_INCENTIVIZED_TOKEN_ABI = parseAbi(["function getIncentivesController() view returns (address)"]);

export interface AaveRewardsClaimerConfig {
  chain: string;
  /** Default `aave-rewards:<chain>`. */
  id?: string;
  /** <Market>.DEFAULT_INCENTIVES_CONTROLLER from @bgd-labs/aave-address-book. */
  rewardsController: Address;
  /** aTokens / variableDebtTokens of the reserves we hold positions in. */
  assets: Address[];
}

export class AaveRewardsClaimer implements RewardClaimer {
  readonly id: string;
  readonly chain: string;
  private readonly controller: Address;
  private readonly assets: Address[];
  private readonly meta = new Map<string, { symbol: string; decimals: number }>();

  constructor(
    private readonly env: EvmEnv,
    cfg: AaveRewardsClaimerConfig
  ) {
    if (env.chain !== cfg.chain) throw new Error(`AaveRewardsClaimer: env chain ${env.chain} != config chain ${cfg.chain}`);
    if (!cfg.assets.length) throw new Error("AaveRewardsClaimer: assets (aTokens / debt tokens) required");
    this.chain = cfg.chain;
    this.id = cfg.id ?? `aave-rewards:${cfg.chain}`;
    this.controller = getAddress(cfg.rewardsController);
    this.assets = cfg.assets.map((a) => getAddress(a));
  }

  private async tokenRef(token: Address): Promise<AssetRef> {
    const k = token.toLowerCase();
    let m = this.meta.get(k);
    if (!m) {
      m = await erc20Meta(this.env, token);
      this.meta.set(k, m);
    }
    return { chain: this.chain, symbol: m.symbol, address: getAddress(token), decimals: m.decimals };
  }

  async claimable(owner: string): Promise<{ token: AssetRef; amount: bigint }[]> {
    const [tokens, amounts] = await this.env.publicClient.readContract({
      address: this.controller,
      abi: AAVE_REWARDS_CONTROLLER_ABI,
      functionName: "getAllUserRewards",
      args: [this.assets, getAddress(owner)],
    });
    const out: { token: AssetRef; amount: bigint }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const amount = amounts[i] ?? 0n;
      if (amount > 0n) out.push({ token: await this.tokenRef(tokens[i]!), amount });
    }
    return out;
  }

  async claim(owner: string, ctx: LiveContext): Promise<ClaimResult> {
    const txs: TxRecord[] = [];
    if (!sameAddr(owner, this.env.account))
      return { ok: false, txs, claimed: [], detail: `${this.id}: owner ${owner} is not the signer ${this.env.account} (claimAllRewardsToSelf)` };
    try {
      const pending = await this.claimable(owner);
      if (!pending.length) return { ok: true, txs, claimed: [], detail: "nothing claimable" };
      const data = this.claimCalldata();
      txs.push(await sendTx(this.env, ctx, { to: this.controller, data, description: `aave claimAllRewardsToSelf (${pending.map((p) => `${p.amount} ${p.token.symbol}`).join(", ")})` }));
      return { ok: true, txs, claimed: pending.map((p) => ({ token: p.token.address, amount: p.amount, decimals: p.token.decimals })), detail: ctx.dryRun ? "dry-run" : undefined };
    } catch (e) {
      const msg = `${this.id}: claim failed: ${(e as Error).message}`;
      ctx.log("error", msg);
      return { ok: false, txs, claimed: [], detail: msg };
    }
  }

  claimCalldata(): Hex {
    return encodeAaveClaimAll(this.assets);
  }

  /** Controller has code + answers getRewardsList(); each asset points at this controller. */
  async verifyConfig(): Promise<string[]> {
    const issues: string[] = [];
    try {
      await assertChainId(this.env);
    } catch (e) {
      issues.push((e as Error).message);
    }
    const pc = this.env.publicClient;
    const code = await pc.getCode({ address: this.controller });
    if (!code || code === "0x") return [...issues, `${this.id}: rewards controller ${this.controller} has no code`];
    try {
      await pc.readContract({ address: this.controller, abi: AAVE_REWARDS_CONTROLLER_ABI, functionName: "getRewardsList" });
    } catch (e) {
      issues.push(`${this.id}: getRewardsList() failed on ${this.controller}: ${(e as Error).message.split("\n")[0]}`);
    }
    for (const a of this.assets) {
      try {
        const c = await pc.readContract({ address: a, abi: AAVE_INCENTIVIZED_TOKEN_ABI, functionName: "getIncentivesController" });
        if (!sameAddr(c, this.controller)) issues.push(`${this.id}: ${a}.getIncentivesController() = ${c}, config says ${this.controller}`);
      } catch (e) {
        issues.push(`${this.id}: ${a} getIncentivesController() failed (not an aToken/debtToken?): ${(e as Error).message.split("\n")[0]}`);
      }
    }
    return issues;
  }
}

export function encodeAaveClaimAll(assets: Address[]): Hex {
  return encodeFunctionData({ abi: AAVE_REWARDS_CONTROLLER_ABI, functionName: "claimAllRewardsToSelf", args: [assets] });
}
