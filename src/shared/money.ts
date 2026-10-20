/**
 * Fixed-precision money arithmetic.
 *
 * All amounts are integer minor units (e.g. paise). Intermediate products use BigInt,
 * so no IEEE-754 floating point is ever involved in a financial calculation.
 * Rounding rule: ROUND_HALF_UP (half away from zero), applied once per computed amount.
 */

export const RATE_SCALE = 1_000_000_000n; // exchange rates are stored × 1e9
export const RATE_SCALE_NUM = 1_000_000_000;
export const QTY_SCALE = 1000; // quantities are stored × 1000 (milli-units)

/** Divide a by b (b > 0) rounding half away from zero. */
export function divRound(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("divRound: divisor must be positive");
  const neg = a < 0n;
  const abs = neg ? -a : a;
  const q = abs / b;
  const r = abs % b;
  const rounded = r * 2n >= b ? q + 1n : q;
  return neg ? -rounded : rounded;
}

function toSafeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError("Amount exceeds safe integer range");
  }
  return Number(v);
}

export function assertMinor(v: unknown, field = "amount"): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    throw new TypeError(`${field} must be an integer number of minor units`);
  }
  return v;
}

/**
 * Parse a decimal string such as "1,234.56" or "-0.5" into integer minor units.
 * Rejects more fractional digits than the currency allows (no silent rounding of input).
 */
export function parseDecimal(input: string | number, exponent: number): number {
  const s = String(input).trim().replace(/,/g, "").replace(/_/g, "");
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] === undefined || m[3] === ""))) {
    throw new TypeError(`Invalid amount: "${input}"`);
  }
  const sign = m[1] === "-" ? -1n : 1n;
  const whole = m[2] || "0";
  const frac = m[3] ?? "";
  if (frac.length > exponent) {
    // allow trailing zeros beyond precision, e.g. "1.500" for a 2-dp currency
    if (/[^0]/.test(frac.slice(exponent))) {
      throw new RangeError(`Amount "${input}" has more than ${exponent} decimal places`);
    }
  }
  const fracPadded = (frac + "0".repeat(exponent)).slice(0, exponent);
  const v = sign * (BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fracPadded || "0"));
  return toSafeNumber(v);
}

/** Format integer minor units as a plain decimal string ("-1234.50"). */
export function toDecimalString(minor: number, exponent: number): string {
  const neg = minor < 0;
  const abs = BigInt(Math.abs(minor));
  if (exponent === 0) return (neg ? "-" : "") + abs.toString();
  const base = 10n ** BigInt(exponent);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(exponent, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Parse a quantity string with up to 3 decimals into milli-units. */
export function parseQty(input: string | number): number {
  return parseDecimal(input, 3);
}

/** Parse an exchange rate (up to 9 decimals) into the 1e9-scaled integer form. */
export function parseRate(input: string | number): number {
  const v = parseDecimal(input, 9);
  if (v <= 0) throw new RangeError("Exchange rate must be positive");
  return v;
}

export function rateToString(rateScaled: number): string {
  return toDecimalString(rateScaled, 9).replace(/\.?0+$/, "");
}

/** Parse a percentage like "18" or "2.5" into basis points (1800, 250). */
export function parsePercentToBp(input: string | number): number {
  return parseDecimal(input, 2);
}

/** qty (milli) × unit price (minor) → line amount (minor), rounded half-up. */
export function lineAmount(qtyMilli: number, unitPriceMinor: number): number {
  return toSafeNumber(divRound(BigInt(qtyMilli) * BigInt(unitPriceMinor), BigInt(QTY_SCALE)));
}

/** amount × basisPoints / 10000, rounded half-up. */
export function applyBp(amountMinor: number, bp: number): number {
  return toSafeNumber(divRound(BigInt(amountMinor) * BigInt(bp), 10000n));
}

/** amount × basisPoints / (10000 × divisor), rounded half-up — e.g. half-rate GST components. */
export function applyBpFraction(amountMinor: number, bp: number, divisor: number): number {
  return toSafeNumber(divRound(BigInt(amountMinor) * BigInt(bp), 10000n * BigInt(divisor)));
}

/**
 * Convert an amount in a foreign currency to base currency.
 * rateScaled = base units per 1 foreign unit × 1e9. Handles differing minor-unit exponents.
 */
export function convertToBase(
  amountFcMinor: number,
  rateScaled: number,
  fcExponent: number,
  baseExponent: number,
): number {
  let num = BigInt(amountFcMinor) * BigInt(rateScaled);
  let den = RATE_SCALE;
  const diff = baseExponent - fcExponent;
  if (diff > 0) num *= 10n ** BigInt(diff);
  else if (diff < 0) den *= 10n ** BigInt(-diff);
  return toSafeNumber(divRound(num, den));
}

/** Sum integer amounts exactly (throws on unsafe overflow). */
export function sum(values: number[]): number {
  let t = 0n;
  for (const v of values) t += BigInt(v);
  return toSafeNumber(t);
}

/** Round an amount to the nearest whole currency unit (e.g. invoice round-off to ₹1). */
export function roundToWhole(amountMinor: number, exponent: number): number {
  if (exponent === 0) return amountMinor;
  const unit = 10n ** BigInt(exponent);
  return toSafeNumber(divRound(BigInt(amountMinor), unit) * unit);
}

/**
 * Split an amount across weights with the largest-remainder method so that parts sum exactly to the total.
 */
export function allocateProportionally(total: number, weights: number[]): number[] {
  const wsum = weights.reduce((a, b) => a + BigInt(b), 0n);
  if (wsum === 0n) return weights.map(() => 0);
  const T = BigInt(total);
  const raw = weights.map((w) => (T * BigInt(w)));
  const floors = raw.map((r) => r / wsum);
  let remainder = T - floors.reduce((a, b) => a + b, 0n);
  const order = raw
    .map((r, i) => ({ i, rem: r % wsum }))
    .sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
  const out = floors.slice();
  for (const o of order) {
    if (remainder <= 0n) break;
    out[o.i] += 1n;
    remainder -= 1n;
  }
  return out.map(toSafeNumber);
}
