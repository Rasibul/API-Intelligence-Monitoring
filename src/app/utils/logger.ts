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
  fields: { requestId?: string; port?: number; statusCode?: number } = {},
): void {
  const record = JSON.stringify({
    level,
    event,
    at: new Date().toISOString(),
    ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
    ...(fields.port === undefined ? {} : { port: fields.port }),
    ...(fields.statusCode === undefined
      ? {}
      : { statusCode: fields.statusCode }),
  });
  if (level === 'error') console.error(record);
  else console.log(record);
}
