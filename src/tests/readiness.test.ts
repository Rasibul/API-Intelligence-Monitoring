import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app/app.js';
import { createReadiness } from '../app/modules/health/readiness.service.js';
import { captureLogs, testConfig, testToken } from './support/env.js';
import { fakeDependency } from './support/fakeDependency.js';
import { withServer } from './support/http.js';

const serving = () => true;

test('readiness follows each dependency through outage and recovery', async () => {
  const mongodb = fakeDependency('mongodb');
  const redis = fakeDependency('redis');
  const readiness = createReadiness([mongodb, redis], serving, { cacheMs: 0 });
  assert.equal((await readiness.check()).ready, true);

  redis.behavior.check = async () => {
    throw new Error('seeded-secret');
  };
  const degraded = await readiness.check();
  assert.equal(degraded.ready, false);
  assert.deepEqual(degraded.dependencies, {
    mongodb: 'available',
    redis: 'unavailable',
  });

  redis.behavior.check = async () => true;
  mongodb.behavior.check = async () => false;
  assert.equal((await readiness.check()).dependencies.mongodb, 'unavailable');

  mongodb.behavior.check = async () => true;
  assert.equal((await readiness.check()).ready, true);
});

test('a stalled dependency is bounded by the deadline', async () => {
  const stalled = fakeDependency('mongodb', {
    check: () => new Promise(() => undefined),
  });
  const readiness = createReadiness([stalled], serving, { deadlineMs: 50 });
  const started = Date.now();
  assert.equal((await readiness.check()).ready, false);
  assert.ok(Date.now() - started < 1_000);
});

test('concurrent and repeated probes are coalesced and cached briefly', async () => {
  let time = 0;
  const mongodb = fakeDependency('mongodb');
  const readiness = createReadiness([mongodb], serving, {
    cacheMs: 1_000,
    now: () => time,
  });
  await Promise.all(Array.from({ length: 50 }, () => readiness.check()));
  assert.equal(mongodb.checks, 1);
  time = 999;
  await readiness.check();
  assert.equal(mongodb.checks, 1);
  time = 1_000;
  await readiness.check();
  assert.equal(mongodb.checks, 2);
});

test('shutdown makes readiness false even while a healthy result is cached', async () => {
  let running = true;
  const readiness = createReadiness(
    [fakeDependency('mongodb')],
    () => running,
    { cacheMs: 60_000 },
  );
  assert.equal((await readiness.check()).ready, true);
  running = false;
  assert.equal((await readiness.check()).ready, false);
});

test('GET /ready requires the watchdog credential and runs no check without it', async (context) => {
  captureLogs(context);
  const mongodb = fakeDependency('mongodb');
  const app = createApp(testConfig(), {
    readiness: createReadiness([mongodb], serving),
    watchdogToken: testToken,
  });
  await withServer(app, async (origin) => {
    for (const authorization of [
      undefined,
      'Bearer',
      `Bearer ${testToken}x`,
      `Bearer ${testToken.slice(0, -1)}`,
      `Basic ${testToken}`,
      testToken,
    ]) {
      const response = await fetch(
        `${origin}/ready?token=${testToken}`,
        authorization ? { headers: { Authorization: authorization } } : {},
      );
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), 'Bearer');
      const body = await response.text();
      assert.equal(JSON.parse(body).error.code, 'UNAUTHORIZED');
      assert.ok(!body.includes('mongodb') && !body.includes(testToken));
    }
  });
  assert.equal(mongodb.checks, 0);
});

test('GET /ready returns 200 or 503 with dependency names and states only', async () => {
  const mongodb = fakeDependency('mongodb');
  const redis = fakeDependency('redis');
  const app = createApp(testConfig(), {
    readiness: createReadiness([mongodb, redis], serving, { cacheMs: 0 }),
    watchdogToken: testToken,
  });
  const headers = { Authorization: `Bearer ${testToken}` };
  await withServer(app, async (origin) => {
    const ready = await fetch(`${origin}/ready`, { headers });
    assert.equal(ready.status, 200);
    assert.equal(ready.headers.get('cache-control'), 'no-store');
    const body = await ready.json();
    assert.deepEqual(body.data, {
      status: 'ready',
      dependencies: { mongodb: 'available', redis: 'available' },
    });
    assert.equal(body.meta.requestId, ready.headers.get('x-request-id'));
    assert.equal(new Date(body.meta.asOf).toISOString(), body.meta.asOf);

    redis.behavior.check = async () => {
      throw new Error('redis://:seeded-secret@seeded-host');
    };
    const unavailable = await fetch(`${origin}/ready`, { headers });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get('retry-after'), '5');
    const text = await unavailable.text();
    assert.deepEqual(JSON.parse(text).data, {
      status: 'not_ready',
      dependencies: { mongodb: 'available', redis: 'unavailable' },
    });
    assert.ok(!text.includes('seeded'));

    // Liveness is independent of dependency readiness.
    assert.deepEqual(await (await fetch(`${origin}/live`)).json(), {
      status: 'alive',
    });
    assert.equal((await fetch(`${origin}/health`)).status, 200);
  });
});

test('GET /ready does not exist when no credential is configured', async () => {
  await withServer(createApp(testConfig()), async (origin) => {
    const response = await fetch(`${origin}/ready`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  });
});
