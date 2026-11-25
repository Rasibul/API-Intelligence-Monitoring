import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AppError } from '../utils/AppError.js';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Read-only operator/watchdog credential from the architecture contract. It is
 * the application half of the control; network restriction belongs to the
 * reverse proxy or firewall because proxy trust is disabled here.
 */
export function watchdogAuth(token: string): RequestHandler {
  const expected = digest(token);
  return (request, response, next) => {
    const presented = /^Bearer ([^\s]+)$/i.exec(
      request.get('Authorization') ?? '',
    )?.[1];
    // Comparing fixed-length digests keeps timing independent of the input.
    if (
      presented === undefined ||
      !timingSafeEqual(digest(presented), expected)
    ) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      next(new AppError(401, 'UNAUTHORIZED', 'Valid credentials are required'));
      return;
    }
    next();
  };
}
