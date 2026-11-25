import { ConfigurationError } from '../config/env.js';
import { AppError } from './AppError.js';
import { DependencyError, dependencyErrorKinds } from './DependencyError.js';
import type { DependencyName } from './DependencyError.js';

const errorKinds = [
  'configuration',
  'address_in_use',
  'permission_denied',
  'operational',
  'type_error',
  'syntax_error',
  ...dependencyErrorKinds,
  'unknown',
] as const;
type ErrorKind = (typeof errorKinds)[number];

export function classifyError(error: unknown): ErrorKind {
  if (error instanceof ConfigurationError) return 'configuration';
  if (error instanceof AppError) return 'operational';
  if (error instanceof DependencyError) return error.kind;
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'EADDRINUSE') return 'address_in_use';
    if (error.code === 'EACCES' || error.code === 'EPERM')
      return 'permission_denied';
  }
  if (error instanceof TypeError) return 'type_error';
  if (error instanceof SyntaxError) return 'syntax_error';
  return 'unknown';
}

type LogEvent =
  | 'server_started'
  | 'startup_failed'
  | 'shutdown_started'
  | 'shutdown_complete'
  | 'shutdown_failed'
  | 'shutdown_timeout'
  | 'dependency_connected'
  | 'dependency_unavailable'
  | 'dependency_reconnecting'
  | 'dependency_reconnected'
  | 'dependency_closed'
  | 'dependency_close_failed'
  | 'fatal_process_error'
  | 'request_failed';

export type MongoTopology = 'standalone' | 'replica_set' | 'sharded';

// Closed, allowlisted fields: never serialize requests, environment or Error objects.
export function log(
  level: 'info' | 'error',
  event: LogEvent,
  fields: {
    requestId?: string;
    port?: number;
    statusCode?: number;
    errorKind?: ErrorKind;
    dependency?: DependencyName;
    topology?: MongoTopology;
    attempt?: number;
    maxAttempts?: number;
  } = {},
): void {
  const record = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...(fields.errorKind === undefined
      ? {}
      : {
          errorKind: errorKinds.includes(fields.errorKind)
            ? fields.errorKind
            : 'unknown',
        }),
    ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
    ...(fields.port === undefined ? {} : { port: fields.port }),
    ...(fields.statusCode === undefined
      ? {}
      : { statusCode: fields.statusCode }),
    ...(fields.dependency === undefined
      ? {}
      : { dependency: fields.dependency }),
    ...(fields.topology === undefined ? {} : { topology: fields.topology }),
    ...(fields.attempt === undefined ? {} : { attempt: fields.attempt }),
    ...(fields.maxAttempts === undefined
      ? {}
      : { maxAttempts: fields.maxAttempts }),
  });
  if (level === 'error') console.error(record);
  else console.log(record);
}
