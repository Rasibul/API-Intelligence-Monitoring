import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Redis } from 'ioredis';
import { createRedisManager, redisOptions } from '../app/config/redis.js';
import { captureLogs, testConfig, until } from './support/env.js';
import { startFakeRedis } from './support/fakeRedis.js';

const signal = () => new AbortController().signal;

function manage(context: TestContext, url: string, overrides = {}) {
  let client: Redis | undefined;
  const manager = createRedisManager(
    testConfig({
      REDIS_URL: url,
      REDIS_CONNECT_TIMEOUT_MS: '500',
      REDIS_RECONNECT_MAX_DELAY_MS: '100',
      STARTUP_MAX_ATTEMPTS: '2',
      ...overrides,
    }),
    (target, options) => (client = new Redis(target, options)),
  );
  context.after(() => manager.close().catch(() => undefined));
  return { manager, client: client! };
}

test('client options are bounded, unbuffered and reconnect only when allowed', () => {
  let allowed = false;
  const options = redisOptions(
    testConfig({
      REDIS_CONNECT_TIMEOUT_MS: '1234',
      REDIS_RECONNECT_MAX_DELAY_MS: '900',
    }),
    () => allowed,
  );
  assert.equal(options.connectTimeout, 1234);
  assert.equal(options.lazyConnect, true);
  assert.equal(options.enableOfflineQueue, false);
  assert.equal(options.maxRetriesPerRequest, 0);
  assert.equal(options.autoResendUnfulfilledCommands, false);
  assert.equal(options.retryStrategy!(1), null);
  allowed = true;
  for (const attempt of [1, 5, 1_000]) {
    const delay = options.retryStrategy!(attempt);
    assert.ok(typeof delay === 'number' && delay > 0 && delay <= 900);
  }
});

test('connects with credentials, checks and closes without leaking sockets', async (context) => {
  const logs = captureLogs(context);
  const server = await startFakeRedis('seeded-pass');
  context.after(() => server.stop());
  const { manager } = manage(
    context,
    `redis://:seeded-pass@127.0.0.1:${server.port}`,
  );
  assert.equal(await manager.check(500), false);
  await manager.connect(signal());
  assert.equal(await manager.check(500), true);
  assert.equal(server.sockets.size, 1);
  await manager.close();
  await manager.close();
  assert.ok(server.commands.includes('QUIT'));
  assert.equal(await manager.check(500), false);
  await until(() => server.sockets.size === 0);
  assert.deepEqual(
    logs.events().map((entry) => entry.event),
    ['dependency_connected'],
  );
  assert.ok(!logs.lines.join('').includes('seeded'));
});

test('an unreachable server fails within bounded attempts and leaks nothing', async (context) => {
  const logs = captureLogs(context);
  const { manager, client } = manage(
    context,
    'redis://seeded-user:seeded-pass@127.0.0.1:1',
  );
  const started = Date.now();
  await assert.rejects(manager.connect(signal()), {
    name: 'DependencyError',
    kind: 'dependency_unreachable',
    message: 'redis: dependency_unreachable',
  });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(logs.events().length, 2);
  assert.ok(!/seeded|127\.0\.0\.1/.test(logs.lines.join('')));
  // No background reconnection survives a failed startup.
  assert.equal(client.status, 'end');
});

test('startup recovers when the server appears between attempts', async (context) => {
  captureLogs(context);
  const server = await startFakeRedis();
  context.after(() => server.stop());
  await server.stop();
  const { manager } = manage(context, `redis://127.0.0.1:${server.port}`, {
    STARTUP_MAX_ATTEMPTS: '5',
  });
  const connecting = manager.connect(signal());
  await new Promise((resolve) => setTimeout(resolve, 50));
  await server.start();
  await connecting;
  assert.equal(await manager.check(500), true);
});

for (const [label, url] of [
  ['rejected', 'redis://:seeded-wrong@127.0.0.1'],
  ['missing', 'redis://127.0.0.1'],
] as const)
  test(`${label} credentials are permanent and sanitized`, async (context) => {
    const logs = captureLogs(context);
    const server = await startFakeRedis('seeded-pass');
    context.after(() => server.stop());
    const { manager } = manage(context, `${url}:${server.port}`);
    await assert.rejects(manager.connect(signal()), {
      kind: 'dependency_authentication',
    });
    assert.equal(logs.events().length, 1);
    assert.ok(!logs.lines.join('').includes('seeded'));
  });

test('outage fails commands immediately, recovers, and is logged once each', async (context) => {
  const logs = captureLogs(context);
  const server = await startFakeRedis();
  context.after(() => server.stop());
  const { manager, client } = manage(
    context,
    `redis://127.0.0.1:${server.port}`,
  );
  await manager.connect(signal());
  await server.stop();
  await until(() => client.status === 'reconnecting');
  assert.equal(await manager.check(500), false);
  // Commands are rejected rather than queued for later.
  const started = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: 100 }, () => client.ping()),
  );
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.ok(Date.now() - started < 500);
  // Let several reconnect attempts fail.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await server.start();
  await until(() => client.status === 'ready');
  assert.equal(await manager.check(500), true);
  assert.deepEqual(
    logs.events().map((entry) => entry.event),
    [
      'dependency_connected',
      'dependency_unavailable',
      'dependency_reconnecting',
      'dependency_reconnected',
    ],
  );
});

test('an unresponsive server cannot stall a check', async (context) => {
  captureLogs(context);
  const server = await startFakeRedis();
  context.after(() => server.stop());
  const { manager } = manage(context, `redis://127.0.0.1:${server.port}`);
  await manager.connect(signal());
  server.responsive = false;
  const started = Date.now();
  await assert.rejects(manager.check(100), { kind: 'dependency_timeout' });
  assert.ok(Date.now() - started < 1_000);
});

test('a close that cannot complete is reported and still releases the socket', async (context) => {
  captureLogs(context);
  const server = await startFakeRedis();
  context.after(() => server.stop());
  const { manager } = manage(context, `redis://127.0.0.1:${server.port}`);
  await manager.connect(signal());
  server.responsive = false;
  await assert.rejects(manager.close(), { name: 'DependencyError' });
  await until(() => server.sockets.size === 0);
});

test('closing during an outage ends reconnection without an error', async (context) => {
  captureLogs(context);
  const server = await startFakeRedis();
  const { manager, client } = manage(
    context,
    `redis://127.0.0.1:${server.port}`,
  );
  await manager.connect(signal());
  await server.stop();
  await until(() => client.status === 'reconnecting');
  await manager.close();
  assert.equal(client.status, 'end');
});

test('closing before or during connect is safe', async (context) => {
  captureLogs(context);
  await manage(context, 'redis://127.0.0.1:1').manager.close();

  const server = await startFakeRedis();
  context.after(() => server.stop());
  server.responsive = false;
  const { manager, client } = manage(
    context,
    `redis://127.0.0.1:${server.port}`,
  );
  const controller = new AbortController();
  const connecting = manager.connect(controller.signal);
  connecting.catch(() => undefined);
  await until(() => server.sockets.size > 0);
  controller.abort();
  await assert.rejects(connecting, { kind: 'dependency_cancelled' });
  await manager.close();
  assert.equal(client.status, 'end');
  await until(() => server.sockets.size === 0);
});
