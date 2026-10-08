import { describe, expect, it } from 'vitest';
import {
  assertBalanced,
  balanceDelta,
  journalContentHash,
  validateJournalShape,
  type JournalInput,
  type LedgerAccount,
} from '@actualpay/ledger';

const account = (id: string, assetId: string): LedgerAccount => ({
  id,
  assetId,
  organizationId: null,
  type: 'custody',
  normalSide: 'debit',
  allowNegative: false,
  balance: 0n,
});

const base: JournalInput = {
  externalRef: 'test:1',
  kind: 'adjustment',
  organizationId: null,
  lines: [
    { accountId: 'a', direction: 'debit', amount: 5n },
    { accountId: 'b', direction: 'credit', amount: 5n },
  ],
};

describe('journal validation', () => {
  it('requires two or more strictly positive lines', () => {
    expect(() => {
      validateJournalShape({ ...base, lines: [base.lines[0]!] });
    }).toThrow();
    expect(() => {
      validateJournalShape({ ...base, lines: [{ ...base.lines[0]!, amount: 0n }, base.lines[1]!] });
    }).toThrow();
    expect(() => {
      validateJournalShape({
        ...base,
        lines: [{ ...base.lines[0]!, amount: -5n }, base.lines[1]!],
      });
    }).toThrow();
  });

  it('rejects malformed external references', () => {
    expect(() => {
      validateJournalShape({ ...base, externalRef: 'has space' });
    }).toThrow();
    expect(() => {
      validateJournalShape({ ...base, externalRef: '' });
    }).toThrow();
  });

  it('links reversals and reversal kind together', () => {
    expect(() => {
      validateJournalShape({ ...base, kind: 'reversal' });
    }).toThrow();
    expect(() => {
      validateJournalShape({ ...base, reversesJournalId: 'x' });
    }).toThrow();
  });

  it('checks balance per asset, not in aggregate', () => {
    const accounts = new Map([
      ['a', account('a', 'btc')],
      ['b', account('b', 'btc')],
      ['c', account('c', 'eth')],
    ]);
    expect(() => {
      assertBalanced(base.lines, accounts);
    }).not.toThrow();
    // 5 BTC debit vs 5 ETH credit sums to zero numerically but is unbalanced.
    expect(() => {
      assertBalanced(
        [
          { accountId: 'a', direction: 'debit', amount: 5n },
          { accountId: 'c', direction: 'credit', amount: 5n },
        ],
        accounts,
      );
    }).toThrow(/does not balance/);
  });
});

describe('journalContentHash', () => {
  it('ignores line order, description and metadata', () => {
    const reordered = {
      ...base,
      lines: [...base.lines].reverse(),
      description: 'x',
      metadata: { y: 1 },
    };
    expect(journalContentHash(reordered)).toBe(journalContentHash(base));
  });

  it('changes when money movement changes', () => {
    const changed = {
      ...base,
      lines: [
        { ...base.lines[0]!, amount: 6n },
        { ...base.lines[1]!, amount: 6n },
      ],
    };
    expect(journalContentHash(changed)).not.toBe(journalContentHash(base));
    expect(journalContentHash({ ...base, organizationId: 'org' })).not.toBe(
      journalContentHash(base),
    );
  });
});

describe('balanceDelta', () => {
  it('increases balance when direction matches the normal side', () => {
    expect(balanceDelta('debit', 'debit', 3n)).toBe(3n);
    expect(balanceDelta('debit', 'credit', 3n)).toBe(-3n);
    expect(balanceDelta('credit', 'credit', 3n)).toBe(3n);
  });
});
