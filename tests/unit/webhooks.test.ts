import { describe, expect, it } from 'vitest';
import {
  computeSignature,
  isForbiddenAddress,
  signatureHeader,
  validateWebhookUrl,
  verifySignature,
} from '@actualpay/webhooks';

const STRICT = { allowHttp: false, allowPrivateNetworks: false };

describe('forbidden destination addresses', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '0.0.0.0',
    '0.1.2.3',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.2.1',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::1',
    '2001:db8::1',
  ])('refuses %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '169.253.1.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
  ])('allows %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(false);
  });

  it('refuses anything that is not an IP address', () => {
    expect(isForbiddenAddress('example.com')).toBe(true);
    expect(isForbiddenAddress('')).toBe(true);
    expect(isForbiddenAddress('999.1.1.1')).toBe(true);
  });
});

describe('webhook URL validation', () => {
  it('accepts a public https URL', () => {
    expect(validateWebhookUrl('https://hooks.example.com/actualpay?x=1', STRICT).hostname).toBe(
      'hooks.example.com',
    );
  });

  it.each([
    'http://hooks.example.com/x', // plain http
    'ftp://hooks.example.com/x',
    'https://user:pass@hooks.example.com/x', // credentials
    'https://hooks.example.com/x#frag',
    'not a url',
    'https://localhost/x',
    'https://app.localhost/x',
    'https://printer.local/x',
    'https://db.internal/x',
    'https://singlelabel/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://169.254.169.254/latest/meta-data',
    'https://10.1.2.3:8443/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://0x7f000001/x', // WHATWG normalises to 127.0.0.1
    'https://2130706433/x', // decimal form of 127.0.0.1
  ])('rejects %s', (url) => {
    expect(() => validateWebhookUrl(url, STRICT)).toThrow();
  });

  it('allows development destinations only when explicitly enabled', () => {
    const dev = { allowHttp: true, allowPrivateNetworks: true };
    expect(validateWebhookUrl('http://127.0.0.1:9000/hook', dev).port).toBe('9000');
    expect(() => validateWebhookUrl('http://127.0.0.1:9000/hook', STRICT)).toThrow();
    // http still needs allowHttp even for a private host
    expect(() =>
      validateWebhookUrl('http://127.0.0.1:9000/hook', {
        allowHttp: false,
        allowPrivateNetworks: true,
      }),
    ).toThrow();
  });
});

describe('signatures', () => {
  const secret = 'whsec_test_secret';
  const body = '{"id":"evt_1","type":"invoice.paid"}';
  const now = 1_800_000_000;

  it('verifies a correct signature and rejects tampering, wrong secrets and replays', () => {
    const header = signatureHeader([secret], now, body);
    expect(verifySignature({ header, body, secret, nowSeconds: now })).toBe(true);
    expect(verifySignature({ header, body: body + ' ', secret, nowSeconds: now })).toBe(false);
    expect(verifySignature({ header, body, secret: 'whsec_other', nowSeconds: now })).toBe(false);
    expect(verifySignature({ header, body, secret, nowSeconds: now + 301 })).toBe(false);
    expect(verifySignature({ header, body, secret, nowSeconds: now - 301 })).toBe(false);
    expect(verifySignature({ header, body, secret, nowSeconds: now + 299 })).toBe(true);
  });

  it('rejects malformed headers', () => {
    for (const header of [
      '',
      'v1=abc',
      `t=${now}`,
      `t=abc,v1=00`,
      `t=${now},v1=zz`,
      `t=${now},v1=`,
    ])
      expect(verifySignature({ header, body, secret, nowSeconds: now })).toBe(false);
  });

  it('carries one signature per active secret during a rotation', () => {
    const header = signatureHeader(['whsec_new', 'whsec_old'], now, body);
    expect(header.match(/v1=/g)).toHaveLength(2);
    expect(verifySignature({ header, body, secret: 'whsec_old', nowSeconds: now })).toBe(true);
    expect(verifySignature({ header, body, secret: 'whsec_new', nowSeconds: now })).toBe(true);
  });

  it('binds the timestamp into the signature', () => {
    expect(computeSignature(secret, now, body)).not.toBe(computeSignature(secret, now + 1, body));
  });
});
