import type { ErrorRequestHandler } from 'express';
import { AppError } from '../utils/AppError.js';
import { classifyError, log } from '../utils/logger.js';

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  // Only recognize body-parser errors; never expose their message/body fields.
  if (error instanceof Error && 'type' in error) {
    switch (error.type) {
      case 'entity.too.large':
        return new AppError(413, 'BODY_TOO_LARGE', 'Request body is too large');
      case 'entity.parse.failed':
        return new AppError(400, 'INVALID_JSON', 'Malformed JSON body');
      case 'encoding.unsupported':
      case 'charset.unsupported':
        return new AppError(
          415,
          'UNSUPPORTED_ENCODING',
          'Unsupported body encoding',
        );
      case 'request.aborted':
      case 'request.size.invalid':
        return new AppError(400, 'INVALID_BODY', 'Invalid request body');
    }
  }
  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  // Express requires four parameters to recognize error middleware.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next,
) => {
  const safe = normalizeError(error);
  const requestId = response.locals.requestId as string;
  if (safe.statusCode >= 500 || response.headersSent)
    log('error', 'request_failed', {
      requestId,
      statusCode: safe.statusCode,
      errorKind: classifyError(error),
    });
  if (response.headersSent) {
    // A second response is impossible. Close without passing raw errors to
    // Express's default handler, which would print their contents to stderr.
    response.destroy();
    return;
  }
  response.setHeader('Cache-Control', 'no-store');
  response.status(safe.statusCode).json({
    error: {
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
    },
    requestId,
  });
};
