import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Environment } from './config/env.js';
import { errorHandler } from './middlewares/error.middleware.js';
import { notFound } from './middlewares/notFound.middleware.js';
import type { ReadinessAccess } from './modules/health/health.route.js';
import { createRoutes } from './routes/index.js';
import { AppError } from './utils/AppError.js';

export function createApp(
  config: Pick<Environment, 'CORS_ORIGIN'>,
  access?: ReadinessAccess,
) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);
  app.set('query parser', 'simple');
  app.use((request, response, next) => {
    response.locals.requestId = randomUUID();
    response.setHeader('X-Request-Id', response.locals.requestId as string);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'",
    );
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.vary('Origin');
    const origin = request.get('Origin');
    if (origin !== undefined) {
      if (!config.CORS_ORIGIN.includes(origin)) {
        next(new AppError(403, 'ORIGIN_DENIED', 'Origin is not allowed'));
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
      // Credentials are deferred until reviewed authentication is implemented.
      response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
      if (request.method === 'OPTIONS') {
        response.sendStatus(204);
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: '256kb', strict: true, inflate: false }));
  // No form endpoints exist yet, so URL-encoded parsing is intentionally absent.
  app.use(createRoutes(access));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
