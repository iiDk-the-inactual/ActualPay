import { describe, expect, it } from 'vitest';
import { applyBasisPoints, formatAmount, parseAmount, toBaseUnits } from '@actualpay/shared';

describe('parseAmount', () => {
  it('converts decimal strings to exact base units', () => {
    expect(parseAmount('1', 8)).toBe(100_000_000n);
    expect(parseAmount('0.00000001', 8)).toBe(1n);
    expect(parseAmount('1.5', 6)).toBe(1_500_000n);
    expect(parseAmount('123456789.123456789123456789', 18)).toBe(123456789123456789123456789n);
  });

  it('handles values that would lose precision as JS numbers', () => {
    // 0.1 + 0.2 style errors must be impossible.
    expect(parseAmount('0.1', 18) + parseAmount('0.2', 18)).toBe(parseAmount('0.3', 18));
    expect(parseAmount('9007199254740993', 0)).toBe(9007199254740993n);
  });

  it.each([
    ['-1'],
    ['+1'],
    ['1e5'],
    [' 1'],
    ['1 '],
    ['01'],
    ['.5'],
    ['1.'],
    ['1,5'],
    ['0x10'],
    ['NaN'],
    ['Infinity'],
    [''],
  ])('rejects malformed input %j', (value) => {
    expect(() => parseAmount(value, 8)).toThrow();
  });

  it('rejects more precision than the asset supports instead of rounding', () => {
    expect(() => parseAmount('0.000000001', 8)).toThrow(/decimal places/);
    expect(() => parseAmount('1.0000001', 6)).toThrow();
  });

  it('rejects zero unless explicitly allowed', () => {
    expect(() => parseAmount('0', 8)).toThrow(/greater than zero/);
    expect(() => parseAmount('0.000', 8)).toThrow();
    expect(parseAmount('0', 8, { allowZero: true })).toBe(0n);
  });

  it('rejects absurdly large amounts', () => {
    expect(() => parseAmount('1' + '0'.repeat(41), 0)).toThrow(/too large/);
  });

  it('rejects non-string input at runtime', () => {
    expect(() => parseAmount(1.5 as unknown as string, 8)).toThrow();
  });
});

describe('formatAmount', () => {
  it('round-trips with parseAmount', () => {
    for (const [value, decimals] of [
      ['1', 8],
      ['0.00000001', 8],
      ['1.5', 6],
      ['42.000000000000000001', 18],
    ] as const) {
      expect(formatAmount(parseAmount(value, decimals), decimals)).toBe(value);
    }
  });

  it('trims trailing zeros and supports zero/negative values', () => {
    expect(formatAmount(150_000_000n, 8)).toBe('1.5');
    expect(formatAmount(0n, 8)).toBe('0');
    expect(formatAmount(-1n, 8)).toBe('-0.00000001');
    expect(formatAmount(5n, 0)).toBe('5');
  });
});

describe('toBaseUnits', () => {
  it('accepts exact integers only', () => {
    expect(toBaseUnits('123')).toBe(123n);
    expect(toBaseUnits(5n)).toBe(5n);
    expect(toBaseUnits(7)).toBe(7n);
    expect(() => toBaseUnits('1.5')).toThrow();
    expect(() => toBaseUnits(1.5)).toThrow();
    expect(() => toBaseUnits(2 ** 60)).toThrow();
  });
});

describe('applyBasisPoints', () => {
  it('rounds down so fees never exceed the stated rate', () => {
    expect(applyBasisPoints(10_000n, 100)).toBe(100n); // 1%
    expect(applyBasisPoints(99n, 100)).toBe(0n);
    expect(() => applyBasisPoints(1n, 10_001)).toThrow();
    expect(() => applyBasisPoints(1n, 0.5)).toThrow();
  });
});
