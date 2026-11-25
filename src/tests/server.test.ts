import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

test('invalid configuration prevents server startup and never echoes values', async () => {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/app/server.ts'],
    {
      env: { ...process.env, PORT: 'seeded-secret-port' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(output, /Invalid environment configuration: PORT/);
  assert.ok(!output.includes('seeded-secret'));
  assert.ok(!output.includes('server_started'));
  assert.match(output, /"errorKind":"configuration"/);
});

test(
  'occupied port causes a safe startup failure and nonzero exit',
  { timeout: 10_000 },
  async (context) => {
    const occupied = createServer();
    occupied.listen({ port: 0, exclusive: true });
    await once(occupied, 'listening');
    try {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/app/server.ts'],
        {
          env: {
            ...process.env,
            PORT: String((occupied.address() as AddressInfo).port),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      context.after(() => {
        if (child.exitCode === null) child.kill();
      });
      let output = '';
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      const [code] = await once(child, 'exit');
      assert.equal(code, 1);
      assert.match(output, /startup_failed/);
      assert.match(output, /"errorKind":"address_in_use"/);
      assert.ok(!output.includes('stack'));
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(
    `${signal} handler shuts down the HTTP server cleanly`,
    { timeout: 15_000 },
    async (context) => {
      const reservation = createServer();
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const port = (reservation.address() as AddressInfo).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      // IPC invokes the same Node signal event on Windows, where child.kill does not deliver POSIX signals.
      const launcher = `import './src/app/server.ts'; process.once('message', () => { process.disconnect(); process.emit('${signal}'); });`;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', launcher],
        {
          env: { ...process.env, PORT: String(port), NODE_ENV: 'test' },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      context.after(() => {
        if (child.exitCode === null) child.kill();
      });
      let output = '';
      const exited = once(child, 'exit');
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on('data', (chunk) => {
          output += String(chunk);
          if (output.includes('server_started')) resolve();
        });
        child.once('error', reject);
        child.once('exit', () =>
          reject(new Error('Server exited before startup')),
        );
      });
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}/health`)).status,
        200,
      );
      child.send('shutdown');
      const [code] = await exited;
      assert.equal(code, 0);
      assert.match(output, /shutdown_started/);
      assert.match(output, /shutdown_complete/);
    },
  );
}
