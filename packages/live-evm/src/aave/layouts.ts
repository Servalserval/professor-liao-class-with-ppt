/**
 * UiPoolDataProviderV3.getReservesData() output layouts.
 *
 * The input is the same everywhere (`getReservesData(provider)`), but the
 * AggregatedReserveData struct changed between releases, and forks deploy
 * whatever periphery version they forked from. We decode the raw return data
 * against every known layout (newest first) and keep the first one that
 * passes strict sanity checks (reserve list match, bps ranges, ray indexes...).
 *
 * SOURCE (struct definitions, field order verified on GitHub):
 *  - v3.0.0       aave/aave-v3-periphery v1.13..v1.18  contracts/misc/interfaces/IUiPoolDataProviderV3.sol
 *  - v3.0.0-silo  aave/aave-v3-periphery v1.19..v1.21  (+ isSiloedBorrowing)
 *  - v3.0.1       aave/aave-v3-periphery v1.22..v2.5   (+ flashLoanEnabled) == address-book IUiPoolDataProvider_ABI
 *  - v3.1         aave-dao/aave-v3-origin v3.1.0       src/periphery/contracts/misc/interfaces/IUiPoolDataProviderV3.sol
 *  - v3.2         aave-dao/aave-v3-origin v3.2.0       src/contracts/helpers/interfaces/IUiPoolDataProviderV3.sol (stable + per-reserve e-mode removed)
 *  - v3.3         aave-dao/aave-v3-origin v3.3.0       (+ deficit)
 *  - v3.4         aave-dao/aave-v3-origin v3.4.0..main (unbacked, virtualAccActive removed)
 */
import { decodeFunctionResult, encodeFunctionResult, zeroAddress, type Abi, type Address, type Hex } from "viem";

export type UiLayout = "v3.4" | "v3.3" | "v3.2" | "v3.1" | "v3.0.1" | "v3.0.0-silo" | "v3.0.0";

type Field = readonly [name: string, type: string];

const HEAD: Field[] = [
  ["underlyingAsset", "address"],
  ["name", "string"],
  ["symbol", "string"],
  ["decimals", "uint256"],
  ["baseLTVasCollateral", "uint256"],
  ["reserveLiquidationThreshold", "uint256"],
  ["reserveLiquidationBonus", "uint256"],
  ["reserveFactor", "uint256"],
  ["usageAsCollateralEnabled", "bool"],
  ["borrowingEnabled", "bool"],
];

/** v3.0.x / v3.1 (stable-rate era, per-reserve e-mode). */
function legacyFields(opts: { siloed: boolean; flash: boolean; virtual: boolean }): Field[] {
  const f: Field[] = [
    ...HEAD,
    ["stableBorrowRateEnabled", "bool"],
    ["isActive", "bool"],
    ["isFrozen", "bool"],
    ["liquidityIndex", "uint128"],
    ["variableBorrowIndex", "uint128"],
    ["liquidityRate", "uint128"],
    ["variableBorrowRate", "uint128"],
    ["stableBorrowRate", "uint128"],
    ["lastUpdateTimestamp", "uint40"],
    ["aTokenAddress", "address"],
    ["stableDebtTokenAddress", "address"],
    ["variableDebtTokenAddress", "address"],
    ["interestRateStrategyAddress", "address"],
    ["availableLiquidity", "uint256"],
    ["totalPrincipalStableDebt", "uint256"],
    ["averageStableRate", "uint256"],
    ["stableDebtLastUpdateTimestamp", "uint256"],
    ["totalScaledVariableDebt", "uint256"],
    ["priceInMarketReferenceCurrency", "uint256"],
    ["priceOracle", "address"],
    ["variableRateSlope1", "uint256"],
    ["variableRateSlope2", "uint256"],
    ["stableRateSlope1", "uint256"],
    ["stableRateSlope2", "uint256"],
    ["baseStableBorrowRate", "uint256"],
    ["baseVariableBorrowRate", "uint256"],
    ["optimalUsageRatio", "uint256"],
    ["isPaused", "bool"],
  ];
  if (opts.siloed) f.push(["isSiloedBorrowing", "bool"]);
  f.push(["accruedToTreasury", "uint128"], ["unbacked", "uint128"], ["isolationModeTotalDebt", "uint128"]);
  if (opts.flash) f.push(["flashLoanEnabled", "bool"]);
  f.push(
    ["debtCeiling", "uint256"],
    ["debtCeilingDecimals", "uint256"],
    ["eModeCategoryId", "uint8"],
    ["borrowCap", "uint256"],
    ["supplyCap", "uint256"],
    ["eModeLtv", "uint16"],
    ["eModeLiquidationThreshold", "uint16"],
    ["eModeLiquidationBonus", "uint16"],
    ["eModePriceSource", "address"],
    ["eModeLabel", "string"],
    ["borrowableInIsolation", "bool"]
  );
  if (opts.virtual) f.push(["virtualAccActive", "bool"], ["virtualUnderlyingBalance", "uint128"]);
  return f;
}

