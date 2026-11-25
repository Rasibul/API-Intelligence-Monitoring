import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { testToken, until, validEnv } from './support/env.js';
import { startFakeMongo } from './support/fakeMongo.js';
import { startFakeRedis } from './support/fakeRedis.js';
import { freePort } from './support/http.js';

// Whole-process tests of the real entry point with the real drivers. Loopback
// protocol stand-ins replace the databases.
const credentials = 'seeded-user:seeded-pass';

async function launch(
  context: TestContext,
  mongoUri: string,
  redisPort: number,
) {
  const port = await freePort();
  const launcher =
    "import './src/app/server.ts'; process.once('message', () => { process.disconnect(); process.emit('SIGTERM'); }); process.channel.unref();";
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', launcher],
    {
      env: {
        ...process.env,
        ...validEnv,
        PORT: String(port),
        MONGODB_URI: mongoUri,
        MONGODB_CONNECT_TIMEOUT_MS: '500',
        MONGODB_SERVER_SELECTION_TIMEOUT_MS: '500',
        REDIS_URL: `redis://${credentials}@127.0.0.1:${redisPort}`,
        REDIS_CONNECT_TIMEOUT_MS: '500',
        REDIS_RECONNECT_MAX_DELAY_MS: '100',
        STARTUP_MAX_ATTEMPTS: '2',
        WATCHDOG_TOKEN: testToken,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  context.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const state = { output: '' };
  for (const stream of [child.stdout!, child.stderr!])
    stream.on('data', (chunk) => {
      state.output += String(chunk);
    });
  const closed = once(child, 'close').then(([code]) => code as number);
  return { child, closed, state, origin: `http://127.0.0.1:${port}` };
}

function assertNoLeak(output: string) {
  assert.ok(!/seeded|mongodb:\/\/|redis:\/\//.test(output), output);
  assert.ok(!output.includes(testToken));
  // No stack trace or raw exception reached the console.
  assert.ok(!/\n\s+at /.test(output), output);
}

test(
  'startup, readiness transitions, recovery and clean shutdown',
  { timeout: 60_000 },
  async (context) => {
    const mongo = await startFakeMongo();
    const redis = await startFakeRedis('seeded-pass');
    context.after(() => Promise.all([mongo.stop(), redis.stop()]));
    const app = await launch(context, mongo.uri, redis.port);
    await until(() => app.state.output.includes('server_started'), 20_000);

    const readiness = async () => {
      const response = await fetch(`${app.origin}/ready`, {
        headers: { Authorization: `Bearer ${testToken}` },
      });
      const body = (await response.json()) as {
        data: { dependencies: Record<string, string> };
      };
      return { status: response.status, ...body.data.dependencies };
    };
    const reaches = async (expected: object) => {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const actual = await readiness();
        try {
          assert.deepEqual(actual, expected);
          return;
        } catch (error) {
          if (Date.now() > deadline) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const up = { status: 200, mongodb: 'available', redis: 'available' };

    assert.equal((await fetch(`${app.origin}/ready`)).status, 401);
    await reaches(up);
    await redis.stop();
    await reaches({ ...up, status: 503, redis: 'unavailable' });
    assert.equal((await fetch(`${app.origin}/live`)).status, 200);
    await redis.start();
    await reaches(up);
    await mongo.stop();
    await reaches({ ...up, status: 503, mongodb: 'unavailable' });
    assert.equal((await fetch(`${app.origin}/health`)).status, 200);
    await mongo.start();
    await reaches(up);

    app.child.send('shutdown');
    assert.equal(await app.closed, 0);
    assert.ok(!app.state.output.includes('shutdown_timeout'));
    assert.match(app.state.output, /shutdown_complete/);
    for (const name of ['mongodb', 'redis'])
      for (const event of [
        'dependency_connected',
        'dependency_unavailable',
        'dependency_reconnected',
        'dependency_closed',
      ])
        assert.ok(
          app.state.output
            .split('\n')
            .some(
              (line) =>
                line.includes(`"${event}"`) &&
                line.includes(`"dependency":"${name}"`),
            ),
          `${name} ${event}`,
        );
    assertNoLeak(app.state.output);
  },
);

test(
  'unavailable MongoDB stops startup with a nonzero exit',
  { timeout: 30_000 },
  async (context) => {
    const redis = await startFakeRedis('seeded-pass');
    context.after(() => redis.stop());
    const app = await launch(
      context,
      `mongodb://${credentials}@127.0.0.1:1/unit_test`,
      redis.port,
    );
    assert.equal(await app.closed, 1);
    // The process ended by itself; nothing leaked until the forced deadline.
    assert.ok(!app.state.output.includes('shutdown_timeout'));
    assert.match(
      app.state.output,
      /"startup_failed".*"errorKind":"dependency_unreachable"/,
    );
    assert.ok(!app.state.output.includes('server_started'));
    assert.deepEqual(redis.commands, []);
    assertNoLeak(app.state.output);
  },
);

test(
  'unavailable Redis stops startup and closes MongoDB',
  { timeout: 30_000 },
  async (context) => {
    const mongo = await startFakeMongo();
    context.after(() => mongo.stop());
    const app = await launch(context, mongo.uri, 1);
    assert.equal(await app.closed, 1);
    // The process ended by itself; nothing leaked until the forced deadline.
    assert.ok(!app.state.output.includes('shutdown_timeout'));
    assert.match(
      app.state.output,
      /"startup_failed".*"errorKind":"dependency_unreachable"/,
    );
    assert.match(
      app.state.output,
      /"dependency_closed".*"dependency":"mongodb"/,
    );
    assert.ok(!app.state.output.includes('server_started'));
    await until(() => mongo.sockets.size === 0);
    assertNoLeak(app.state.output);
  },
);

test(
  'shutdown during an established outage is clean',
  { timeout: 30_000 },
  async (context) => {
    const mongo = await startFakeMongo();
    const redis = await startFakeRedis('seeded-pass');
    const app = await launch(context, mongo.uri, redis.port);
    await until(() => app.state.output.includes('server_started'), 20_000);
    await Promise.all([mongo.stop(), redis.stop()]);
    const response = await fetch(`${app.origin}/ready`, {
      headers: { Authorization: `Bearer ${testToken}` },
    });
    assert.equal(response.status, 503);
    const started = Date.now();
    app.child.send('shutdown');
    assert.equal(await app.closed, 0);
    assert.ok(!app.state.output.includes('shutdown_timeout'));
    assert.ok(Date.now() - started < 10_000);
    assertNoLeak(app.state.output);
  },
);

test(
  'shutdown while dependencies vanish is bounded and never hides a failed close',
  { timeout: 30_000 },
  async (context) => {
    const mongo = await startFakeMongo();
    const redis = await startFakeRedis('seeded-pass');
    const app = await launch(context, mongo.uri, redis.port);
    await until(() => app.state.output.includes('server_started'), 20_000);
    await Promise.all([mongo.stop(), redis.stop()]);
    const started = Date.now();
    app.child.send('shutdown');
    const code = await app.closed;
    assert.ok(Date.now() - started < 8_000);
    // The MongoDB driver can wait forever on a socket whose peer just closed.
    const failed = app.state.output.includes('dependency_close_failed');
    assert.equal(code, failed ? 1 : 0);
    assert.equal(app.state.output.includes('shutdown_complete'), !failed);
    assertNoLeak(app.state.output);
  },
);
