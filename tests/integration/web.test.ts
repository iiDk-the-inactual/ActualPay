/** The dashboard and hosted checkout are served safely: strict CSP, no path traversal, no markup injection. */
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './api-helpers';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(async () => {
  await api.close();
  await api.db.destroy();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  api.app.inject({ method: 'GET', url, headers });

describe('static pages', () => {
  it('serves the dashboard and checkout with a strict content security policy', async () => {
    for (const url of ['/app/', '/app', '/pay/abc123', '/pay/link/abc123']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain('unsafe-inline');
      expect(csp).not.toContain('unsafe-eval');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('serves only allowlisted assets and nothing from the file system', async () => {
    for (const name of ['app.js', 'pay.js', 'lib.js', 'style.css'])
      expect((await get(`/app/assets/${name}`)).statusCode).toBe(200);
    for (const bad of [
      '/app/assets/..%2f..%2f..%2fpackage.json',
      '/app/assets/%2e%2e%2fpackage.json',
      '/app/assets/index.html',
      '/app/assets/nope.js',
      '/app/assets/app.js%00',
    ])
      expect([400, 404], bad).toContain((await get(bad)).statusCode);
  });

  it('answers conditional requests with 304', async () => {
    const first = await get('/app/assets/app.js');
    const etag = String(first.headers['etag']);
    expect((await get('/app/assets/app.js', { 'if-none-match': etag })).statusCode).toBe(304);
  });

  it('redirects the root to the dashboard', async () => {
    const res = await get('/');
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/app/');
  });
});

describe('web sources', () => {
  const dir = new URL('../../apps/web/public/', import.meta.url);
  const files = readdirSync(dir);

  it('never writes markup or evaluates strings', () => {
    const forbidden =
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|setTimeout\s*\(\s*['"`]|srcdoc/;
    for (const file of files.filter((f) => /\.(js|html)$/.test(f))) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      expect(forbidden.test(text), file).toBe(false);
    }
  });

  it('has no inline scripts, inline handlers or inline styles in its pages', () => {
    for (const file of files.filter((f) => f.endsWith('.html'))) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      expect(/<script(?![^>]*\bsrc=)/i.test(text), file).toBe(false);
      expect(/\son[a-z]+\s*=/i.test(text), file).toBe(false);
      expect(/\sstyle\s*=/i.test(text), file).toBe(false);
    }
  });

  it('loads nothing from other origins', () => {
    for (const file of files) {
      const text = readFileSync(new URL(file, dir), 'utf8');
      expect(/https?:\/\/(?!localhost)/.test(text), file).toBe(false);
    }
  });
});
