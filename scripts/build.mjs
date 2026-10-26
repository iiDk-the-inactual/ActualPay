/**
 * Production build: bundles each entry point (and every workspace package it
 * uses) into one plain ESM file under dist/, leaving third-party packages
 * external so the image installs them from the lockfile with `npm ci --omit=dev`.
 * No TypeScript loader runs in production.
 *
 *   npm run build
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Map every workspace package name to its source entry so it is bundled, not external.
const alias = {};
for (const dir of ['packages', 'apps']) {
  for (const name of readdirSync(join(root, dir))) {
    const manifest = join(root, dir, name, 'package.json');
    if (!statSync(join(root, dir, name)).isDirectory()) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      continue;
    }
    const entry = pkg.exports?.['.'];
    if (pkg.name?.startsWith('@actualpay/') && typeof entry === 'string')
      alias[pkg.name] = join(root, dir, name, entry);
  }
}

const entries = {
  api: 'apps/api/src/server.ts',
  worker: 'apps/worker/src/main.ts',
  signer: 'apps/signer/src/main.ts',
  db: 'packages/database/src/cli.ts',
  'admin-create': 'apps/api/src/cli/admin-create.ts',
};

await build({
  entryPoints: Object.fromEntries(
    Object.entries(entries).map(([out, file]) => [out, join(root, file)]),
  ),
  outdir: dist,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  packages: 'external',
  alias,
  logLevel: 'info',
  // `import.meta.url`-relative file reads (the static web files) are resolved at run time.
  legalComments: 'none',
});

// Static dashboard and checkout pages travel next to the bundles.
cpSync(join(root, 'apps/web/public'), join(dist, 'web'), { recursive: true });
process.stdout.write(`built ${Object.keys(entries).join(', ')} into dist/\n`);
