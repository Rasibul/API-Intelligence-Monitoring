import { parseEnv } from '../../app/config/env.js';
import type { Environment } from '../../app/config/env.js';

// Closed local port: nothing in the suite can reach a real service by accident.
export const validEnv = {
  NODE_ENV: 'test',
  PORT: '5000',
  CORS_ORIGIN: 'http://localhost:5173',
  MONGODB_URI: 'mongodb://127.0.0.1:1/unit_test',
  REDIS_URL: 'redis://127.0.0.1:1',
} as const;

export const testToken = 'unit-test-watchdog-credential-0000000000';

export function testConfig(overrides: NodeJS.ProcessEnv = {}): Environment {
  return parseEnv({ ...validEnv, ...overrides });
}

/** Captures structured log lines written by the application logger. */
export function captureLogs(context: {
  mock: typeof import('node:test').mock;
}): { lines: string[]; events: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  for (const method of ['log', 'error', 'warn'] as const)
    context.mock.method(console, method, (value: unknown) => {
      lines.push(String(value));
    });
  return {
    lines,
    events: () =>
      lines
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export async function until(
  condition: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