/** v3.2+ (no stable rate, e-modes via bitmaps on the Pool). */
function modernFields(opts: { unbacked: boolean; virtualAccActive: boolean; deficit: boolean }): Field[] {
  const f: Field[] = [
    ...HEAD,
    ["isActive", "bool"],
    ["isFrozen", "bool"],
    ["liquidityIndex", "uint128"],
    ["variableBorrowIndex", "uint128"],
    ["liquidityRate", "uint128"],
    ["variableBorrowRate", "uint128"],
    ["lastUpdateTimestamp", "uint40"],
    ["aTokenAddress", "address"],
    ["variableDebtTokenAddress", "address"],
    ["interestRateStrategyAddress", "address"],
    ["availableLiquidity", "uint256"],
    ["totalScaledVariableDebt", "uint256"],
    ["priceInMarketReferenceCurrency", "uint256"],
    ["priceOracle", "address"],
    ["variableRateSlope1", "uint256"],
    ["variableRateSlope2", "uint256"],
    ["baseVariableBorrowRate", "uint256"],
    ["optimalUsageRatio", "uint256"],
    ["isPaused", "bool"],
    ["isSiloedBorrowing", "bool"],
    ["accruedToTreasury", "uint128"],
  ];
  if (opts.unbacked) f.push(["unbacked", "uint128"]);
  f.push(
    ["isolationModeTotalDebt", "uint128"],
    ["flashLoanEnabled", "bool"],
    ["debtCeiling", "uint256"],
    ["debtCeilingDecimals", "uint256"],
    ["borrowCap", "uint256"],
    ["supplyCap", "uint256"],
    ["borrowableInIsolation", "bool"]
  );
  if (opts.virtualAccActive) f.push(["virtualAccActive", "bool"]);
  f.push(["virtualUnderlyingBalance", "uint128"]);
  if (opts.deficit) f.push(["deficit", "uint128"]);
  return f;
}

export const UI_LAYOUT_FIELDS: Record<UiLayout, Field[]> = {
  "v3.4": modernFields({ unbacked: false, virtualAccActive: false, deficit: true }),
  "v3.3": modernFields({ unbacked: true, virtualAccActive: true, deficit: true }),
  "v3.2": modernFields({ unbacked: true, virtualAccActive: true, deficit: false }),
  "v3.1": legacyFields({ siloed: true, flash: true, virtual: true }),
  "v3.0.1": legacyFields({ siloed: true, flash: true, virtual: false }),
  "v3.0.0-silo": legacyFields({ siloed: true, flash: false, virtual: false }),
  "v3.0.0": legacyFields({ siloed: false, flash: false, virtual: false }),
};

/** Newest first: the detector tries them in this order. */
export const UI_LAYOUT_ORDER: UiLayout[] = ["v3.4", "v3.3", "v3.2", "v3.1", "v3.0.1", "v3.0.0-silo", "v3.0.0"];

export function isLegacyLayout(l: UiLayout): boolean {
  return l === "v3.1" || l.startsWith("v3.0");
}

const BASE_CURRENCY_COMPONENTS = [
  { name: "marketReferenceCurrencyUnit", type: "uint256" },
  { name: "marketReferenceCurrencyPriceInUsd", type: "int256" },
  { name: "networkBaseTokenPriceInUsd", type: "int256" },
  { name: "networkBaseTokenPriceDecimals", type: "uint8" },
] as const;

