/**
 * CCTP V2 on Sui (domain 8): burn PTB (Sui -> EVM), receive PTB (EVM -> Sui),
 * nonce-used read, and on-chain config checks.
 *
 * Move signatures were read from the published sources:
 * SOURCE: https://github.com/circlefin/sui-cctp/blob/master/packages/token_messenger_minter_v2/sources/deposit_for_burn.move
 * SOURCE: https://github.com/circlefin/sui-cctp/blob/master/packages/token_messenger_minter_v2/sources/handle_receive_message.move
 * SOURCE: https://github.com/circlefin/sui-cctp/blob/master/packages/message_transmitter_v2/sources/receive_message.move
 * SOURCE: https://github.com/circlefin/sui-cctp/blob/master/packages/message_transmitter_v2/sources/state.move
 * SOURCE: https://github.com/circlefin/sui-cctp/blob/master/packages/stablecoin_handler/sources/handler.move
 * PTB order follows https://developers.circle.com/cctp/quickstarts/transfer-usdc-sui-arc.md
 *
 *   burn:    deposit_for_burn::deposit_for_burn<USDC>(coin, dst_domain, mint_recipient, dst_caller, max_fee, min_finality, hook_data, &tmm_state)
 *              -> (BurnReceipt<USDC>, Coin<USDC>)
 *            handler::burn(&handler_state, receipt, coin, &DenyList(0x403), &mut Treasury<USDC>) -> CompleteBurnTicket<USDC, Auth>
 *            deposit_for_burn::complete_burn<USDC, handler::Auth>(ticket, &tmm_state, &mt_state)
 *   receive: receive_message::receive_message(message, attestation, &mut mt_state) -> Receipt
 *            handle_receive_message::prepare_mint<USDC>(receipt, &tmm_state, &Clock(0x6)) -> MintReceipt<USDC>
 *            handler::mint(&handler_state, mint_receipt, &tmm_state, &mut Treasury<USDC>, &DenyList) -> CompleteMintTicket<USDC, Auth>
 *            handle_receive_message::complete_mint<USDC, handler::Auth>(ticket, &tmm_state, &mt_state)
 *   (handler::mint mints straight to mint_recipient; no transfer command needed.)
 */
import { Transaction, normalizeStructTag, normalizeSuiAddress, type SuiEnv } from "@incentive-router/live-sui";
import { SUI_CLOCK_OBJECT_ID, SUI_DENY_LIST_OBJECT_ID, fromHex } from "@mysten/sui/utils";
import { hexToBigInt, type Hex } from "viem";

export interface SuiCctpConfig {
  messageTransmitterPackage: string;
  tokenMessengerMinterPackage: string;
  stablecoinHandlerPackage: string;
  messageTransmitterState: string;
  tokenMessengerMinterState: string;
  stablecoinHandlerState: string;
  usdcTreasury: string;
  /**
   * Package id that defines `handler::Auth` (type argument). Equals
   * stablecoinHandlerPackage until the handler is upgraded (types keep the
   * original id). verifySuiCctp warns when the state type says otherwise.
   */
  handlerTypeOrigin?: string;
}

// SOURCE: https://developers.circle.com/cctp/references/sui-packages.md (Mainnet packages + Mainnet state objects, domain 8)
export const SUI_CCTP_V2_MAINNET: SuiCctpConfig = {
  messageTransmitterPackage: "0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87", // SOURCE: sui-packages.md
  tokenMessengerMinterPackage: "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830", // SOURCE: sui-packages.md
  stablecoinHandlerPackage: "0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf", // SOURCE: sui-packages.md
  messageTransmitterState: "0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c", // SOURCE: sui-packages.md
  tokenMessengerMinterState: "0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167", // SOURCE: sui-packages.md
  stablecoinHandlerState: "0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41", // SOURCE: sui-packages.md
  usdcTreasury: "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7", // SOURCE: sui-packages.md (USDC Treasury)
};

export const SUI_CCTP_DOMAIN = 8;

function handlerAuthType(cfg: SuiCctpConfig): string {
  return `${normalizeSuiAddress(cfg.handlerTypeOrigin ?? cfg.stablecoinHandlerPackage)}::handler::Auth`;
}

function hexBytes(h: Hex): Uint8Array {
  return fromHex(h.replace(/^0x/, ""));
}

export interface SuiBurnArgs {
  usdcType: string;
  amount: bigint;
  destinationDomain: number;
  /** 32-byte recipient (EVM address left-padded). */
  mintRecipient32: Hex;
  maxFee: bigint;
  minFinalityThreshold: number;
}

/** Append the 3-step CCTP V2 burn to `tx`. The USDC coin comes from address balance or owned coins (tx.coin intent). */
export function appendSuiBurn(tx: Transaction, cfg: SuiCctpConfig, a: SuiBurnArgs): void {
  const usdc = normalizeStructTag(a.usdcType);
  const coin = tx.coin({ type: usdc, balance: a.amount });
  const [burnReceipt, returnedCoin] = tx.moveCall({
    target: `${cfg.tokenMessengerMinterPackage}::deposit_for_burn::deposit_for_burn`,
    typeArguments: [usdc],
    arguments: [
      coin,
      tx.pure.u32(a.destinationDomain),
      tx.pure.address(normalizeSuiAddress(a.mintRecipient32)),
      tx.pure.address(normalizeSuiAddress("0x0")), // destination_caller: anyone may receive
      tx.pure.u256(a.maxFee),
      tx.pure.u32(a.minFinalityThreshold),
      tx.pure.vector("u8", []),
      tx.object(cfg.tokenMessengerMinterState),
    ],
  });
  const [ticket] = tx.moveCall({
    target: `${cfg.stablecoinHandlerPackage}::handler::burn`,
    arguments: [tx.object(cfg.stablecoinHandlerState), burnReceipt!, returnedCoin!, tx.object(SUI_DENY_LIST_OBJECT_ID), tx.object(cfg.usdcTreasury)],
  });
  tx.moveCall({
    target: `${cfg.tokenMessengerMinterPackage}::deposit_for_burn::complete_burn`,
    typeArguments: [usdc, handlerAuthType(cfg)],
    arguments: [ticket!, tx.object(cfg.tokenMessengerMinterState), tx.object(cfg.messageTransmitterState)],
  });
}

