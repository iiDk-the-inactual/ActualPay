/**
 * Exact monetary arithmetic.
 *
 * Every amount inside ActualPay is a `bigint` counted in the asset's smallest
 * indivisible unit (satoshis, litoshis, wei, sun, drops, or 10^-6 USDT).
 * JavaScript `number` is never used for money: it silently loses precision
 * above 2^53, and 1 ETH alone is 10^18 wei.
 *
 * Decimal strings only exist at the edges (API input/output, display).
 * Parsing is strict on purpose: we reject rather than round, because silently
 * rounding a customer-supplied amount is how ledgers drift.
 */
import { AppError } from './errors';

/** Upper bound on decimal places any supported asset uses (ETH: 18). */
export const MAX_DECIMALS = 18;

/**
 * Upper bound on any single amount, in base units. 10^40 is far beyond any
 * real supply (total ETH supply is ~1.2 * 10^26 wei) yet comfortably fits the
 * database's numeric(78,0). It exists to reject absurd input early.
 */
export const MAX_BASE_UNITS = 10n ** 40n;

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new RangeError(`Invalid asset decimals: ${decimals}`);
  }
}

/**
 * Convert a canonical decimal string (e.g. "100.25") to base units.
 *
 * Rejected: signs, exponents, whitespace, leading zeros ("01"), a bare ".",
 * more fractional digits than the asset supports, zero when `allowZero` is
 * false, and anything above MAX_BASE_UNITS.
 */
export function parseAmount(
  value: string,
  decimals: number,
  options: { allowZero?: boolean } = {},
): bigint {
  assertDecimals(decimals);
  if (typeof value !== 'string' || value.length === 0 || value.length > 80) {
    throw AppError.validation('Amount must be a non-empty decimal string.');
  }
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) {
    throw AppError.validation('Amount must be a plain positive decimal string, e.g. "12.5".');
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    throw AppError.validation(`Amount has more than ${decimals} decimal places for this asset.`);
  }
  const units = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (units === 0n && options.allowZero !== true) {
    throw AppError.validation('Amount must be greater than zero.');
  }
  if (units > MAX_BASE_UNITS) {
    throw AppError.validation('Amount is too large.');
  }
  return units;
}

/**
 * Convert base units to a canonical decimal string with trailing fractional
 * zeros removed ("1.5", never "1.500000"). Negative values are supported so
 * that ledger reports can show signed movements.
 */
export function formatAmount(units: bigint, decimals: number): string {
  assertDecimals(decimals);
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const digits = abs.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const text = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${text}` : text;
}

/**
 * Parse a base-unit integer coming from the database or an RPC response.
 * Accepts bigint, decimal-integer strings, and safe integers only.
 */
export function toBaseUnits(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(`Value is not an exact integer amount: ${String(value)}`);
}

/** Throw unless `units` is strictly positive. */
export function assertPositive(units: bigint, label = 'amount'): void {
  if (units <= 0n) {
    throw AppError.validation(`${label} must be greater than zero.`);
  }
}

/**
 * Multiply by a rate expressed in basis points (1 bp = 0.01%), rounding DOWN.
 * Rounding direction is a policy decision: fees computed with this helper
 * never exceed the stated rate.
 */
export function applyBasisPoints(units: bigint, basisPoints: number): bigint {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new RangeError(`Invalid basis points: ${basisPoints}`);
  }
  return (units * BigInt(basisPoints)) / 10_000n;
}
