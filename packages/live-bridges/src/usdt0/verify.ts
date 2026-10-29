/**
 * On-chain checks for the USDT0 deployment table, per configured chain:
 *  - code at the OFT; oft.token() == table token / AssetRef; token decimals == AssetRef
 *  - approvalRequired() == table `adapter` flag (only Ethereum is a lock/unlock adapter)
 *  - oft.endpoint() has code and endpoint.eid() == table eid
 *  - for every other configured chain: peers(eid) == bytes32(that chain's OFT)
 *  - enforcedOptions(eid, SEND) non-empty (we send extraOptions = 0x)
 */
import type { AssetRef } from "@incentive-router/live-common";
import { assertChainId, erc20Meta, type EvmEnv } from "@incentive-router/live-evm-base";
import type { Address } from "viem";
import { errMsg, evmAddressToBytes32, sameEvmAddress } from "../common.js";
import { lzEndpointAbi, oftAbi } from "./abi.js";
import { OFT_MSG_TYPE_SEND, USDT0_DEPLOYMENTS, type Usdt0Deployment } from "./constants.js";

export interface VerifyUsdt0Args {
  envs: Record<string, EvmEnv>;
  tokens?: Record<string, AssetRef>;
  deployments?: Record<string, Usdt0Deployment>;
}

export async function verifyUsdt0(a: VerifyUsdt0Args): Promise<string[]> {
  const deps = a.deployments ?? USDT0_DEPLOYMENTS;
  const chains = Object.keys(a.envs).filter((c) => deps[c]);
  const issues: string[] = [];
  const eids = new Set<number>();
  for (const c of chains) {
    if (eids.has(deps[c]!.eid)) issues.push(`usdt0: duplicate eid ${deps[c]!.eid} (${c})`);
    eids.add(deps[c]!.eid);
  }
  for (const c of chains) {
    const env = a.envs[c]!;
    const d = deps[c]!;
    const p = env.publicClient;
    const tag = `usdt0 ${c}`;
    try {
      await assertChainId(env);
      const code = await p.getCode({ address: d.oft });
      if (!code || code === "0x") {
        issues.push(`${tag}: OFT ${d.oft} has no code`);
        continue;
      }
      const token = await p.readContract({ address: d.oft, abi: oftAbi, functionName: "token" });
      const want = a.tokens?.[c]?.address ?? d.token;
      if (want && !sameEvmAddress(token, want)) issues.push(`${tag}: oft.token() = ${token}, config says ${want}`);
      if (!want) issues.push(`${tag}: no token configured; on-chain oft.token() = ${token} (add it as the ${d.symbol} AssetRef)`);
      const meta = await erc20Meta(env, token);
      const wantDec = a.tokens?.[c]?.decimals ?? 6;
      if (meta.decimals !== wantDec) issues.push(`${tag}: token decimals ${meta.decimals} != ${wantDec}`);
      const approval = await p.readContract({ address: d.oft, abi: oftAbi, functionName: "approvalRequired" });
      if (approval !== d.adapter) issues.push(`${tag}: approvalRequired() = ${approval}, table adapter = ${d.adapter}`);
      const endpoint = await p.readContract({ address: d.oft, abi: oftAbi, functionName: "endpoint" });
      const epCode = await p.getCode({ address: endpoint as Address });
      if (!epCode || epCode === "0x") issues.push(`${tag}: endpoint ${endpoint} has no code`);
      else {
        const eid = await p.readContract({ address: endpoint, abi: lzEndpointAbi, functionName: "eid" });
        if (eid !== d.eid) issues.push(`${tag}: endpoint.eid() = ${eid}, table says ${d.eid}`);
      }
      for (const o of chains) {
        if (o === c) continue;
        const od = deps[o]!;
        const peer = await p.readContract({ address: d.oft, abi: oftAbi, functionName: "peers", args: [od.eid] });
        if (peer.toLowerCase() !== evmAddressToBytes32(od.oft)) issues.push(`${tag}: peers(${od.eid} ${o}) = ${peer}, expected ${od.oft}`);
        const opts = await p.readContract({ address: d.oft, abi: oftAbi, functionName: "enforcedOptions", args: [od.eid, OFT_MSG_TYPE_SEND] });
        if (opts === "0x" || opts === "0x0003") issues.push(`${tag}: no enforced options to ${o}; sends with extraOptions=0x would fail`);
      }
    } catch (e) {
      issues.push(`${tag}: read failed: ${errMsg(e)}`);
    }
  }
  return issues;
}
