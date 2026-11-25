import type { RequestHandler } from 'express';
import type { Readiness } from './readiness.service.js';

export const health: RequestHandler = (_request, response) => {
  response.json({
    data: { status: 'ok' },
    meta: {
      requestId: response.locals.requestId,
      asOf: new Date().toISOString(),
    },
  });
};

export const live: RequestHandler = (_request, response) => {
  response.json({ status: 'alive' });
};

export function ready(readiness: Readiness): RequestHandler {
  return async (_request, response) => {
    const report = await readiness.check();
    if (!report.ready) response.setHeader('Retry-After', '5');
    response.status(report.ready ? 200 : 503).json({
      data: {
        status: report.ready ? 'ready' : 'not_ready',
        dependencies: report.dependencies,
      },
      meta: {
        requestId: response.locals.requestId,
        asOf: report.checkedAt.toISOString(),
      },
    });
  };
}
