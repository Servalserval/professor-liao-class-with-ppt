/**
 * CCTP V2 constants. Every value has a SOURCE and is re-checked on-chain by
 * verifyCctp() (src/cctp/verify.ts) before live use.
 */
import type { Address } from "viem";

/** Contracts that share one address on every CCTP V2 EVM chain (EDGE excepted). */
export interface CctpEvmContracts {
  tokenMessengerV2: Address;
  messageTransmitterV2: Address;
  tokenMinterV2: Address;
  messageV2: Address;
}

// SOURCE: https://developers.circle.com/cctp/references/contract-addresses (mainnet, "all other mainnet EVM chains")
export const CCTP_V2_EVM_MAINNET: CctpEvmContracts = {
  tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", // SOURCE: same page
  messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", // SOURCE: same page
  tokenMinterV2: "0xfd78EE919681417d192449715b2594ab58f5D002", // SOURCE: same page
  messageV2: "0xec546b6B005471ECf012e5aF77FBeC07e0FD8f78", // SOURCE: same page
};

/**
 * CCTP domain ids, keyed by live-common chain id. Only chains in CHAINS (plus
 * monad for when it is added) are listed.
 * NOT listed on purpose: bsc (domain 17 carries USYC only, not USDC), gnosis and mantle (no CCTP).
 */
// SOURCE: https://developers.circle.com/cctp/concepts/supported-chains-and-domains
export const CCTP_DOMAINS: Readonly<Record<string, number>> = {
  ethereum: 0, // SOURCE: supported-chains-and-domains
  avalanche: 1, // SOURCE: supported-chains-and-domains
  optimism: 2, // SOURCE: supported-chains-and-domains
  arbitrum: 3, // SOURCE: supported-chains-and-domains
  base: 6, // SOURCE: supported-chains-and-domains
  polygon: 7, // SOURCE: supported-chains-and-domains
  sui: 8, // SOURCE: supported-chains-and-domains (V2 on Sui: https://developers.circle.com/cctp/references/sui-packages.md)
  unichain: 10, // SOURCE: supported-chains-and-domains
  linea: 11, // SOURCE: supported-chains-and-domains
  sonic: 13, // SOURCE: supported-chains-and-domains
  monad: 15, // SOURCE: supported-chains-and-domains (not yet in live-common CHAINS)
  hyperevm: 19, // SOURCE: supported-chains-and-domains
  plasma: 33, // SOURCE: supported-chains-and-domains
};

/**
 * Source chains where Fast Transfer exists. Elsewhere ("N/A" in the docs) a
 * standard attestation is already fast, so only cctp_v2_standard is offered.
 */
// SOURCE: https://developers.circle.com/cctp/concepts/supported-chains-and-domains (Fast Transfer column)
export const CCTP_FAST_SOURCES: ReadonlySet<string> = new Set(["ethereum", "optimism", "arbitrum", "base", "unichain", "linea"]);

/**
 * Fast Transfer fee by source chain, bps, as published. PLANNING ONLY: the
 * adapter always quotes the live fee from Iris (/v2/burn/USDC/fees).
 * Standard Transfer fee is 0 bps everywhere (Sei has an on-chain fee switch).
 */
// SOURCE: https://developers.circle.com/cctp/concepts/fees
export const CCTP_FAST_FEE_BPS_DOCS: Readonly<Record<string, number>> = {
  ethereum: 1,
  arbitrum: 1.4,
  base: 1.3,
  optimism: 1.3,
  unichain: 2,
  linea: 13,
};

// SOURCE: https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/FinalityThresholds.sol
export const FINALITY_THRESHOLD_CONFIRMED = 1000; // Fast Transfer
export const FINALITY_THRESHOLD_FINALIZED = 2000; // Standard Transfer

// SOURCE: https://developers.circle.com/api-reference/cctp/all/get-messages-v2 (servers)
export const IRIS_MAINNET = "https://iris-api.circle.com";
export const IRIS_SANDBOX = "https://iris-api-sandbox.circle.com";

/**
 * Default ETA (seconds) source chain -> attestation, plus our own polling and
 * the destination receive. Conservative planning values.
 * SOURCE: orchestrator research summary of
 * https://developers.circle.com/cctp/references/required-block-confirmations
 * (page blocked in this sandbox -> VERIFY_LIVE). polygon / linea are guesses on the slow side.
 */
export const CCTP_ETA_STANDARD_S: Readonly<Record<string, number>> = {
  ethereum: 19 * 60,
  arbitrum: 19 * 60,
  base: 19 * 60,
  optimism: 19 * 60,
  unichain: 19 * 60,
  linea: 12 * 3600, // UNVERIFIED: Linea finality is slow; keep pessimistic until confirmed
  polygon: 120, // UNVERIFIED
  avalanche: 30,
  sonic: 30,
  hyperevm: 30,
  monad: 30,
  plasma: 30,
  sui: 30,
};
export const CCTP_ETA_FAST_S = 60;
