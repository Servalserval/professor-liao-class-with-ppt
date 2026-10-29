/**
 * On-chain checks for the CCTP V2 config. Run before any live use:
 *  - code exists at TokenMessengerV2 / MessageTransmitterV2 / TokenMinterV2 on every configured EVM chain
 *  - MessageTransmitterV2.localDomain() == our domain table
 *  - TokenMessengerV2.localMessageTransmitter() / localMinter() point at the configured contracts
 *  - USDC AssetRef matches the chain (symbol/decimals), and TokenMinter has a burn limit for it
 *  - every other configured chain is a registered remote (remoteTokenMessengers != 0, == TokenMessengerV2 on EVM)
 *  - TokenMinterV2.getLocalToken(remoteDomain, remoteUsdc) == local USDC (token address match per chain pair)
 *  - Sui: package / state / treasury objects exist with the expected types (treasury type pins the USDC coin type)
 */
import type { AssetRef } from "@incentive-router/live-common";
import { assertChainId, verifyAsset, type EvmEnv } from "@incentive-router/live-evm-base";
import type { SuiEnv } from "@incentive-router/live-sui";
import type { Address } from "viem";
import { errMsg, evmAddressToBytes32, sameEvmAddress } from "../common.js";
import { messageTransmitterV2Abi, tokenMessengerV2Abi, tokenMinterV2Abi } from "./abi.js";
import { CCTP_DOMAINS, CCTP_V2_EVM_MAINNET, type CctpEvmContracts } from "./constants.js";
import { SUI_CCTP_V2_MAINNET, verifySuiCctp, type SuiCctpConfig } from "./sui.js";

export interface VerifyCctpArgs {
  envs: Record<string, EvmEnv>;
  usdc: Record<string, AssetRef>;
  sui?: { env: SuiEnv; config?: SuiCctpConfig };
  domains?: Record<string, number>;
  contracts?: CctpEvmContracts;
}

export async function verifyCctp(a: VerifyCctpArgs): Promise<string[]> {
  const domains = a.domains ?? CCTP_DOMAINS;
  const c = a.contracts ?? CCTP_V2_EVM_MAINNET;
  const issues: string[] = [];
  const chains = Object.keys(a.usdc).filter((ch) => domains[ch] !== undefined && (ch === "sui" ? !!a.sui : !!a.envs[ch]));
  for (const ch of Object.keys(a.usdc)) {
    if (domains[ch] === undefined) issues.push(`cctp: ${ch} has no CCTP domain (USDC not supported there${ch === "bsc" ? "; bsc domain 17 is USYC-only" : ""})`);
  }

  for (const ch of chains) {
    if (ch === "sui") continue;
    const env = a.envs[ch]!;
    const p = env.publicClient;
    const tag = `cctp ${ch}`;
    try {
      await assertChainId(env);
      for (const [name, addr] of Object.entries(c) as [string, Address][]) {
        const code = await p.getCode({ address: addr });
        if (!code || code === "0x") issues.push(`${tag}: ${name} ${addr} has no code`);
      }
      const localDomain = await p.readContract({ address: c.messageTransmitterV2, abi: messageTransmitterV2Abi, functionName: "localDomain" });
      if (localDomain !== domains[ch]) issues.push(`${tag}: MessageTransmitterV2.localDomain() = ${localDomain}, table says ${domains[ch]}`);
      const mt = await p.readContract({ address: c.tokenMessengerV2, abi: tokenMessengerV2Abi, functionName: "localMessageTransmitter" });
      if (!sameEvmAddress(mt, c.messageTransmitterV2)) issues.push(`${tag}: TokenMessengerV2.localMessageTransmitter() = ${mt}`);
      const minter = await p.readContract({ address: c.tokenMessengerV2, abi: tokenMessengerV2Abi, functionName: "localMinter" });
      if (!sameEvmAddress(minter, c.tokenMinterV2)) issues.push(`${tag}: TokenMessengerV2.localMinter() = ${minter}`);

      const usdc = a.usdc[ch]!;
      issues.push(...(await verifyAsset(env, usdc)));
      const limit = await p.readContract({ address: c.tokenMinterV2, abi: tokenMinterV2Abi, functionName: "burnLimitsPerMessage", args: [usdc.address as Address] });
      if (limit === 0n) issues.push(`${tag}: TokenMinterV2.burnLimitsPerMessage(${usdc.address}) = 0 (USDC not burnable here)`);

      for (const other of chains) {
        if (other === ch) continue;
        const rd = domains[other]!;
        const remote = await p.readContract({ address: c.tokenMessengerV2, abi: tokenMessengerV2Abi, functionName: "remoteTokenMessengers", args: [rd] });
        if (/^0x0*$/.test(remote)) {
          issues.push(`${tag}: no remote TokenMessenger for ${other} (domain ${rd})`);
          continue;
        }
        if (other !== "sui") {
          if (remote.toLowerCase() !== evmAddressToBytes32(c.tokenMessengerV2)) issues.push(`${tag}: remote TokenMessenger for ${other} is ${remote}, expected ${c.tokenMessengerV2}`);
          const local = await p.readContract({
            address: c.tokenMinterV2,
            abi: tokenMinterV2Abi,
            functionName: "getLocalToken",
            args: [rd, evmAddressToBytes32(a.usdc[other]!.address)],
          });
          if (!sameEvmAddress(local, usdc.address)) issues.push(`${tag}: getLocalToken(${other} USDC ${a.usdc[other]!.address}) = ${local}, expected ${usdc.address}`);
        }
      }
    } catch (e) {
      issues.push(`${tag}: read failed: ${errMsg(e)}`);
    }
  }

  if (a.sui && a.usdc.sui) {
    issues.push(...(await verifySuiCctp(a.sui.env, a.sui.config ?? SUI_CCTP_V2_MAINNET, a.usdc.sui.address)));
    if (a.usdc.sui.decimals !== 6) issues.push(`cctp sui: USDC decimals ${a.usdc.sui.decimals} != 6`);
  }
  return issues;
}
