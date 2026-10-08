/**
 * The single error type that is allowed to cross a trust boundary.
 *
 * `message` is written for API clients and must never contain secrets,
 * SQL, stack traces or internal identifiers. Anything diagnostic goes in
 * `cause`, which is logged server-side only.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  CSRF_FAILED: 403,
  MFA_REQUIRED: 403,
  EMAIL_NOT_VERIFIED: 403,
  ORGANIZATION_SUSPENDED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  INSUFFICIENT_BALANCE: 422,
  INVALID_STATE_TRANSITION: 409,
  LEDGER_UNBALANCED: 500,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_CODES[code];
    this.details = options.details;
  }

  static validation(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('VALIDATION_FAILED', message, details ? { details } : {});
  }

  static notFound(resource: string): AppError {
    return new AppError('NOT_FOUND', `${resource} was not found.`);
  }

  static unauthenticated(message = 'Authentication is required.'): AppError {
    return new AppError('UNAUTHENTICATED', message);
  }

  static forbidden(message = 'You do not have permission to perform this action.'): AppError {
    return new AppError('FORBIDDEN', message);
  }

  static conflict(message: string): AppError {
    return new AppError('CONFLICT', message);
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
