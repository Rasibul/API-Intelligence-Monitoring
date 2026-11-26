import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createMongoManager } from '../../app/config/database.js';
import { createRedisManager } from '../../app/config/redis.js';
import { DependencyError } from '../../app/utils/DependencyError.js';
import { testConfig } from '../support/env.js';

// Opt-in checks against real development services only. Variables come from
// the shell, never from .env. Nothing is written: connect, check, close.
const mongoUri = process.env.INTEGRATION_MONGODB_URI;
const redisUrl = process.env.INTEGRATION_REDIS_URL;
const signal = () => new AbortController().signal;

/** A plaintext URL would send the password unencrypted over the network. */
function redisSkipReason(): string | false {
  if (!redisUrl) return 'INTEGRATION_REDIS_URL is not set';
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    return 'INTEGRATION_REDIS_URL is not a URL';
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'rediss:' && !loopback)
    return 'remote Redis must use rediss:// (TLS)';
  return false;
}

test(
  'MongoDB: connects, authorizes, reports topology and closes',
  { skip: mongoUri ? false : 'INTEGRATION_MONGODB_URI is not set' },
  async () => {
    const manager = createMongoManager(
      testConfig({ MONGODB_URI: mongoUri, STARTUP_MAX_ATTEMPTS: '1' }),
    );
    try {
      await manager.connect(signal());
      assert.equal(await manager.check(2_000), true);
    } finally {
      await manager.close();
    }
    assert.equal(await manager.check(500), false);
  },
);

test(
  'Redis: connects, pings, closes, and rejects a wrong password once',
  { skip: redisSkipReason() },
  async () => {
    const manager = createRedisManager(
      testConfig({ REDIS_URL: redisUrl, STARTUP_MAX_ATTEMPTS: '1' }),
    );
    try {
      await manager.connect(signal());
      assert.equal(await manager.check(2_000), true);
    } finally {
      await manager.close();
    }

    const wrong = new URL(redisUrl!);
    wrong.password = randomBytes(16).toString('hex');
    const rejected = createRedisManager(
      testConfig({ REDIS_URL: wrong.href, STARTUP_MAX_ATTEMPTS: '1' }),
    );
    try {
      await assert.rejects(
        rejected.connect(signal()),
        (error: unknown) =>
          error instanceof DependencyError &&
          error.kind === 'dependency_authentication' &&
          !error.message.includes(wrong.password),
      );
    } finally {
      await rejected.close();
    }
  },
);
