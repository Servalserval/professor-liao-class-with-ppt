/**
 * Aave V4 contract ABIs (subset) — hand-transcribed from the verified source.
 *
 * SOURCE: https://github.com/aave/aave-v4 @ a3ef63ea6415d25237a9775bf66e76e9993561c2 (2026-10-27, package.json 0.5.11)
 *   src/spoke/interfaces/ISpoke.sol          (structs, write + view functions)
 *   src/interfaces/IMulticall.sol            (Spoke.multicall: delegatecall to self, msg.sender preserved — src/utils/Multicall.sol)
 *   src/spoke/interfaces/IPriceOracle.sol     (getReservePrice, decimals, spoke)
 *   src/hub/interfaces/IHub.sol / IHubBase.sol
 *   src/hub/interfaces/IAssetInterestRateStrategy.sol
 *
 * The deployed contracts must match this version; verifyConfig() checks that
 * every selector used here is present in the Spoke implementation bytecode
 * (EIP-1967 slot) and that the view calls decode.
 */
import { parseAbi } from "viem";

export const SPOKE_ABI = parseAbi([
  "struct Reserve { address underlying; address hub; uint16 assetId; uint8 decimals; uint24 collateralRisk; uint8 flags; uint32 dynamicConfigKey; }",
  "struct ReserveConfig { uint24 collateralRisk; bool paused; bool frozen; bool borrowable; bool receiveSharesEnabled; }",
  "struct DynamicReserveConfig { uint16 collateralFactor; uint32 maxLiquidationBonus; uint16 liquidationFee; }",
  "struct UserPosition { uint120 drawnShares; uint120 premiumShares; int200 premiumOffsetRay; uint120 suppliedShares; uint32 dynamicConfigKey; }",
  "struct UserAccountData { uint256 riskPremium; uint256 avgCollateralFactor; uint256 healthFactor; uint256 totalCollateralValue; uint256 totalDebtValueRay; uint256 activeCollateralCount; uint256 borrowCount; }",
  "struct LiquidationConfig { uint128 targetHealthFactor; uint64 healthFactorForMaxBonus; uint16 liquidationBonusFactor; }",
  // writes (caller must be onBehalfOf or an approved+active position manager)
  "function supply(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function repay(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)",
  "function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf)",
  "function updateUserRiskPremium(address onBehalfOf)",
  "function multicall(bytes[] data) returns (bytes[])",
  // views
  "function getReserveCount() view returns (uint256)",
  "function getReserveId(address hub, uint256 assetId) view returns (uint256)",
  "function getReserve(uint256 reserveId) view returns (Reserve)",
  "function getReserveConfig(uint256 reserveId) view returns (ReserveConfig)",
  "function getDynamicReserveConfig(uint256 reserveId, uint32 dynamicConfigKey) view returns (DynamicReserveConfig)",
  "function getReserveSuppliedAssets(uint256 reserveId) view returns (uint256)",
  "function getReserveDebt(uint256 reserveId) view returns (uint256, uint256)",
  "function getUserReserveStatus(uint256 reserveId, address user) view returns (bool, bool)",
  "function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)",
  "function getUserTotalDebt(uint256 reserveId, address user) view returns (uint256)",
  "function getUserPosition(uint256 reserveId, address user) view returns (UserPosition)",
  "function getUserAccountData(address user) view returns (UserAccountData)",
  "function getUserLastRiskPremium(address user) view returns (uint256)",
  "function getLiquidationConfig() view returns (LiquidationConfig)",
  "function isPositionManagerActive(address positionManager) view returns (bool)",
  "function isPositionManager(address user, address positionManager) view returns (bool)",
  "function ORACLE() view returns (address)",
]);

/** SOURCE: src/spoke/interfaces/IPriceOracle.sol (AaveOracle implements it; decimals must be 8 = Spoke ORACLE_DECIMALS). */
export const ORACLE_ABI = parseAbi([
  "function getReservePrice(uint256 reserveId) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function spoke() view returns (address)",
]);

/** SOURCE: src/hub/interfaces/IHub.sol + IHubBase.sol */
export const HUB_ABI = parseAbi([
  "struct Asset { uint120 liquidity; uint120 realizedFees; uint8 decimals; uint120 addedShares; uint120 swept; int200 premiumOffsetRay; uint120 drawnShares; uint120 premiumShares; uint16 liquidityFee; uint120 drawnIndex; uint96 drawnRate; uint40 lastUpdateTimestamp; address underlying; address irStrategy; address reinvestmentController; address feeReceiver; uint200 deficitRay; }",
  "struct SpokeData { uint120 drawnShares; uint120 premiumShares; int200 premiumOffsetRay; uint120 addedShares; uint40 addCap; uint40 drawCap; uint24 riskPremiumThreshold; bool active; bool halted; uint200 deficitRay; }",
  "function getAssetId(address underlying) view returns (uint256)",
  "function getAssetUnderlyingAndDecimals(uint256 assetId) view returns (address, uint8)",
  "function getAsset(uint256 assetId) view returns (Asset)",
  "function getAssetDrawnRate(uint256 assetId) view returns (uint256)",
  "function getAssetOwed(uint256 assetId) view returns (uint256, uint256)",
  "function getAddedAssets(uint256 assetId) view returns (uint256)",
  "function getSpoke(uint256 assetId, address spoke) view returns (SpokeData)",
  "function getSpokeAddedAssets(uint256 assetId, address spoke) view returns (uint256)",
  "function getSpokeOwed(uint256 assetId, address spoke) view returns (uint256, uint256)",
]);

/** SOURCE: src/hub/interfaces/IAssetInterestRateStrategy.sol (all fields in BPS). */
export const IRM_ABI = parseAbi([
  "struct InterestRateData { uint16 optimalUsageRatio; uint32 baseDrawnRate; uint32 rateGrowthBeforeOptimal; uint32 rateGrowthAfterOptimal; }",
  "function getInterestRateData(uint256 assetId) view returns (InterestRateData)",
]);

/** EIP-1967 implementation slot (bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)). SOURCE: src/dependencies/openzeppelin/ERC1967Utils.sol */
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/** Spoke write functions this adapter encodes (selectors checked in the implementation bytecode by verifyConfig). */
export const SPOKE_WRITE_FUNCTIONS = ["supply", "withdraw", "borrow", "repay", "setUsingAsCollateral", "multicall"] as const;
