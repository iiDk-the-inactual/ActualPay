/**
 * OpenAPI 3.0 document generated from the route registry.
 *
 * Every route is declared once, with its Zod schemas, in `defineRoute`; this file
 * only translates. So the spec cannot drift from what the server validates, and
 * a test fails if the committed `docs/openapi.json` is stale.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';
import type { RegisteredRoute } from './http/route';

type Json = Record<string, unknown>;

function schemaOf(schema: ZodType): Json {
  const out = zodToJsonSchema(schema, {
    target: 'openApi3',
    $refStrategy: 'none',
    dateStrategy: 'format:date-time',
    pipeStrategy: 'output',
    effectStrategy: 'input',
  }) as Json;
  delete out['$schema'];
  return out;
}

function parametersOf(schema: ZodType | undefined, where: 'path' | 'query'): Json[] {
  if (!schema) return [];
  const json = schemaOf(schema);
  const properties = (json['properties'] ?? {}) as Record<string, Json>;
  const required = new Set((json['required'] ?? []) as string[]);
  return Object.entries(properties).map(([name, s]) => ({
    name,
    in: where,
    required: where === 'path' || required.has(name),
    schema: s,
  }));
}

const operationId = (r: RegisteredRoute): string =>
  `${r.method.toLowerCase()}_${r.url
    .replace(/^\/v1\//, '')
    .replace(/:([A-Za-z]+)/g, 'by_$1')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')}`;

const ERROR_REF = { $ref: '#/components/schemas/Error' };
const errorResponse = (description: string): Json => ({
  description,
  content: { 'application/json': { schema: ERROR_REF } },
});

export function buildOpenApi(
  routes: readonly RegisteredRoute[],
  info: { title: string; version: string; serverUrl: string },
): Json {
  // The registry grows every time an app is built; keep the latest of each route.
  const unique = new Map<string, RegisteredRoute>();
  for (const r of routes) unique.set(`${r.method} ${r.url}`, r);
  const sorted = [...unique.values()].sort(
    (a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method),
  );

  const paths: Record<string, Record<string, Json>> = {};
  for (const r of sorted) {
    const path = r.url.replace(/:([A-Za-z]+)/g, '{$1}');
    const notes: string[] = [];
    if (r.requireMfa) notes.push('Requires a session that completed two-factor authentication.');
    if (typeof r.org === 'string') notes.push(`Requires the \`${r.org}\` permission.`);
    if (r.rateLimit === 'auth') notes.push('Strictly rate limited (authentication limit).');
    if (r.auth === 'session') notes.push('Browser session only; API keys are not accepted.');

    const parameters = [
      ...parametersOf(r.schemas.params, 'path'),
      ...parametersOf(r.schemas.query, 'query'),
      ...(r.idempotency
        ? [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: r.idempotency === 'required',
              schema: {
                type: 'string',
                minLength: 1,
                maxLength: 255,
                pattern: '^[A-Za-z0-9_.:-]+$',
              },
              description: 'Repeating a request with the same key returns the original result.',
            },
          ]
        : []),
    ];

    const security =
      r.auth === 'public'
        ? []
        : r.auth === 'session'
          ? [{ cookieAuth: [] }]
          : [{ cookieAuth: [] }, { bearerAuth: [] }];

    const operation: Json = {
      operationId: operationId(r),
      summary: r.summary,
      ...(notes.length ? { description: notes.join(' ') } : {}),
      tags: [...r.tags],
      security,
      ...(parameters.length ? { parameters } : {}),
      ...(r.schemas.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: schemaOf(r.schemas.body) } },
            },
          }
        : {}),
      responses: {
        [String(r.successStatus)]:
          r.successStatus === 204
            ? { description: 'No content.' }
            : {
                description: 'Success.',
                content: { 'application/json': { schema: schemaOf(r.schemas.response) } },
              },
        '400': errorResponse('Invalid request.'),
        ...(r.auth !== 'public'
          ? { '401': errorResponse('Not signed in, or invalid API key.') }
          : {}),
        ...(r.auth !== 'public' ? { '403': errorResponse('Not allowed.') } : {}),
        ...(r.org !== undefined ? { '404': errorResponse('Not found (or not yours).') } : {}),
        '429': errorResponse('Rate limited.'),
      },
    };
    (paths[path] ??= {})[r.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: info.title,
      version: info.version,
      description:
        'ActualPay HTTP API. Authenticate integrations with an API key (`Authorization: Bearer apk_...`); ' +
        'the dashboard uses a session cookie plus an `X-CSRF-Token` header. Amounts are decimal strings; ' +
        'never floats. See docs/api.md.',
      license: { name: 'MIT' },
    },
    servers: [{ url: info.serverUrl }],
    tags: [...new Set(sorted.flatMap((r) => r.tags))].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API key (apk_live_… or apk_test_…).',
        },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'ap_session' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                requestId: { type: 'string' },
                details: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
      },
    },
  };
}
