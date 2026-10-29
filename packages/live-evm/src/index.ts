// Swaps + rewards are flat; lending protocol modules are namespaced
// (their pure helpers share names like planLoopSteps).
export * from "./swap/index.js";
export * from "./rewards/index.js";
export * as morpho from "./morpho/index.js";
export { MorphoBlueAdapter, type MorphoBlueAdapterOptions, type MorphoPairConfig } from "./morpho/index.js";
