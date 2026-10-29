/**
 * USDT0 (LayerZero V2 OFT) deployments, keyed by live-common chain id.
 * Every entry is re-checked on-chain by verifyUsdt0() (oft.token(), endpoint().eid(),
 * approvalRequired(), peers(eid) for every other chain).
 *
 * SOURCE (addresses, eids): https://docs.usdt0.to/technical-documentation/deployments
 * SOURCE (eids cross-check): npm @layerzerolabs/lz-definitions@3.1.15 EndpointId.<CHAIN>_V2_MAINNET
 *
 * Not deployed per the deployments page: base, sui, sonic, bsc, avalanche, linea, gnosis.
 * Deployed but not in live-common CHAINS yet: ink 30339, sei 30280, monad 30390, berachain, flare, ...
 */
import type { Address } from "viem";

export interface Usdt0Deployment {
  /** LayerZero V2 endpoint id. */
  eid: number;
  /** OFT (or OFT Adapter on Ethereum) contract. */
  oft: Address;
  /**
   * Token the OFT moves. undefined = not listed in the docs (Ethereum USDT):
   * the adapter reads oft.token() on-chain and requires it to equal the AssetRef.
   */
  token?: Address;
  /** true = lock/unlock adapter (needs ERC20 approval of `token` to `oft`). */
  adapter: boolean;
  symbol: "USDT" | "USDT0";
}

export const USDT0_DEPLOYMENTS: Readonly<Record<string, Usdt0Deployment>> = {
  // SOURCE: docs.usdt0.to deployments — Ethereum "OFT Adapter" (the IOTA Lockbox adapter 0xAEf0... is a separate route, not used)
  ethereum: { eid: 30101, oft: "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee", adapter: true, symbol: "USDT" },
  // SOURCE: docs.usdt0.to deployments — Arbitrum One
  arbitrum: { eid: 30110, oft: "0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92", token: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", adapter: false, symbol: "USDT0" },
  // SOURCE: docs.usdt0.to deployments — Optimism
  optimism: { eid: 30111, oft: "0xF03b4d9AC1D5d1E7c4cEf54C2A313b9fe051A0aD", token: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", adapter: false, symbol: "USDT0" },
  // SOURCE: docs.usdt0.to deployments — Polygon PoS
  polygon: { eid: 30109, oft: "0x6BA10300f0DC58B7a1e4c0e41f5daBb7D7829e13", token: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", adapter: false, symbol: "USDT0" },
  // SOURCE: docs.usdt0.to deployments — Unichain
  unichain: { eid: 30320, oft: "0xc07bE8994D035631c36fb4a89C918CeFB2f03EC3", token: "0x9151434b16b9763660705744891fA906F660EcC5", adapter: false, symbol: "USDT0" },
  // SOURCE: docs.usdt0.to deployments — Mantle
  mantle: { eid: 30181, oft: "0xcb768e263FB1C62214E7cab4AA8d036D76dc59CC", token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736", adapter: false, symbol: "USDT0" },
  // SOURCE: docs.usdt0.to deployments — Plasma
  plasma: { eid: 30383, oft: "0x02ca37966753bDdDf11216B73B16C1dE756A7CF9", token: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", adapter: false, symbol: "USDT0" },
  // SOURCE: docs.usdt0.to deployments — HyperEVM (eid 30367 = HYPERLIQUID_V2_MAINNET in lz-definitions)
  hyperevm: { eid: 30367, oft: "0x904861a24F30EC96ea7CFC3bE9EA4B476d237e98", token: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", adapter: false, symbol: "USDT0" },
};

/** OFTCore msg type for a plain send (enforcedOptions key). SOURCE: devtools/packages/oft-evm/contracts/OFTCore.sol `SEND = 1` */
export const OFT_MSG_TYPE_SEND = 1;

/**
 * LayerZero Scan API base. UNVERIFIED: docs.layerzero.network was blocked in
 * this sandbox, so the path `/messages/tx/{txHash}` and the response shape are
 * parsed defensively; completion is decided on-chain (OFTReceived by guid) and
 * Scan is only used to detect failures. -> VERIFY_LIVE
 */
// SOURCE: UNVERIFIED (expected per https://docs.layerzero.network/v2/tools/layerzeroscan/api)
export const LZ_SCAN_MAINNET = "https://scan.layerzero-api.com/v1";

/** Docs: "standard transfers typically complete in 30 seconds to 3 minutes". SOURCE: https://docs.usdt0.to/technical-documentation/developer */
export const USDT0_ETA_S = 180;
