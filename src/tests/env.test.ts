import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv } from '../app/config/env.js';
import { testToken, validEnv } from './support/env.js';

const valid = { ...validEnv, NODE_ENV: 'development' };

test('environment modes and comma-separated exact origins validate', () => {
  for (const NODE_ENV of ['development', 'test', 'production']) {
    const result = parseEnv({
      ...valid,
      NODE_ENV,
      WATCHDOG_TOKEN: testToken,
      CORS_ORIGIN: 'http://localhost:5173, https://console.example.com',
    });
    assert.equal(result.PORT, 5000);
    assert.equal(result.STARTUP_MAX_ATTEMPTS, 3);
    assert.deepEqual(result.CORS_ORIGIN, [
      'http://localhost:5173',
      'https://console.example.com',
    ]);
  }
});

test('required settings, ports, modes and origins reject invalid configuration without echoing values', () => {
  for (const input of [
    {},
    { ...valid, PORT: '0' },
    { ...valid, PORT: '65536' },
    { ...valid, PORT: '1.5' },
    { ...valid, PORT: '' },
    { ...valid, NODE_ENV: 'secret-mode-value' },
    { ...valid, CORS_ORIGIN: '*' },
    { ...valid, CORS_ORIGIN: 'null' },
    { ...valid, CORS_ORIGIN: 'https://user:secret-value@example.com' },
    { ...valid, CORS_ORIGIN: 'https://example.com/path' },
    { ...valid, MONGODB_URI: '' },
    { ...valid, MONGODB_URI: 'mongodb://u:secret-value@db.example.com' },
    { ...valid, MONGODB_URI: 'https://db.example.com/app' },
    { ...valid, REDIS_URL: '' },
    // The command copied from a provider console is not a URL.
    {
      ...valid,
      REDIS_URL: 'redis-cli -u redis://u:secret-value@cache.example.com:6379',
    },
    { ...valid, REDIS_URL: 'http://cache.example.com:6379' },
    { ...valid, REDIS_URL: 'redis://cache.example.com:6379?tls=secret' },
    { ...valid, REDIS_URL: 'redis://cache.example.com:6379/secret' },
    { ...valid, NODE_ENV: 'production' },
    { ...valid, WATCHDOG_TOKEN: 'short-secret' },
  ]) {
    assert.throws(
      () => parseEnv(input),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Invalid environment configuration/);
        assert.ok(!error.message.includes('secret'));
        return true;
      },
    );
  }
});
