/**
 * Minimal Aave v3 ABI fragments (only what the adapter calls).
 *
 * SOURCE: aave-dao/aave-v3-origin (tags v3.1.0 .. v3.7.0, main) and
 * aave/aave-v3-periphery (v1.13 .. v2.5) on GitHub:
 *   src/contracts/interfaces/IPool.sol, IPoolAddressesProvider.sol, IAaveOracle.sol,
 *   IPriceOracleGetter.sol, rewards/interfaces/IRewardsController.sol,
 *   IRewardsDistributor.sol, protocol/tokenization/base/IncentivizedERC20.sol.
 * Every selector used here is cross-checked in test/aave.test.ts against the
 * ABIs shipped in node_modules/@bgd-labs/aave-address-book/dist/abis.
 *
 * Version notes
 *  - Functions present in every v3 release: supply, borrow, repay,
 *    repayWithATokens, withdraw, setUserEMode, getUserEMode,
 *    setUserUseReserveAsCollateral, getUserAccountData, getUserConfiguration,
 *    getReserveData (ReserveDataLegacy: identical static layout since 3.0),
 *    getReservesList, getEModeCategoryData (legacy struct, deprecated >= 3.2).
 *  - v3.2+: e-mode bitmaps (getEModeCategoryCollateralConfig / ...Bitmap / Label).
 *    `interestRateMode` of borrow/repay is ignored (stable rate removed) but
 *    still part of the signature: always pass 2 (variable).
 *  - v3.6+: getEModeCategoryLtvzeroBitmap. v3.7+: getIsEModeCategoryIsolated.
 *    Both are read with allowFailure and treated as 0/false when absent.
 */

export const POOL_ABI = [
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
      { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "borrow",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "referralCode", type: "uint16" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "repay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
      { name: "onBehalfOf", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "repayWithATokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "interestRateMode", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setUserEMode",
    stateMutability: "nonpayable",
    inputs: [{ name: "categoryId", type: "uint8" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setUserUseReserveAsCollateral",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "useAsCollateral", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getUserEMode",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getUserConfiguration",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: [{ name: "data", type: "uint256" }] }],
  },
  {
    type: "function",
    name: "getReservesList",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    type: "function",
    name: "ADDRESSES_PROVIDER",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    // DataTypes.ReserveDataLegacy — same 15 static fields in 3.0 .. 3.7.
    type: "function",
    name: "getReserveData",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "configuration", type: "tuple", components: [{ name: "data", type: "uint256" }] },
          { name: "liquidityIndex", type: "uint128" },
          { name: "currentLiquidityRate", type: "uint128" },
          { name: "variableBorrowIndex", type: "uint128" },
          { name: "currentVariableBorrowRate", type: "uint128" },
          { name: "currentStableBorrowRate", type: "uint128" },
          { name: "lastUpdateTimestamp", type: "uint40" },
          { name: "id", type: "uint16" },
          { name: "aTokenAddress", type: "address" },
          { name: "stableDebtTokenAddress", type: "address" },
          { name: "variableDebtTokenAddress", type: "address" },
          { name: "interestRateStrategyAddress", type: "address" },
          { name: "accruedToTreasury", type: "uint128" },
          { name: "unbacked", type: "uint128" },
          { name: "isolationModeTotalDebt", type: "uint128" },
        ],
      },
    ],
  },
  {
    // Legacy e-mode getter (3.0/3.1 struct; deprecated but present in 3.2+).
    type: "function",
    name: "getEModeCategoryData",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint8" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "ltv", type: "uint16" },
          { name: "liquidationThreshold", type: "uint16" },
          { name: "liquidationBonus", type: "uint16" },
          { name: "priceSource", type: "address" },
          { name: "label", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getEModeCategoryCollateralConfig",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint8" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "ltv", type: "uint16" },
          { name: "liquidationThreshold", type: "uint16" },
          { name: "liquidationBonus", type: "uint16" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getEModeCategoryCollateralBitmap",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint8" }],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "getEModeCategoryBorrowableBitmap",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint8" }],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "getEModeCategoryLtvzeroBitmap",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint8" }],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "getIsEModeCategoryIsolated",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint8" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getEModeCategoryLabel",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint8" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export const ADDRESSES_PROVIDER_ABI = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getPriceOracle", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getPoolDataProvider", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getMarketId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

export const AAVE_ORACLE_ABI = [
  { type: "function", name: "BASE_CURRENCY", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "BASE_CURRENCY_UNIT", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "getAssetPrice",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getAssetsPrices",
    stateMutability: "view",
    inputs: [{ name: "assets", type: "address[]" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
] as const;

/** aToken / variableDebtToken (IncentivizedERC20 + scaled balance). */
export const AAVE_TOKEN_ABI = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "UNDERLYING_ASSET_ADDRESS", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getIncentivesController", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

export const REWARDS_CONTROLLER_ABI = [
  {
    type: "function",
    name: "getRewardsByAsset",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "address[]" }],
  },
  {
    // (index, emissionPerSecond, lastUpdateTimestamp, distributionEnd)
    type: "function",
    name: "getRewardsData",
    stateMutability: "view",
    inputs: [
      { name: "asset", type: "address" },
      { name: "reward", type: "address" },
    ],
    outputs: [
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
      { name: "", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getRewardOracle",
    stateMutability: "view",
    inputs: [{ name: "reward", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getUserRewards",
    stateMutability: "view",
    inputs: [
      { name: "assets", type: "address[]" },
      { name: "user", type: "address" },
      { name: "reward", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getAllUserRewards",
    stateMutability: "view",
    inputs: [
      { name: "assets", type: "address[]" },
      { name: "user", type: "address" },
    ],
    outputs: [
      { name: "", type: "address[]" },
      { name: "", type: "uint256[]" },
    ],
  },
  {
    type: "function",
    name: "claimAllRewardsToSelf",
    stateMutability: "nonpayable",
    inputs: [{ name: "assets", type: "address[]" }],
    outputs: [
      { name: "rewardsList", type: "address[]" },
      { name: "claimedAmounts", type: "uint256[]" },
    ],
  },
] as const;

/** Chainlink-style feed used by Aave reward oracles. */
export const AGGREGATOR_ABI = [
  { type: "function", name: "latestAnswer", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "int256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const;

/** getReservesData(provider) input is identical in every UiPoolDataProvider version; only the output layout differs (see layouts.ts). */
export const UI_POOL_GET_RESERVES_DATA_INPUT_ABI = [
  {
    type: "function",
    name: "getReservesData",
    stateMutability: "view",
    inputs: [{ name: "provider", type: "address" }],
    outputs: [],
  },
] as const;

export const UINT256_MAX = (1n << 256n) - 1n;
/** Aave interestRateMode: 2 = variable (stable was removed in 3.2; the arg is ignored there). */
export const VARIABLE_RATE_MODE = 2n;
export const REFERRAL_CODE = 0;
