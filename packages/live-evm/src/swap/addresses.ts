import type { Address } from "@incentive-router/live-evm-base";

/**
 * Official aggregator router addresses. These are the ONLY contracts the
 * AggregatorSwapAdapter will approve tokens to or send API-built calldata to.
 * Every address here is checked on-chain by `AggregatorSwapAdapter.verifyConfig()`
 * (code exists + a read-only getter answers) before live use.
 */

/**
 * KyberSwap MetaAggregationRouterV2 — same address on every chain listed.
 * SOURCE: https://docs.kyberswap.com/developer-guide/aggregator-api/contracts
 *   ("MetaAggregationRouterV2 ... 0x6131B5fae19EA4f9D964eAc0408E4408b66337b5", all chains)
 * KSAggregationRouterV3 (0x6868…32d7, ethereum/bsc/base only) is deliberately NOT
 * allowlisted: we do not have its ABI, so its calldata cannot be decoded and the
 * recipient / min-out could not be verified.
 */
export const KYBERSWAP_META_ROUTER_V2: Address = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";

/**
 * Chain path segment of the KyberSwap Aggregator API (`/{chain}/api/v1/...`).
 * SOURCE: https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps ("Chain identifiers")
 * Keys are our chain ids (packages/live-common/src/chains.ts).
 */
export const KYBERSWAP_CHAIN_PATHS: Record<string, string> = {
  ethereum: "ethereum",
  bsc: "bsc",
  arbitrum: "arbitrum",
  polygon: "polygon",
  optimism: "optimism",
  avalanche: "avalanche",
  base: "base",
  linea: "linea",
  mantle: "mantle",
  sonic: "sonic",
  unichain: "unichain",
  hyperevm: "hyperevm",
  plasma: "plasma",
};

/**
 * Our chains on which the contracts page lists MetaAggregationRouterV2 at the address above.
 * SOURCE: https://docs.kyberswap.com/developer-guide/aggregator-api/contracts
 * (mantle is an API chain but is NOT in that router table -> no default router there.)
 */
export const KYBERSWAP_META_ROUTER_V2_CHAINS: readonly string[] = [
  "ethereum", "bsc", "arbitrum", "polygon", "optimism", "avalanche", "base", "linea", "sonic", "unichain", "hyperevm", "plasma",
];

export function kyberswapRouters(chain: string): Address[] {
  return KYBERSWAP_CHAIN_PATHS[chain] && KYBERSWAP_META_ROUTER_V2_CHAINS.includes(chain) ? [KYBERSWAP_META_ROUTER_V2] : [];
}

/**
 * Odos Router V2 per chain.
 * SOURCE: https://github.com/odos-xyz/odos-router-v2/blob/main/README.md ("Chain Deployments / Mainnets")
 */
export const ODOS_ROUTER_V2: Record<string, Address> = {
  ethereum: "0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559",
  optimism: "0xCa423977156BB05b13A2BA3b76Bc5419E2fE9680",
  bsc: "0x89b8AA89FDd0507a99d334CBe3C808fAFC7d850E",
  polygon: "0x4E3288c9ca110bCC82bf38F09A7b425c095d92Bf",
  sonic: "0xaC041Df48dF9791B0654f1Dbbf2CC8450C5f2e9D",
  mantle: "0xD9F4e85489aDCD0bAF0Cd63b4231c6af58c26745",
  base: "0x19cEeAd7105607Cd444F5ad10dd51356436095a1",
  arbitrum: "0xa669e7A0d4b3e4Fa48af2dE86BD4CD7126Be4e13",
  avalanche: "0x88de50B233052e4Fb783d4F6db78Cc34fEa3e9FC",
  linea: "0x2d8879046f1559E53eb052E949e9544bCB72f414",
};

export function odosRouters(chain: string): Address[] {
  const a = ODOS_ROUTER_V2[chain];
  return a ? [a] : [];
}
