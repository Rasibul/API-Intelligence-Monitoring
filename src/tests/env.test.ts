import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv } from '../app/config/env.js';

const valid = {
  NODE_ENV: 'development',
  PORT: '5000',
  CORS_ORIGIN: 'http://localhost:5173',
};

test('environment modes and comma-separated exact origins validate', () => {
  for (const NODE_ENV of ['development', 'test', 'production']) {
    const result = parseEnv({
      ...valid,
      NODE_ENV,
      CORS_ORIGIN: 'http://localhost:5173, https://console.example.com',
    });
    assert.equal(result.PORT, 5000);
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
