/**
 * ABIs. Morpho Blue core / AdaptiveCurveIrm / oracle ABIs come from the
 * installed @morpho-org/blue-sdk-viem (lib/esm/abis.d.ts). Lista Lending
 * (Moolah, a Morpho Blue fork on BNB Chain) keeps the same core function
 * signatures (supply/borrow/repay/supplyCollateral/withdrawCollateral take
 * the same MarketParams tuple; idToMarketParams/market/position are
 * selector-identical) but prices through the Moolah contract instead of an
 * IOracle.price(), and adds whitelists / brokers / providers / minLoan. Only
 * the extra view functions used here are declared below.
 */
import { adaptiveCurveIrmAbi, blueAbi, blueOracleAbi } from "@morpho-org/blue-sdk-viem";
import { parseAbi } from "viem";

export { adaptiveCurveIrmAbi, blueAbi, blueOracleAbi };

// SOURCE: https://github.com/lista-dao/moolah/blob/master/src/moolah/interfaces/IMoolah.sol
//         (IMoolahBase.isWhiteList / brokers / providers / minLoan, IMoolah.getPrice)
//         and src/moolah/Moolah.sol (PausableUpgradeable.paused, whenNotPaused on every write).
// Read back by MorphoBlueAdapter.verifyConfig() (flavor "lista") before live use.
export const listaMoolahAbi = parseAbi([
  "function getPrice((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams) view returns (uint256)",
  "function minLoan((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams) view returns (uint256)",
  "function isWhiteList(bytes32 id, address account) view returns (bool)",
  "function brokers(bytes32 id) view returns (address)",
  "function providers(bytes32 id, address token) view returns (address)",
  "function paused() view returns (bool)",
]);
