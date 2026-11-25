import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { z } from 'zod';

const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}, 'must contain exact HTTP(S) origins without paths or trailing slashes');

function integer(min: number, max: number) {
  return z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
}

// Structural check only; the driver performs full parsing. A database name is
// mandatory because MongoDB otherwise silently uses a database called "test".
const mongoUri = z
  .string()
  .max(2048)
  .regex(
    /^mongodb(\+srv)?:\/\/([^\s/?#@]+@)?[^\s/?#@]+\/[^\s/?#@.$"\\]+(\?[^\s#]*)?$/,
  );

const redisUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['redis:', 'rediss:'].includes(url.protocol) &&
        url.hostname !== '' &&
        /^(\/\d{0,2})?$/.test(url.pathname) &&
        // ioredis turns query parameters into client options, which could
        // override the connection bounds set by this application.
        url.search === '' &&
        url.hash === ''
      );
    } catch {
      return false;
    }
  });

// An empty value means "not configured", so a blank .env line is not a token.
const watchdogToken = z
  .string()
  .regex(/^([A-Za-z0-9._~+/-]{32,256}=*)?$/)
  .transform((value) => (value === '' ? undefined : value))
  .optional();

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(65535)),
    CORS_ORIGIN: z
      .string()
      .transform((value) => value.split(',').map((part) => part.trim()))
      .pipe(z.array(origin).min(1)),
    MONGODB_URI: mongoUri,
    MONGODB_MAX_POOL_SIZE: integer(1, 100).default(10),
    // Capped below the shutdown deadline: the driver keeps a half-open handshake
    // alive for this long even after its client has been closed.
    MONGODB_CONNECT_TIMEOUT_MS: integer(500, 10_000).default(5_000),
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: integer(500, 30_000).default(5_000),
    REDIS_URL: redisUrl,
    REDIS_CONNECT_TIMEOUT_MS: integer(500, 30_000).default(5_000),
    REDIS_RECONNECT_MAX_DELAY_MS: integer(100, 60_000).default(5_000),
    STARTUP_MAX_ATTEMPTS: integer(1, 10).default(3),
    WATCHDOG_TOKEN: watchdogToken,
  })
  .refine(
    (value) =>
      value.NODE_ENV !== 'production' || value.WATCHDOG_TOKEN !== undefined,
    { path: ['WATCHDOG_TOKEN'] },
  );

export type Environment = z.infer<typeof schema>;

export class ConfigurationError extends Error {}

export function parseEnv(input: NodeJS.ProcessEnv): Environment {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Report field names only: Zod issue text may contain submitted values.
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path[0])),
    ];
    throw new ConfigurationError(
      `Invalid environment configuration: ${fields.join(', ')}. Check .env.example.`,
    );
  }
  return result.data;
}

export function loadEnvironment(): Environment {
  if (existsSync('.env')) loadEnvFile('.env');
  return parseEnv(process.env);
}
