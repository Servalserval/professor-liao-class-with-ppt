import type { Address } from "@incentive-router/live-evm-base";

/**
 * Merkl Distributor. "On the vast majority of EVM chains, the Distributor is
 * deployed at 0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae".
 * SOURCE: https://developers.merkl.xyz/resources/chains-and-contracts
 * SOURCE: https://docs.morpho.org/developers/rewards/tutorials/claim-rewards/ (same address, "same across all supported chains")
 * Checked on-chain by MerklClaimer.verifyConfig() (code + getMerkleRoot() != 0).
 * Chains where it differs must be overridden via MerklClaimerConfig.distributor.
 */
export const MERKL_DISTRIBUTOR_DEFAULT: Address = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae";

/** Per-chain overrides of the default (none known as of 2026-10-29). */
export const MERKL_DISTRIBUTOR_BY_CHAIN: Record<string, Address> = {};

export function merklDistributor(chain: string): Address {
  return MERKL_DISTRIBUTOR_BY_CHAIN[chain] ?? MERKL_DISTRIBUTOR_DEFAULT;
}
