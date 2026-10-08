/**
 * JSON parsing that never turns numbers into floats.
 *
 * Node RPCs (bitcoind, litecoind) return amounts as JSON numbers such as
 * 0.10000001. `JSON.parse` would round-trip them through IEEE-754 doubles.
 * This parser uses the reviver's `context.source` (JSON.parse source text
 * access, available in Node 22) to keep every number as its exact source
 * string; callers convert with `parseAmount`/`BigInt`.
 */
type ReviverWithSource = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { source?: string },
) => unknown;

const reviver: ReviverWithSource = (_key, value, context) =>
  typeof value === 'number' ? (context?.source ?? String(value)) : value;

/** Fail at startup, not at the first payment, if the runtime lacks the feature. */
function assertSupported(): void {
  const probe = JSON.parse(
    '{"n":0.10000000000000000001}',
    reviver as Parameters<typeof JSON.parse>[1],
  ) as { n: unknown };
  if (probe.n !== '0.10000000000000000001') {
    throw new Error(
      'This Node.js runtime lacks JSON.parse source text access; Node.js 22 or newer is required.',
    );
  }
}
assertSupported();

export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, reviver as Parameters<typeof JSON.parse>[1]);
}
