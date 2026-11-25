import { once } from 'node:events';
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import type { Environment } from './env.js';
import {
  AvailabilityLog,
  backoff,
  connectWithRetry,
  withDeadline,
} from '../utils/dependency.js';
import type { Dependency } from '../utils/dependency.js';
import {
  classifyDependencyError,
  DependencyError,
} from '../utils/DependencyError.js';

type RedisSettings = Pick<
  Environment,
  | 'REDIS_URL'
  | 'REDIS_CONNECT_TIMEOUT_MS'
  | 'REDIS_RECONNECT_MAX_DELAY_MS'
  | 'STARTUP_MAX_ATTEMPTS'
>;

/** The part of an ioredis client this manager uses; replaceable in tests. */
export type RedisClient = Pick<
  Redis,
  'connect' | 'ping' | 'quit' | 'disconnect' | 'status'
> &
  NodeJS.EventEmitter;

type ClientOptions = RedisOptions & { replyMapping: 'legacy' };
export type RedisFactory = (url: string, options: ClientOptions) => RedisClient;

const commandTimeoutMs = 2_000;
const closeTimeoutMs = 2_000;

export function redisOptions(
  config: RedisSettings,
  mayReconnect: () => boolean,
): ClientOptions {
  return {
    connectionName: 'api-intelligence-api',
    lazyConnect: true,
    connectTimeout: config.REDIS_CONNECT_TIMEOUT_MS,
    // Destroys a socket whose peer ignores the close; below closeTimeoutMs.
    disconnectTimeout: 1_000,
    commandTimeout: commandTimeoutMs,
    // Replaces a half-open socket that accepts writes but never answers.
    socketTimeout: 10_000,
    keepAlive: 10_000,
    // Commands fail immediately during an outage; nothing accumulates.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    autoResendUnfulfilledCommands: false,
    autoResubscribe: false,
    enableReadyCheck: true,
    maxLoadingRetryTime: 2_000,
    // RESP3 push-driven endpoint handoffs are not needed.
    protocol: 2,
    replyMapping: 'legacy',
    maintNotifications: 'disabled',
    // Startup attempts are counted by the manager. Only an established
    // connection reconnects by itself, at a capped rate.
    retryStrategy: (times) =>
      mayReconnect()
        ? backoff(times, 200, config.REDIS_RECONNECT_MAX_DELAY_MS)
        : null,
  };
}

/**
 * Owns the API process's general-purpose Redis client. BullMQ workers must not
 * share it: their blocking connections need maxRetriesPerRequest: null.
 */
export function createRedisManager(
  config: RedisSettings,
  create: RedisFactory = (url, options) => new Redis(url, options),
): Dependency {
  const availability = new AvailabilityLog('redis');
  // connect() rejects with a generic message; the reason arrives as an event.
  let lastError: unknown;

  const client = create(
    config.REDIS_URL,
    redisOptions(config, () => availability.established),
  );
  client.on('error', (error: unknown) => {
    lastError = error;
  });
  client.on('close', () => availability.lost());
  client.on('reconnecting', () => availability.reconnecting());
  client.on('ready', () => availability.recovered());

  /** A client that is still closing rejects connect(), wasting a retry. */
  async function release(): Promise<void> {
    if (client.status === 'end') return;
    const ended = new Promise<void>((resolve) => {
      client.once('end', () => resolve());
    });
    client.disconnect();
    await withDeadline(
      ended,
      closeTimeoutMs,
      () => new DependencyError('redis', 'dependency_timeout'),
    ).catch(() => undefined);
  }

  async function attempt(): Promise<void> {
    lastError = undefined;
    try {
      await withDeadline(
        client.connect().then(() => client.ping()),
        config.REDIS_CONNECT_TIMEOUT_MS + 2 * commandTimeoutMs,
        () => new DependencyError('redis', 'dependency_timeout'),
      );
    } catch (error) {
      const failure = DependencyError.from(
        'redis',
        error instanceof DependencyError ? error : (lastError ?? error),
      );
      await release();
      throw failure;
    }
    availability.connected();
  }

  async function quit(): Promise<void> {
    try {
      await client.quit();
    } catch (error) {
      if (classifyDependencyError(error) === 'dependency_timeout') throw error;
      // The peer dropped the connection first, so only local state remains.
      client.disconnect();
    }
  }

  return {
    name: 'redis',
    connect: (signal) =>
      connectWithRetry({
        name: 'redis',
        maxAttempts: config.STARTUP_MAX_ATTEMPTS,
        baseDelayMs: 500,
        maxDelayMs: 3_000,
        signal,
        attempt,
      }),
    async check(deadlineMs) {
      if (!availability.established || client.status !== 'ready') return false;
      try {
        await withDeadline(
          client.ping(),
          deadlineMs,
          () => new DependencyError('redis', 'dependency_timeout'),
        );
      } catch (raw) {
        const error = DependencyError.from('redis', raw);
        availability.lost(error.kind);
        throw error;
      }
      availability.recovered();
      return true;
    },
    async close() {
      availability.closing();
      if (client.status === 'end') return;
      const ended = once(client, 'end', {
        signal: AbortSignal.timeout(closeTimeoutMs),
      });
      ended.catch(() => undefined);
      try {
        if (client.status === 'ready') await quit();
        else client.disconnect();
        await ended;
      } catch (error) {
        client.disconnect();
        throw DependencyError.from('redis', error);
      }
    },
  };
}
