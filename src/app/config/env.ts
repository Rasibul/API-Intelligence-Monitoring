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

const schema = z.object({
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
});

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
