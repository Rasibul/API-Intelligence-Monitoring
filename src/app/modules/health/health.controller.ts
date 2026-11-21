import type { RequestHandler } from 'express';

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
