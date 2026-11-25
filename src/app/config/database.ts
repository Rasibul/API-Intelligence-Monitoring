import mongoose from 'mongoose';
import type { ConnectOptions, Connection } from 'mongoose';
import type { Environment } from './env.js';
import {
  AvailabilityLog,
  connectWithRetry,
  withDeadline,
} from '../utils/dependency.js';
import type { Dependency } from '../utils/dependency.js';
import { DependencyError } from '../utils/DependencyError.js';
import { log } from '../utils/logger.js';
import type { MongoTopology } from '../utils/logger.js';

type MongoSettings = Pick<
  Environment,
  | 'MONGODB_URI'
  | 'MONGODB_MAX_POOL_SIZE'
  | 'MONGODB_CONNECT_TIMEOUT_MS'
  | 'MONGODB_SERVER_SELECTION_TIMEOUT_MS'
  | 'STARTUP_MAX_ATTEMPTS'
>;

/** The part of a Mongoose connection this manager uses; replaceable in tests. */
export type MongoConnection = Pick<
  Connection,
  'openUri' | 'close' | 'on' | 'getClient' | 'readyState' | 'db'
>;

const verifyTimeoutMs = 2_000;

export function mongoOptions(config: MongoSettings): ConnectOptions {
  return {
    appName: 'api-intelligence-api',
    maxPoolSize: config.MONGODB_MAX_POOL_SIZE,
    minPoolSize: 0,
    // Bounds time spent waiting for a pooled connection under load.
    waitQueueTimeoutMS: 2_000,
    connectTimeoutMS: config.MONGODB_CONNECT_TIMEOUT_MS,
    serverSelectionTimeoutMS: config.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    socketTimeoutMS: 10_000,
    heartbeatFrequencyMS: 10_000,
    // Fail operations during an outage instead of queueing them in memory.
    bufferCommands: false,
    // Indexes and collections are created only by reviewed migrations.
    autoIndex: false,
    autoCreate: false,
  };
}

async function verify(connection: MongoConnection): Promise<MongoTopology> {
  const db = connection.db;
  if (!db) throw new DependencyError('mongodb', 'dependency_failed');
  // `ping` and `hello` succeed without credentials on a server that requires
  // them, so prove authorization with the cheapest authenticated command.
  await db
    .listCollections(
      {},
      {
        nameOnly: true,
        authorizedCollections: true,
        timeoutMS: verifyTimeoutMs,
      },
    )
    .toArray();
  const hello = await db.command({ hello: 1 }, { timeoutMS: verifyTimeoutMs });
  if (hello.msg === 'isdbgrid') return 'sharded';
  return typeof hello.setName === 'string' ? 'replica_set' : 'standalone';
}

/**
 * Owns the process's single MongoDB client. Uses Mongoose's default connection
 * so later models attach to it without opening another pool.
 */
export function createMongoManager(
  config: MongoSettings,
  connection: MongoConnection = mongoose.connection,
): Dependency {
  const availability = new AvailabilityLog('mongodb');
  let pending: Promise<unknown> | undefined;

  // Without a listener Mongoose connection errors would be uncaught; details
  // are already classified where the failing call is awaited.
  connection.on('error', () => undefined);
  connection.on('disconnected', () => {
    availability.lost();
    // The driver keeps monitoring and reconnects by itself.
    availability.reconnecting();
  });
  connection.on('reconnected', () => availability.recovered());

  async function attempt(): Promise<void> {
    const opening = connection.openUri(
      config.MONGODB_URI,
      mongoOptions(config),
    );
    pending = opening.catch(() => undefined);
    // Driver deadlines do not cover SRV lookups. An attempt stuck past this
    // cannot be safely repeated on the same connection, so it is permanent.
    await withDeadline(
      opening,
      config.MONGODB_CONNECT_TIMEOUT_MS +
        config.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      () => new DependencyError('mongodb', 'dependency_timeout', true),
    );
    try {
      availability.connected(await verify(connection));
    } catch (error) {
      // Connected but unusable: release this client before any retry.
      await connection.close(true).catch(() => {
        log('error', 'dependency_close_failed', { dependency: 'mongodb' });
      });
      throw error;
    }
  }

  return {
    name: 'mongodb',
    connect: (signal) =>
      connectWithRetry({
        name: 'mongodb',
        maxAttempts: config.STARTUP_MAX_ATTEMPTS,
        baseDelayMs: 500,
        maxDelayMs: 3_000,
        signal,
        attempt,
      }),
    async check(deadlineMs) {
      if (!availability.established || !connection.db) return false;
      // Attempted even while disconnected: pending server selection makes the
      // driver recheck sooner than its idle heartbeat interval.
      try {
        await connection.db.command({ ping: 1 }, { timeoutMS: deadlineMs });
      } catch (raw) {
        const error = DependencyError.from('mongodb', raw);
        availability.lost(error.kind);
        throw error;
      }
      availability.recovered();
      return true;
    },
    async close() {
      availability.closing();
      try {
        if (connection.readyState === mongoose.STATES.connecting) {
          // Mongoose defers close() until connecting settles. Closing the
          // client directly cancels server selection immediately.
          await connection.getClient()?.close(true);
          await pending;
        }
        await connection.close(false);
      } catch (error) {
        throw DependencyError.from('mongodb', error);
      }
    },
  };
}
