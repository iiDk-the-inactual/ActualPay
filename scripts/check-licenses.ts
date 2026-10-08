/**
 * Fails if any production dependency (anything that ships inside ActualPay's
 * containers) uses a license outside the allowlist. Development-only tools
 * are not redistributed and are not checked.
 *
 * Usage: npm run licenses:check
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Permissive licenses compatible with distributing an MIT-licensed project. */
const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'CC-BY-4.0',
]);

function licenseOf(dir: string): string | undefined {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    license?: string | { type?: string };
    licenses?: { type?: string }[];
  };
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  return pkg.licenses
    ?.map((l) => l.type)
    .filter(Boolean)
    .join(' OR ');
}

/** Accept SPDX expressions where every OR-branch alternative includes an allowed license. */
function isAllowed(expression: string): boolean {
  const cleaned = expression.replace(/[()]/g, '').trim();
  return cleaned
    .split(/\s+OR\s+/i)
    .some((branch) => branch.split(/\s+AND\s+/i).every((id) => ALLOWED.has(id.trim())));
}

const output = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
  encoding: 'utf8',
});
const dirs = [...new Set(output.split('\n').filter((line) => line.includes('node_modules')))];

const problems: string[] = [];
const seen = new Map<string, string>();
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    private?: boolean;
  };
  if (pkg.name.startsWith('@actualpay/')) continue;
  const license = licenseOf(dir) ?? 'UNKNOWN';
  seen.set(`${pkg.name}@${pkg.version}`, license);
  if (!isAllowed(license)) problems.push(`${pkg.name}@${pkg.version}: ${license}`);
}

console.log(`Checked ${seen.size} production packages.`);
if (problems.length > 0) {
  console.error(`Disallowed or unknown licenses:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('All production dependency licenses are allowed.');
