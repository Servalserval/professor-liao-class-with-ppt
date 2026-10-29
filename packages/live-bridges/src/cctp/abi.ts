/**
 * Minimal CCTP V2 EVM ABIs, transcribed from the contract sources:
 * SOURCE: https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/TokenMessengerV2.sol
 * SOURCE: https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/BaseTokenMessenger.sol
 * SOURCE: https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/MessageTransmitterV2.sol
 * SOURCE: https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/BaseMessageTransmitter.sol
 * SOURCE: https://github.com/circlefin/evm-cctp-contracts/blob/master/src/TokenMinter.sol + src/roles/TokenController.sol
 */
import { parseAbi } from "viem";

export const tokenMessengerV2Abi = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function getMinFeeAmount(uint256 amount) view returns (uint256)",
  "function minFee() view returns (uint256)",
  "function localMessageTransmitter() view returns (address)",
  "function localMinter() view returns (address)",
  "function remoteTokenMessengers(uint32 domain) view returns (bytes32)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
]);

export const messageTransmitterV2Abi = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool success)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
  "function localDomain() view returns (uint32)",
  "function version() view returns (uint32)",
]);

export const tokenMinterV2Abi = parseAbi([
  "function burnLimitsPerMessage(address token) view returns (uint256)",
  "function getLocalToken(uint32 remoteDomain, bytes32 remoteToken) view returns (address)",
]);
