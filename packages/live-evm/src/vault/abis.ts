/**
 * ABIs for ERC-4626 vault flavors. Plain ERC-4626 comes from viem
 * (`erc4626Abi`); MetaMorpho from @morpho-org/blue-sdk-viem (`metaMorphoAbi`).
 * Euler / Fluid view functions below are declared from the protocols' source
 * (read 2026-10-29) and only used for reads; writes are plain ERC-4626.
 */
import { erc4626Abi, parseAbi } from "viem";
import { metaMorphoAbi } from "@morpho-org/blue-sdk-viem";

export { erc4626Abi, metaMorphoAbi };

// SOURCE: https://github.com/euler-xyz/euler-vault-kit/blob/master/src/EVault/IEVault.sol
//   interestRate(): borrow "yield-per-second, scaled by 10**27"; interestFee(): "fraction scaled by 1e4";
//   cash(), totalBorrows(); hookConfig(): (hookTarget, hookedOps bitmask, see shared/Constants.sol OP_*)
//   EVC(): Ethereum Vault Connector (flavor sanity check).
export const eulerEVaultAbi = parseAbi([
  "function EVC() view returns (address)",
  "function cash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function interestRate() view returns (uint256)",
  "function interestFee() view returns (uint16)",
  "function interestRateModel() view returns (address)",
  "function hookConfig() view returns (address hookTarget, uint32 hookedOps)",
]);

// SOURCE: https://github.com/euler-xyz/euler-vault-kit/blob/master/src/InterestRateModels/IRMLinearKink.sol
//   ir = baseRate + slope1 * min(u32, kink) + slope2 * max(0, u32 - kink), u32 = borrows * 2^32-1 / (cash + borrows), RAY/s.
export const eulerIrmLinearKinkAbi = parseAbi([
  "function baseRate() view returns (uint256)",
  "function slope1() view returns (uint256)",
  "function slope2() view returns (uint256)",
  "function kink() view returns (uint256)",
]);

// SOURCE: https://github.com/Instadapp/fluid-contracts-public/blob/main/contracts/protocols/lending/interfaces/iFToken.sol
//         and .../lending/fToken/main.sol (maxWithdraw = min(_getLiquidityWithdrawable(), owner assets);
//         _getLiquidityWithdrawable() <= asset.balanceOf(liquidity_); deposits must be >= minDeposit()).
export const fluidFTokenAbi = parseAbi([
  "function getData() view returns (address liquidity_, address lendingFactory_, address lendingRewardsRateModel_, address permit2_, address rebalancer_, bool rewardsActive_, uint256 liquidityBalance_, uint256 liquidityExchangePrice_, uint256 tokenExchangePrice_)",
  "function minDeposit() view returns (uint256)",
]);

/** Euler EVK operation bits (shared/Constants.sol). */
export const EULER_OP_DEPOSIT = 1 << 0;
export const EULER_OP_WITHDRAW = 1 << 2;
export const EULER_OP_REDEEM = 1 << 3;
/** Euler's SECONDS_PER_YEAR (shared/Constants.sol, evk-periphery Lens/Utils.sol): 365.2425 days. */
export const EULER_SECONDS_PER_YEAR = 31_556_952;
export const EULER_RAY = 10n ** 27n;
export const EULER_CONFIG_SCALE = 10_000;