export function buildSuiBurnPtb(cfg: SuiCctpConfig, a: SuiBurnArgs): Transaction {
  const tx = new Transaction();
  appendSuiBurn(tx, cfg, a);
  return tx;
}

/** Receive an attested EVM -> Sui message; USDC is minted to the message's mint_recipient. */
export function buildSuiReceivePtb(cfg: SuiCctpConfig, usdcType: string, message: Hex, attestation: Hex): Transaction {
  const usdc = normalizeStructTag(usdcType);
  const tx = new Transaction();
  const [receipt] = tx.moveCall({
    target: `${cfg.messageTransmitterPackage}::receive_message::receive_message`,
    arguments: [tx.pure.vector("u8", hexBytes(message)), tx.pure.vector("u8", hexBytes(attestation)), tx.object(cfg.messageTransmitterState)],
  });
  const [mintReceipt] = tx.moveCall({
    target: `${cfg.tokenMessengerMinterPackage}::handle_receive_message::prepare_mint`,
    typeArguments: [usdc],
    arguments: [receipt!, tx.object(cfg.tokenMessengerMinterState), tx.object(SUI_CLOCK_OBJECT_ID)],
  });
  const [ticket] = tx.moveCall({
    target: `${cfg.stablecoinHandlerPackage}::handler::mint`,
    arguments: [
      tx.object(cfg.stablecoinHandlerState),
      mintReceipt!,
      tx.object(cfg.tokenMessengerMinterState),
      tx.object(cfg.usdcTreasury),
      tx.object(SUI_DENY_LIST_OBJECT_ID),
    ],
  });
  tx.moveCall({
    target: `${cfg.tokenMessengerMinterPackage}::handle_receive_message::complete_mint`,
    typeArguments: [usdc, handlerAuthType(cfg)],
    arguments: [ticket!, tx.object(cfg.tokenMessengerMinterState), tx.object(cfg.messageTransmitterState)],
  });
  return tx;
}

/** message_transmitter_v2::state::is_nonce_used(&State, u256): bool via a read-only simulation. */
export async function suiNonceUsed(env: SuiEnv, cfg: SuiCctpConfig, nonce: Hex): Promise<boolean> {
  const tx = new Transaction();
  tx.setSender(env.address);
  tx.moveCall({
    target: `${cfg.messageTransmitterPackage}::state::is_nonce_used`,
    arguments: [tx.object(cfg.messageTransmitterState), tx.pure.u256(hexToBigInt(nonce))],
  });
  const sim = await env.grpc.core.simulateTransaction({ transaction: tx, include: { commandResults: true }, checksEnabled: false });
  if (sim.$kind !== "Transaction") throw new Error(`sui: is_nonce_used simulation failed: ${JSON.stringify(sim.FailedTransaction?.status)}`);
  const rv = sim.commandResults?.[0]?.returnValues?.[0]?.bcs;
  if (!rv || rv.length < 1) throw new Error("sui: is_nonce_used returned no value");
  return rv[0] === 1;
}

/** Existence + type checks for every configured Sui CCTP object, and the USDC type against Circle's treasury. */
export async function verifySuiCctp(env: SuiEnv, cfg: SuiCctpConfig, usdcType: string): Promise<string[]> {
  const issues: string[] = [];
  const ids: [string, string, string | undefined][] = [
    ["messageTransmitterPackage", cfg.messageTransmitterPackage, undefined],
    ["tokenMessengerMinterPackage", cfg.tokenMessengerMinterPackage, undefined],
    ["stablecoinHandlerPackage", cfg.stablecoinHandlerPackage, undefined],
    ["messageTransmitterState", cfg.messageTransmitterState, "::state::State"],
    ["tokenMessengerMinterState", cfg.tokenMessengerMinterState, "::state::State"],
    ["stablecoinHandlerState", cfg.stablecoinHandlerState, "::state::State"],
    ["usdcTreasury", cfg.usdcTreasury, `::treasury::Treasury<${normalizeStructTag(usdcType)}>`],
  ];
  let res: Awaited<ReturnType<SuiEnv["grpc"]["core"]["getObjects"]>>;
  try {
    res = await env.grpc.core.getObjects({ objectIds: ids.map((i) => i[1]) });
  } catch (e) {
    return [`sui cctp: getObjects failed: ${(e as Error).message}`];
  }
  res.objects.forEach((o, i) => {
    const [name, id, typeSuffix] = ids[i]!;
    if (o instanceof Error) {
      issues.push(`sui cctp: ${name} ${id} not found (${o.message})`);
      return;
    }
    if (typeSuffix && !o.type.endsWith(typeSuffix)) issues.push(`sui cctp: ${name} ${id} has type ${o.type}, expected *${typeSuffix}`);
    if (name === "stablecoinHandlerState") {
      const origin = normalizeSuiAddress(o.type.split("::")[0]!);
      const want = normalizeSuiAddress(cfg.handlerTypeOrigin ?? cfg.stablecoinHandlerPackage);
      if (origin !== want) issues.push(`sui cctp: handler State type origin ${origin} != handler Auth type origin ${want}; set handlerTypeOrigin`);
    }
  });
  return issues;
}
