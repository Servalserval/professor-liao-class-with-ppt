// Swaps + rewards are flat; lending protocol modules are namespaced
// (their pure helpers share names like planLoopSteps).
export * from "./swap/index.js";
export * from "./rewards/index.js";
export * as morpho from "./morpho/index.js";
export { MorphoBlueAdapter, type MorphoBlueAdapterOptions, type MorphoPairConfig } from "./morpho/index.js";
export * as aave from "./aave/index.js";
export {
  AaveV3Adapter,
  aaveMarketFromAddressBook,
  aaveAssetFromAddressBook,
  listAaveAddressBookMarkets,
  type AaveV3AdapterOptions,
  type AaveMarketConfig,
  type AavePairConfig,
} from "./aave/index.js";
export * as vault from "./vault/index.js";
export { ERC4626VaultAdapter, type ERC4626VaultAdapterOptions, type VaultConfig, type VaultFlavor } from "./vault/index.js";
