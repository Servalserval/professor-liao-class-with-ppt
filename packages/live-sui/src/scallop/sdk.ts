/**
 * Narrow port onto @scallop-io/sui-scallop-sdk 5.4.3. The adapter only talks
 * to these Picks of the SDK classes, so tests can inject a fake and the real
 * implementation is the SDK itself (structurally identical signatures).
 *
 * SDK references (node_modules/@scallop-io/sui-scallop-sdk/dist/query-*.d.ts):
 *  - ScallopQuery.getMarketPools / getBorrowIncentivePools / getFlashLoanFees /
 *    getObligations / queryObligation / getObligationAccountById /
 *    getBindedVeScaKey / getAllStakeAccounts / getSpools
 *  - ScallopTxBlock core normal methods (openObligation, depositCollateral,
 *    takeCollateral, borrow, repay, borrowFlashLoan, repayFlashLoan),
 *    updateAssetPricesQuick (xOracle price_update_request + Pyth/Supra/
 *    Switchboard rule set_price + confirm, per coin), borrow-incentive
 *    stake/unstake/claim, spool claimQuick; lending: supply (mint::mint ->
 *    MarketCoin), withdraw (redeem::redeem), mintSCoin / burnSCoin, spool
 *    createStakeAccount / stake / unstake / claim (normal methods).
 */
import type { ScallopConstants, ScallopQuery, ScallopTxBlock, ScallopUtils } from "@scallop-io/sui-scallop-sdk";
import type { Transaction } from "@mysten/sui/transactions";
import type { SuiEnv } from "../common.js";

export type ScallopQueryLike = Pick<
  ScallopQuery,
  | "getMarketPools"
  | "getBorrowIncentivePools"
  | "getFlashLoanFees"
  | "getObligations"
  | "queryObligation"
  | "getObligationAccountById"
  | "getBindedVeScaKey"
  | "getAllStakeAccounts"
  | "getSpools"
>;

export type ScallopTxLike = Pick<
  ScallopTxBlock,
  | "updateAssetPricesQuick"
  | "openObligation"
  | "returnObligation"
  | "depositCollateral"
  | "takeCollateral"
  | "borrow"
  | "repay"
  | "borrowFlashLoan"
  | "repayFlashLoan"
  | "stakeObligation"
  | "stakeObligationWithVeScaQuick"
  | "unstakeObligationQuick"
  | "claimBorrowIncentive"
  | "claimQuick"
  // supply-only lending (mint/redeem MarketCoin, sCoin wrap, spool staking)
  | "supply"
  | "withdraw"
  | "mintSCoin"
  | "burnSCoin"
  | "createStakeAccount"
  | "stake"
  | "unstake"
  | "claim"
>;

/**
 * One PTB shared by Scallop calls and our own commands (swaps, coin ops).
 * NOTE: sui-kit's SuiTxBlock constructor COPIES a Transaction passed to it
 * (`Transaction.from(tx)`), so we must not hand the SDK our own Transaction;
 * we let the SDK create the block and use its inner `txBlock` everywhere.
 */
export interface ScallopPtb {
  tx: Transaction;
  stx: ScallopTxLike;
}

export interface ScallopSdkLike {
  query: ScallopQueryLike;
  utils: Pick<
    ScallopUtils,
    "parseCoinNameFromType" | "parseSCoinName" | "parseSCoinType" | "parseMarketCoinType" | "parseMarketCoinName" | "parseSymbol"
  >;
  constants: Pick<ScallopConstants, "whitelist" | "get" | "protocolObjectId" | "coinTypes" | "coinDecimals">;
  createPtb(): ScallopPtb;
}

/**
 * Scallop API address-config id used by the SDK to fetch the protocol address
 * book (package ids, market, xOracle, borrow-incentive objects ...). It is
 * not a chain address; the objects it resolves to are checked on-chain by
 * verifyScallopConfig() before live use.
 * SOURCE: node_modules/@scallop-io/sui-scallop-sdk/README.md ("Create SDK" mainnet examples)
 */
export const DEFAULT_SCALLOP_ADDRESS_ID = "695fcdc084f790c04eb068dc";

export interface ScallopSdkOptions {
  addressId?: string;
  /** Pyth Hermes endpoint for the in-PTB pull-oracle updates (SDK default: https://pyth.dourolabs.app/hermes). */
  pythEndpoint?: string;
  /** Hermes access token (the hosted endpoint now requires one, per SDK README). */
  pythApiKey?: string;
  indexerUrl?: string;
}

/** Build the real SDK port on our gRPC client (reads only; writes go through executePtb). */
export async function createScallopSdk(env: SuiEnv, opts: ScallopSdkOptions = {}): Promise<ScallopSdkLike> {
  const { ScallopBuilder } = await import("@scallop-io/sui-scallop-sdk");
  const builder = new ScallopBuilder({
    addressId: opts.addressId ?? DEFAULT_SCALLOP_ADDRESS_ID,
    network: env.network,
    suiClient: env.grpc,
    walletAddress: env.address,
    strictInit: true,
    ...(opts.pythEndpoint ? { pythEndpoint: opts.pythEndpoint } : {}),
    ...(opts.pythApiKey ? { pythApiKey: opts.pythApiKey } : {}),
    ...(opts.indexerUrl ? { indexerUrl: opts.indexerUrl } : {}),
  });
  await builder.init();
  return {
    query: builder.query,
    utils: builder.utils,
    constants: builder.constants,
    createPtb: () => {
      const stx = builder.createTxBlock();
      return { tx: stx.txBlock, stx };
    },
  };
}