export function uiLayoutAbi(layout: UiLayout): Abi {
  return [
    {
      type: "function",
      name: "getReservesData",
      stateMutability: "view",
      inputs: [{ name: "provider", type: "address" }],
      outputs: [
        { name: "", type: "tuple[]", components: UI_LAYOUT_FIELDS[layout].map(([name, type]) => ({ name, type })) },
        { name: "", type: "tuple", components: BASE_CURRENCY_COMPONENTS },
      ],
    },
  ] as Abi;
}

const ABIS: Record<UiLayout, Abi> = Object.fromEntries(UI_LAYOUT_ORDER.map((l) => [l, uiLayoutAbi(l)])) as Record<UiLayout, Abi>;

/** Normalized reserve row (fields absent in a layout are undefined / defaulted). */
export interface UiReserve {
  underlyingAsset: Address;
  name: string;
  symbol: string;
  decimals: number;
  /** bps */
  baseLTVasCollateral: number;
  reserveLiquidationThreshold: number;
  reserveLiquidationBonus: number;
  reserveFactor: number;
  usageAsCollateralEnabled: boolean;
  borrowingEnabled: boolean;
  isActive: boolean;
  isFrozen: boolean;
  isPaused: boolean;
  liquidityIndex: bigint;
  variableBorrowIndex: bigint;
  /** ray, APR */
  liquidityRate: bigint;
  /** ray, APR */
  variableBorrowRate: bigint;
  lastUpdateTimestamp: number;
  aTokenAddress: Address;
  variableDebtTokenAddress: Address;
  interestRateStrategyAddress: Address;
  availableLiquidity: bigint;
  totalScaledVariableDebt: bigint;
  totalPrincipalStableDebt: bigint;
  priceInMarketReferenceCurrency: bigint;
  priceOracle: Address;
  /** ray */
  variableRateSlope1: bigint;
  variableRateSlope2: bigint;
  baseVariableBorrowRate: bigint;
  optimalUsageRatio: bigint;
  isSiloedBorrowing: boolean;
  accruedToTreasury: bigint;
  isolationModeTotalDebt: bigint;
  flashLoanEnabled: boolean;
  debtCeiling: bigint;
  debtCeilingDecimals: number;
  /** whole tokens, 0 = no cap */
  borrowCap: bigint;
  supplyCap: bigint;
  borrowableInIsolation: boolean;
  /** v3.0/3.1 per-reserve e-mode */
  eModeCategoryId?: number;
  eModeLtv?: number;
  eModeLiquidationThreshold?: number;
  eModeLabel?: string;
  virtualAccActive?: boolean;
  virtualUnderlyingBalance?: bigint;
  deficit?: bigint;
}

export interface UiBaseCurrency {
  marketReferenceCurrencyUnit: bigint;
  marketReferenceCurrencyPriceInUsd: bigint;
  networkBaseTokenPriceInUsd: bigint;
  networkBaseTokenPriceDecimals: number;
}

export interface UiReservesData {
  layout: UiLayout;
  reserves: UiReserve[];
  base: UiBaseCurrency;
  /**
   * true = re-encoding the decoded values with this layout reproduces the
   * return data byte for byte (layout identified exactly). false = only a
   * sane prefix decode (unknown fork layout with extra trailing fields).
   */
  exact: boolean;
}

const RAY = 10n ** 27n;
const big = (x: unknown): bigint => (typeof x === "bigint" ? x : typeof x === "number" ? BigInt(x) : 0n);
const num = (x: unknown): number => (typeof x === "bigint" ? Number(x) : typeof x === "number" ? x : NaN);

