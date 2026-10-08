/**
 * The single place that turns errors into HTTP responses.
 *
 * Clients receive `{ error: { code, message, requestId, details? } }`.
 * Unexpected errors become a generic INTERNAL error; their details (stack,
 * SQL, cause) go to the server log only. In development the original message
 * is included to speed up debugging.
 */
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, isAppError, type ErrorCode } from '@actualpay/shared';

export interface ErrorBody {
  error: { code: ErrorCode; message: string; requestId: string; details?: Record<string, unknown> };
}

function fromFastifyError(error: FastifyError): AppError | undefined {
  switch (error.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new AppError('PAYLOAD_TOO_LARGE', 'The request body is too large.');
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new AppError(
        'UNSUPPORTED_MEDIA_TYPE',
        'Requests with a body must use Content-Type: application/json.',
      );
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return AppError.validation('The request body is invalid.');
    default:
      break;
  }
  // JSON syntax errors and prototype-poisoning rejections from secure-json-parse.
  if (error.statusCode === 400) return AppError.validation('The request body is not valid JSON.');
  return undefined;
}

export function zodToAppError(error: ZodError, location: 'body' | 'query' | 'params'): AppError {
  return AppError.validation(`Invalid request ${location}.`, {
    issues: error.issues
      .slice(0, 20)
      .map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  });
}

export function registerErrorHandling(app: FastifyInstance, exposeInternalMessages: boolean): void {
  app.setErrorHandler((error: FastifyError | AppError | ZodError | Error, request, reply) => {
    let appError: AppError;
    if (isAppError(error)) {
      appError = error;
    } else if (error instanceof ZodError) {
      appError = zodToAppError(error, 'body');
    } else {
      const mapped =
        'code' in error && typeof error.code === 'string' ? fromFastifyError(error) : undefined;
      appError =
        mapped ??
        new AppError(
          'INTERNAL',
          exposeInternalMessages
            ? `Internal error: ${error.message}`
            : 'An unexpected error occurred.',
        );
    }

    if (appError.httpStatus >= 500) {
      request.log.error({ err: error }, 'request failed');
    } else {
      request.log.info({ code: appError.code }, 'request rejected');
    }

    const body: ErrorBody = {
      error: { code: appError.code, message: appError.message, requestId: request.id },
    };
    if (appError.details) body.error.details = { ...appError.details };
    return reply.status(appError.httpStatus).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: request.id },
    };
    return reply.status(404).send(body);
  });
}
