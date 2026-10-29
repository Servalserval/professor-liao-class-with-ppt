/**
 * The subset of @naviprotocol/lending 2.1.0 the adapter uses, behind one
 * object so tests can replace it (no network / RPC offline).
 *
 * All function names / signatures are from
 * node_modules/@naviprotocol/lending/dist/*.d.ts (v2.1.0). Contract addresses
 * (package, storage, pools, oracle, reward funds, flash-loan config) are never
 * typed here: the SDK resolves them at runtime from Navi's open-api config
 * (`getConfig` / `getPools`) and verifyConfig() reads them back on-chain.
 */
import * as navi from "@naviprotocol/lending";

export type {
  Pool as NaviPool,
  EMode as NaviEMode,
  EModeCap as NaviEModeCap,
  LendingReward as NaviLendingReward,
  UserLendingInfo as NaviUserLendingInfo,
  LendingPosition as NaviLendingPosition,
  FloashloanAsset as NaviFlashLoanAsset,
  OraclePriceFeed as NaviOraclePriceFeed,
  LendingConfig as NaviLendingConfig,
  MarketConfig as NaviMarketConfig,
  NaviSuiClient,
} from "@naviprotocol/lending";

export interface NaviSdk {
  // reads (open-api HTTP)
  getPools: typeof navi.getPools;
  getConfig: typeof navi.getConfig;
  getAllFlashLoanAssets: typeof navi.getAllFlashLoanAssets;
  getPriceFeeds: typeof navi.getPriceFeeds;
  getMarketConfig: typeof navi.getMarketConfig;
  // reads (on-chain via client.core.simulateTransaction / getObject)
  getBorrowFee: typeof navi.getBorrowFee;
  getUserEModeCaps: typeof navi.getUserEModeCaps;
  getLendingState: typeof navi.getLendingState;
  getLendingPositions: typeof navi.getLendingPositions;
  getUserAvailableLendingRewards: typeof navi.getUserAvailableLendingRewards;
  // pure helper
  filterPriceFeeds: typeof navi.filterPriceFeeds;
  // PTB builders
  updateOraclePricesPTB: typeof navi.updateOraclePricesPTB;
  depositCoinPTB: typeof navi.depositCoinPTB;
  withdrawCoinPTB: typeof navi.withdrawCoinPTB;
  borrowCoinPTB: typeof navi.borrowCoinPTB;
  repayCoinPTB: typeof navi.repayCoinPTB;
  flashloanPTB: typeof navi.flashloanPTB;
  repayFlashLoanPTB: typeof navi.repayFlashLoanPTB;
  createEModeCapPTB: typeof navi.createEModeCapPTB;
  claimLendingRewardsPTB: typeof navi.claimLendingRewardsPTB;
}

export const defaultNaviSdk: NaviSdk = {
  getPools: navi.getPools,
  getConfig: navi.getConfig,
  getAllFlashLoanAssets: navi.getAllFlashLoanAssets,
  getPriceFeeds: navi.getPriceFeeds,
  getMarketConfig: navi.getMarketConfig,
  getBorrowFee: navi.getBorrowFee,
  getUserEModeCaps: navi.getUserEModeCaps,
  getLendingState: navi.getLendingState,
  getLendingPositions: navi.getLendingPositions,
  getUserAvailableLendingRewards: navi.getUserAvailableLendingRewards,
  filterPriceFeeds: navi.filterPriceFeeds,
  updateOraclePricesPTB: navi.updateOraclePricesPTB,
  depositCoinPTB: navi.depositCoinPTB,
  withdrawCoinPTB: navi.withdrawCoinPTB,
  borrowCoinPTB: navi.borrowCoinPTB,
  repayCoinPTB: navi.repayCoinPTB,
  flashloanPTB: navi.flashloanPTB,
  repayFlashLoanPTB: navi.repayFlashLoanPTB,
  createEModeCapPTB: navi.createEModeCapPTB,
  claimLendingRewardsPTB: navi.claimLendingRewardsPTB,
};

/** Market keys known to the installed SDK (MARKETS in market.d.ts). */
export const NAVI_MARKET_KEYS: string[] = Object.keys(navi.MARKETS);
export const NAVI_DEFAULT_MARKET: string = navi.DEFAULT_MARKET_IDENTITY;