function normalize(raw: Record<string, unknown>, layout: UiLayout): UiReserve {
  const legacy = isLegacyLayout(layout);
  return {
    underlyingAsset: raw.underlyingAsset as Address,
    name: String(raw.name ?? ""),
    symbol: String(raw.symbol ?? ""),
    decimals: num(raw.decimals),
    baseLTVasCollateral: num(raw.baseLTVasCollateral),
    reserveLiquidationThreshold: num(raw.reserveLiquidationThreshold),
    reserveLiquidationBonus: num(raw.reserveLiquidationBonus),
    reserveFactor: num(raw.reserveFactor),
    usageAsCollateralEnabled: Boolean(raw.usageAsCollateralEnabled),
    borrowingEnabled: Boolean(raw.borrowingEnabled),
    isActive: Boolean(raw.isActive),
    isFrozen: Boolean(raw.isFrozen),
    isPaused: Boolean(raw.isPaused),
    liquidityIndex: big(raw.liquidityIndex),
    variableBorrowIndex: big(raw.variableBorrowIndex),
    liquidityRate: big(raw.liquidityRate),
    variableBorrowRate: big(raw.variableBorrowRate),
    lastUpdateTimestamp: num(raw.lastUpdateTimestamp),
    aTokenAddress: raw.aTokenAddress as Address,
    variableDebtTokenAddress: raw.variableDebtTokenAddress as Address,
    interestRateStrategyAddress: raw.interestRateStrategyAddress as Address,
    availableLiquidity: big(raw.availableLiquidity),
    totalScaledVariableDebt: big(raw.totalScaledVariableDebt),
    totalPrincipalStableDebt: big(raw.totalPrincipalStableDebt),
    priceInMarketReferenceCurrency: big(raw.priceInMarketReferenceCurrency),
    priceOracle: (raw.priceOracle as Address) ?? zeroAddress,
    variableRateSlope1: big(raw.variableRateSlope1),
    variableRateSlope2: big(raw.variableRateSlope2),
    baseVariableBorrowRate: big(raw.baseVariableBorrowRate),
    optimalUsageRatio: big(raw.optimalUsageRatio),
    isSiloedBorrowing: Boolean(raw.isSiloedBorrowing),
    accruedToTreasury: big(raw.accruedToTreasury),
    isolationModeTotalDebt: big(raw.isolationModeTotalDebt),
    // pre-3.0.1 periphery had no flag; flash loans were always on then
    flashLoanEnabled: raw.flashLoanEnabled === undefined ? true : Boolean(raw.flashLoanEnabled),
    debtCeiling: big(raw.debtCeiling),
    debtCeilingDecimals: num(raw.debtCeilingDecimals),
    borrowCap: big(raw.borrowCap),
    supplyCap: big(raw.supplyCap),
    borrowableInIsolation: Boolean(raw.borrowableInIsolation),
    eModeCategoryId: legacy ? num(raw.eModeCategoryId) : undefined,
    eModeLtv: legacy ? num(raw.eModeLtv) : undefined,
    eModeLiquidationThreshold: legacy ? num(raw.eModeLiquidationThreshold) : undefined,
    eModeLabel: legacy ? String(raw.eModeLabel ?? "") : undefined,
    virtualAccActive: raw.virtualAccActive === undefined ? undefined : Boolean(raw.virtualAccActive),
    virtualUnderlyingBalance: raw.virtualUnderlyingBalance === undefined ? undefined : big(raw.virtualUnderlyingBalance),
    deficit: raw.deficit === undefined ? undefined : big(raw.deficit),
  };
}

/** Returns the reason a decoded row is implausible, or null if it looks sane. */
export function reserveSanityIssue(r: UiReserve): string | null {
  const bps = (x: number) => Number.isInteger(x) && x >= 0 && x <= 10_000;
  if (!/^0x[0-9a-fA-F]{40}$/.test(r.underlyingAsset) || r.underlyingAsset === zeroAddress) return "underlying";
  if (!(Number.isInteger(r.decimals) && r.decimals >= 0 && r.decimals <= 36)) return "decimals";
  if (!bps(r.baseLTVasCollateral) || !bps(r.reserveLiquidationThreshold) || !bps(r.reserveFactor)) return "bps";
  if (!(Number.isInteger(r.reserveLiquidationBonus) && r.reserveLiquidationBonus >= 0 && r.reserveLiquidationBonus < 65_536)) return "bonus";
  if (r.aTokenAddress === zeroAddress || r.variableDebtTokenAddress === zeroAddress) return "token addresses";
  if (r.liquidityIndex !== 0n && (r.liquidityIndex < RAY || r.liquidityIndex > 1000n * RAY)) return "liquidityIndex";
  if (r.variableBorrowIndex !== 0n && (r.variableBorrowIndex < RAY || r.variableBorrowIndex > 1000n * RAY)) return "variableBorrowIndex";
  if (!(Number.isFinite(r.lastUpdateTimestamp) && r.lastUpdateTimestamp >= 0 && r.lastUpdateTimestamp < 1e11)) return "timestamp";
  if (r.optimalUsageRatio > RAY) return "optimalUsageRatio";
  if (r.liquidityRate > 100n * RAY || r.variableBorrowRate > 100n * RAY) return "rates";
  if (!(Number.isInteger(r.debtCeilingDecimals) && r.debtCeilingDecimals >= 0 && r.debtCeilingDecimals <= 36)) return "debtCeilingDecimals";
  if (r.eModeCategoryId !== undefined && !(Number.isInteger(r.eModeCategoryId) && r.eModeCategoryId >= 0 && r.eModeCategoryId <= 255)) return "eModeCategoryId";
  if (r.eModeLtv !== undefined && !bps(r.eModeLtv)) return "eModeLtv";
  if (r.eModeLiquidationThreshold !== undefined && !bps(r.eModeLiquidationThreshold)) return "eModeLT";
  return null;
}

