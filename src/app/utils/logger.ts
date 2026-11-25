import { ConfigurationError } from '../config/env.js';
import { AppError } from './AppError.js';

const errorKinds = [
  'configuration',
  'address_in_use',
  'permission_denied',
  'operational',
  'type_error',
  'syntax_error',
  'unknown',
] as const;
type ErrorKind = (typeof errorKinds)[number];

export function classifyError(error: unknown): ErrorKind {
  if (error instanceof ConfigurationError) return 'configuration';
  if (error instanceof AppError) return 'operational';
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
  | 'shutdown_timeout'
  | 'fatal_process_error'
  | 'request_failed';

// Closed, allowlisted fields: never serialize requests, environment or Error objects.
export function log(
  level: 'info' | 'error',
  event: LogEvent,
  fields: {
    requestId?: string;
    port?: number;
    statusCode?: number;
    errorKind?: ErrorKind;
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
  });
  if (level === 'error') console.error(record);
  else console.log(record);
}
