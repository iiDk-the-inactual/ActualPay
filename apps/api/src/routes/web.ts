/**
 * Static dashboard and hosted checkout pages (apps/web/public).
 *
 * Served by the API process so the dashboard is same-origin with the API:
 * session cookies stay SameSite=Strict and no CORS is needed. Files come from an
 * explicit allowlist read at startup, so no request path ever reaches the file
 * system. The pages get their own strict Content-Security-Policy (scripts and
 * styles only from this origin, no inline code), and the JavaScript never writes
 * markup, so API data cannot turn into script.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * From source the files are at apps/web/public; the production bundle (scripts/build.mjs)
 * puts them in dist/web next to the entry point. Use whichever exists.
 */
const ROOT = [new URL('../../../web/public/', import.meta.url), new URL('./web/', import.meta.url)]
  .map((url) => fileURLToPath(url))
  .find((dir) => existsSync(`${dir}index.html`)) as string;

const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  'app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  'pay.js': { file: 'pay.js', type: 'text/javascript; charset=utf-8' },
  'lib.js': { file: 'lib.js', type: 'text/javascript; charset=utf-8' },
  'style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
};

export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

interface Loaded {
  readonly body: Buffer;
  readonly type: string;
  readonly etag: string;
}

function load(file: string, type: string): Loaded {
  const body = readFileSync(`${ROOT}${file}`);
  return { body, type, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"` };
}

export function registerWebRoutes(app: FastifyInstance): void {
  const index = load('index.html', 'text/html; charset=utf-8');
  const pay = load('pay.html', 'text/html; charset=utf-8');
  const assets = new Map(
    Object.entries(ASSETS).map(([name, a]) => [name, load(a.file, a.type)] as const),
  );

  const send = (
    reply: FastifyReply,
    ifNoneMatch: string | undefined,
    file: Loaded,
  ): FastifyReply => {
    reply
      .header('Content-Security-Policy', PAGE_CSP)
      .header('Cache-Control', 'no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .header('ETag', file.etag);
    if (ifNoneMatch === file.etag) return reply.code(304).send();
    return reply.type(file.type).send(file.body);
  };

  app.get('/', (_request, reply) => reply.redirect('/app/'));
  app.get('/app', (request, reply) => send(reply, request.headers['if-none-match'], index));
  app.get('/app/', (request, reply) => send(reply, request.headers['if-none-match'], index));
  app.get<{ Params: { name: string } }>('/app/assets/:name', (request, reply) => {
    const file = assets.get(request.params.name);
    if (!file) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    return send(reply, request.headers['if-none-match'], file);
  });
  app.get('/pay/:publicId', (request, reply) => send(reply, request.headers['if-none-match'], pay));
  app.get('/pay/link/:publicId', (request, reply) =>
    send(reply, request.headers['if-none-match'], pay),
  );
}