type RawOut = readonly [readonly Record<string, unknown>[], Record<string, unknown>];

function decodeRaw(data: Hex, layout: UiLayout): RawOut {
  return decodeFunctionResult({ abi: ABIS[layout], functionName: "getReservesData", data }) as unknown as RawOut;
}

function fromRaw(out: RawOut, layout: UiLayout, exact: boolean): UiReservesData {
  const [rows, base] = out;
  return {
    layout,
    exact,
    reserves: rows.map((r) => normalize(r, layout)),
    base: {
      marketReferenceCurrencyUnit: big(base.marketReferenceCurrencyUnit),
      marketReferenceCurrencyPriceInUsd: big(base.marketReferenceCurrencyPriceInUsd),
      networkBaseTokenPriceInUsd: big(base.networkBaseTokenPriceInUsd),
      networkBaseTokenPriceDecimals: num(base.networkBaseTokenPriceDecimals),
    },
  };
}

function reencodes(out: RawOut, layout: UiLayout, data: Hex): boolean {
  try {
    const again = encodeFunctionResult({ abi: ABIS[layout], functionName: "getReservesData", result: out } as Parameters<typeof encodeFunctionResult>[0]);
    return again.toLowerCase() === data.toLowerCase();
  } catch {
    return false;
  }
}

export function decodeUiReservesData(data: Hex, layout: UiLayout): UiReservesData {
  const raw = decodeRaw(data, layout);
  return fromRaw(raw, layout, reencodes(raw, layout, data));
}

/**
 * Identify the layout: a candidate must decode, pass the sanity checks and
 * (with `reservesList` = Pool.getReservesList()) return exactly that list in
 * order. Among those, the one whose re-encoding reproduces the bytes exactly
 * wins (this separates layouts that only differ by trailing fields, e.g.
 * v3.2 vs v3.3). If none is exact (unknown fork layout), the first sane
 * decode in newest-first order is returned with exact=false.
 */
export function detectUiReservesData(data: Hex, reservesList?: readonly Address[], prefer?: UiLayout): UiReservesData {
  const order = prefer ? [prefer, ...UI_LAYOUT_ORDER.filter((l) => l !== prefer)] : UI_LAYOUT_ORDER;
  const errors: string[] = [];
  let firstSane: UiReservesData | undefined;
  for (const layout of order) {
    let raw: RawOut;
    let d: UiReservesData;
    try {
      raw = decodeRaw(data, layout);
      d = fromRaw(raw, layout, false);
    } catch (e) {
      errors.push(`${layout}: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    if (!(d.base.marketReferenceCurrencyUnit > 0n)) {
      errors.push(`${layout}: base currency unit 0`);
      continue;
    }
    if (reservesList) {
      const a = d.reserves.map((r) => r.underlyingAsset.toLowerCase());
      const b = reservesList.map((x) => x.toLowerCase());
      if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
        errors.push(`${layout}: reserve list mismatch`);
        continue;
      }
    }
    const bad = d.reserves.map(reserveSanityIssue).find((x) => x !== null);
    if (bad) {
      errors.push(`${layout}: implausible ${bad}`);
      continue;
    }
    if (reencodes(raw, layout, data)) return { ...d, exact: true };
    firstSane ??= d;
  }
  if (firstSane) return firstSane;
  throw new Error(`UiPoolDataProvider.getReservesData: no known layout fits (${errors.join("; ")})`);
}
