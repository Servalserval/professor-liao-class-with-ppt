/**
 * verifyBridges: run every on-chain config check for the configured bridges
 * (contract code, domain / eid sanity, token address match per chain) plus
 * static checks on the constant tables. Run before enabling live mode.
 */
import { CHAINS } from "@incentive-router/live-common";
import { isAddress } from "viem";
import { CCTP_DOMAINS, CCTP_V2_EVM_MAINNET } from "../cctp/constants.js";
import { verifyCctp, type VerifyCctpArgs } from "../cctp/verify.js";
import { USDT0_DEPLOYMENTS } from "../usdt0/constants.js";
import { verifyUsdt0, type VerifyUsdt0Args } from "../usdt0/verify.js";

export interface VerifyBridgesArgs {
  cctp?: VerifyCctpArgs;
  usdt0?: VerifyUsdt0Args;
}

/** Offline checks of the constant tables (checksums, unique ids, chains known). */
export function staticBridgeChecks(): string[] {
  const issues: string[] = [];
  for (const [k, a] of Object.entries(CCTP_V2_EVM_MAINNET)) if (!isAddress(a, { strict: true })) issues.push(`cctp: ${k} ${a} bad checksum`);
  const seenDomains = new Map<number, string>();
  for (const [c, d] of Object.entries(CCTP_DOMAINS)) {
    if (seenDomains.has(d)) issues.push(`cctp: domain ${d} used by ${seenDomains.get(d)} and ${c}`);
    seenDomains.set(d, c);
    if (!CHAINS[c]) issues.push(`cctp: chain ${c} not in live-common CHAINS`);
  }
  const seenEids = new Map<number, string>();
  for (const [c, d] of Object.entries(USDT0_DEPLOYMENTS)) {
    if (!isAddress(d.oft, { strict: true })) issues.push(`usdt0: ${c} oft ${d.oft} bad checksum`);
    if (d.token && !isAddress(d.token, { strict: true })) issues.push(`usdt0: ${c} token ${d.token} bad checksum`);
    if (!CHAINS[c]) issues.push(`usdt0: chain ${c} not in live-common CHAINS`);
    if (seenEids.has(d.eid)) issues.push(`usdt0: eid ${d.eid} used by ${seenEids.get(d.eid)} and ${c}`);
    seenEids.set(d.eid, c);
    if (d.eid < 30000 || d.eid >= 40000) issues.push(`usdt0: ${c} eid ${d.eid} is not a V2 mainnet eid`);
  }
  return issues;
}

export async function verifyBridges(a: VerifyBridgesArgs): Promise<{ ok: boolean; issues: string[] }> {
  const issues = [...staticBridgeChecks()];
  if (a.cctp) issues.push(...(await verifyCctp(a.cctp)));
  if (a.usdt0) issues.push(...(await verifyUsdt0(a.usdt0)));
  return { ok: issues.length === 0, issues };
}
