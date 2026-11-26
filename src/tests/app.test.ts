import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import type { Express } from 'express';
import { createApp } from '../app/app.js';
import { parseEnv } from '../app/config/env.js';
import { errorHandler } from '../app/middlewares/error.middleware.js';
import { AppError } from '../app/utils/AppError.js';
import { validEnv } from './support/env.js';

const config = parseEnv({ ...validEnv });

async function withServer(
  app: Express,
  run: (origin: string) => Promise<void>,
) {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}

test('health is dependency-free and follows the normative response envelope', async () => {
  await withServer(createApp(config), async (origin) => {
    const response = await fetch(`${origin}/health`, {
      headers: { 'X-Request-Id': 'untrusted' },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, { status: 'ok' });
    assert.match(body.meta.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(body.meta.requestId, response.headers.get('x-request-id'));
    assert.notEqual(body.meta.requestId, 'untrusted');
    assert.equal(new Date(body.meta.asOf).toISOString(), body.meta.asOf);
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await (await fetch(`${origin}/live`)).json(), {
      status: 'alive',
    });
  });
});

test('unknown routes return safe 404 envelopes without reflecting paths', async () => {
  await withServer(createApp(config), async (origin) => {
    const response = await fetch(`${origin}/missing?secret=seeded-secret`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.deepEqual(body.error, {
      code: 'NOT_FOUND',
      message: 'Resource not found',
      retryable: false,
    });
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.ok(!JSON.stringify(body).includes('seeded-secret'));
  });
});

test('exact CORS allowlist accepts configured origins and rejects lookalikes', async () => {
  await withServer(createApp(config), async (origin) => {
    const allowed = await fetch(`${origin}/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(
      allowed.headers.get('access-control-allow-origin'),
      'http://localhost:5173',
    );
    const denied = await fetch(`${origin}/health`, {
      headers: { Origin: 'http://localhost:5173.evil.example' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    const preflight = await fetch(`${origin}/health`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(preflight.status, 204);
  });
});

test('malformed, oversized and compressed JSON fail safely', async () => {
  await withServer(createApp(config), async (origin) => {
    for (const [body, extraHeaders, status, code] of [
      ['{"secret":"seeded-secret",', {}, 400, 'INVALID_JSON'],
      [
        JSON.stringify({ value: 'x'.repeat(262144) }),
        {},
        413,
        'BODY_TOO_LARGE',
      ],
      ['{}', { 'Content-Encoding': 'gzip' }, 415, 'UNSUPPORTED_ENCODING'],
    ] as const) {
      const response = await fetch(`${origin}/health`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body,
      });
      assert.equal(response.status, status);
      const json = await response.json();
      assert.equal(json.error.code, code);
      assert.equal(json.error.retryable, false);
      assert.ok(!JSON.stringify(json).includes('seeded-secret'));
    }
  });
});

test('async failures reach central middleware; internal details never reach clients or logs', async (context) => {
  const output: string[] = [];
  context.mock.method(console, 'error', (value: string) => output.push(value));
  const app = express();
  app.use((_request, response, next) => {
    response.locals.requestId = 'test-request';
    next();
  });
  app.get('/unexpected', async () => {
    throw new Error('password=seeded-secret');
  });
  app.get('/operational', () => {
    throw new AppError(409, 'CONFLICT', 'Resource was modified');
  });
  app.use(errorHandler);
  await withServer(app, async (origin) => {
    const failure = await fetch(`${origin}/unexpected`);
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
        retryable: false,
      },
      requestId: 'test-request',
    });
    const operational = await fetch(`${origin}/operational`);
    assert.equal(operational.status, 409);
    assert.equal((await operational.json()).error.code, 'CONFLICT');
  });
  assert.equal(output.length, 1);
  assert.ok(!output.join('').includes('seeded-secret'));
  assert.equal(JSON.parse(output[0]!).event, 'request_failed');
  assert.equal(JSON.parse(output[0]!).errorKind, 'unknown');
});

test('late response errors close the connection without leaking through the default logger', async (context) => {
  const output: unknown[] = [];
  context.mock.method(console, 'error', (value: unknown) => output.push(value));
  const app = express();
  app.set('env', 'production');
  app.get('/partial', (_request, response, next) => {
    response.locals.requestId = 'late-error-request';
    response.write('partial');
    next(new TypeError('password=seeded-late-secret'));
  });
  app.use(errorHandler);
  await withServer(app, async (origin) => {
    await assert.rejects(async () => {
      const response = await fetch(`${origin}/partial`);
      await response.text();
    });
    // Express's default logger runs on setImmediate; allow it to run if invoked.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  assert.equal(output.length, 1);
  assert.equal(typeof output[0], 'string');
  const entry = JSON.parse(output[0] as string);
  assert.equal(entry.errorKind, 'type_error');
  assert.equal(entry.requestId, 'late-error-request');
  assert.ok(!String(output[0]).includes('seeded-late-secret'));
});
