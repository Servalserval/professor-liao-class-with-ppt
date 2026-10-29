/** Exact conversions between base units and human / USD values. */

export function toUnits(human: number, decimals: number): bigint {
  if (!Number.isFinite(human) || human < 0) throw new Error(`toUnits: invalid amount ${human}`);
  // go through a fixed decimal string to avoid float -> bigint surprises
  const s = human.toFixed(Math.min(decimals, 18));
  const [i, f = ""] = s.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(i!) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

export function fromUnits(units: bigint, decimals: number): number {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const v = Number(u / base) + Number(u % base) / Number(base);
  return neg ? -v : v;
}

export function usdToUnits(usd: number, priceUsd: number, decimals: number): bigint {
  if (!(priceUsd > 0)) throw new Error(`usdToUnits: invalid price ${priceUsd}`);
  return toUnits(usd / priceUsd, decimals);
}

export function unitsToUsd(units: bigint, priceUsd: number, decimals: number): number {
  return fromUnits(units, decimals) * priceUsd;
}

/** amount * (1 - bps/1e4), rounded down. */
export function minusBps(amount: bigint, bps: number): bigint {
  const b = BigInt(Math.max(0, Math.round(bps)));
  return (amount * (10_000n - b)) / 10_000n;
}

export function applyFraction(amount: bigint, fraction: number): bigint {
  if (!(fraction >= 0 && fraction <= 1)) throw new Error(`fraction out of range: ${fraction}`);
  const ppm = BigInt(Math.round(fraction * 1_000_000));
  return (amount * ppm) / 1_000_000n;
}
