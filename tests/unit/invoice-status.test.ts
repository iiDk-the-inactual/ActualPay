import { describe, expect, it } from 'vitest';
import { deriveInvoiceStatus, paymentUri, type InvoiceFacts } from '@actualpay/payments';

const T0 = new Date('2026-01-01T00:00:00Z');
const before = new Date('2026-01-01T00:30:00Z');
const after = new Date('2026-01-01T02:00:00Z');
const base: InvoiceFacts = {
  amountDue: 100n,
  confirmed: 0n,
  pending: 0n,
  expiresAt: new Date('2026-01-01T01:00:00Z'),
  cancelledAt: null,
  now: before,
};

describe('invoice status', () => {
  it.each([
    ['nothing received', {}, 'open'],
    ['unconfirmed payment', { pending: 100n }, 'processing'],
    ['partial pending on top of partial confirmed', { confirmed: 40n, pending: 10n }, 'processing'],
    ['partial confirmed', { confirmed: 40n }, 'partially_paid'],
    ['exactly paid', { confirmed: 100n }, 'paid'],
    ['overpaid', { confirmed: 250n }, 'paid'],
    ['expired with nothing', { now: after }, 'expired'],
    ['expired but payment in flight', { now: after, pending: 100n }, 'processing'],
    ['expired with partial confirmed', { now: after, confirmed: 40n }, 'expired'],
    ['paid after expiry', { now: after, confirmed: 100n }, 'paid'],
    ['cancelled', { cancelledAt: T0 }, 'cancelled'],
    ['cancelled then paid anyway', { cancelledAt: T0, confirmed: 100n }, 'paid'],
    ['cancelled, late money still unconfirmed', { cancelledAt: T0, pending: 5n }, 'cancelled'],
    ['reaches the exact expiry instant', { now: new Date('2026-01-01T01:00:00Z') }, 'expired'],
  ] as const)('%s → %s', (_name, patch, expected) => {
    expect(deriveInvoiceStatus({ ...base, ...patch })).toBe(expected);
  });

  it('is a pure function of its facts', () => {
    const facts = { ...base, confirmed: 40n };
    expect(deriveInvoiceStatus(facts)).toBe(deriveInvoiceStatus({ ...facts }));
  });
});

describe('payment URIs', () => {
  it('formats BIP21 amounts exactly, without floating point', () => {
    expect(paymentUri({ assetId: 'btc', address: 'bc1qxyz', amount: 150_000n })).toBe(
      'bitcoin:bc1qxyz?amount=0.0015',
    );
    expect(paymentUri({ assetId: 'btc', address: 'bc1qxyz', amount: 1n })).toBe(
      'bitcoin:bc1qxyz?amount=0.00000001',
    );
    expect(paymentUri({ assetId: 'ltc', address: 'ltc1qxyz', amount: 100_000_000n })).toBe(
      'litecoin:ltc1qxyz?amount=1',
    );
  });

  it('uses wei for Ethereum and omits URIs where no standard is reliable', () => {
    expect(paymentUri({ assetId: 'eth', address: '0xabc', amount: 10n ** 18n })).toBe(
      'ethereum:0xabc?value=1000000000000000000',
    );
    for (const assetId of ['usdt-erc20', 'trx', 'usdt-trc20', 'xrp'])
      expect(paymentUri({ assetId, address: 'x', amount: 5n })).toBeNull();
  });
});
