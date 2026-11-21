import { createServer } from 'node:http';
import { createApp } from './app.js';
import { ConfigurationError, loadEnvironment } from './config/env.js';
import { log } from './utils/logger.js';

async function main(): Promise<void> {
  const config = loadEnvironment();
  const server = createServer({ maxHeaderSize: 16 * 1024 }, createApp(config));
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = 15_000;
  server.maxRequestsPerSocket = 100;
  server.on('timeout', (socket) => socket.destroy());

  let stopping = false;
  function shutdown(exitCode: number): void {
    if (stopping) {
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }
    stopping = true;
    process.exitCode = exitCode;
    log('info', 'shutdown_started');
    const deadline = setTimeout(() => {
      log('error', 'shutdown_timeout');
      server.closeAllConnections();
      process.exit(1);
    }, 10_000);
    server.close((error) => {
      clearTimeout(deadline);
      if (error) process.exitCode = 1;
      log('info', 'shutdown_complete');
    });
    server.closeIdleConnections();
  }

  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once('error', failed);
    server.listen(config.PORT, () => {
      server.off('error', failed);
      resolve();
    });
  });
  server.on('error', () => {
    log('error', 'fatal_process_error');
    shutdown(1);
  });
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', () => {
    log('error', 'fatal_process_error');
    shutdown(1);
  });
  process.on('unhandledRejection', () => {
    log('error', 'fatal_process_error');
    shutdown(1);
  });
  log('info', 'server_started', { port: config.PORT });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigurationError) console.error(error.message);
  // Only our sanitized field-name diagnostic is printable, never raw exceptions.
  log('error', 'startup_failed');
  process.exitCode = 1;
});
