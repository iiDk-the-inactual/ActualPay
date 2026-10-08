/**
 * Reads raw configuration values, supporting the `<NAME>_FILE` convention used
 * by Docker secrets and Kubernetes secret volumes: if `DATABASE_URL_FILE` is
 * set, the value is read from that file instead of the environment. Setting
 * both forms is rejected because it is ambiguous which one is in effect.
 * Returns only the requested keys, so nothing else from the process
 * environment leaks into configuration handling.
 *
 * This is the single seam to replace when integrating Vault or a cloud secret
 * manager: produce a flat string record and hand it to `loadConfig`.
 */
import { readFileSync } from 'node:fs';

export type RawEnv = Readonly<Record<string, string | undefined>>;

export function resolveFileSecrets(env: RawEnv, keys: readonly string[]): Record<string, string> {
  // Only known configuration keys are considered. Unrelated variables that
  // happen to end in _FILE (PIP_CONFIG_FILE, KUBECONFIG_FILE, ...) are ignored.
  const out: Record<string, string> = {};
  for (const target of keys) {
    const value = env[target];
    if (value !== undefined) out[target] = value;
  }
  for (const target of keys) {
    const key = `${target}_FILE`;
    const path = env[key];
    if (path === undefined || path === '') continue;
    if (env[target] !== undefined && env[target] !== '') {
      throw new Error(`Both ${target} and ${key} are set; use only one.`);
    }
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch (error) {
      // Do not include file contents; the path itself is not secret.
      throw new Error(`Could not read ${key} at ${path}`, { cause: error });
    }
    out[target] = contents.replace(/\r?\n$/, '');
  }
  return out;
}
