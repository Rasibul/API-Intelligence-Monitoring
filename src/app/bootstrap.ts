import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createApp } from './app.js';
import { ConfigurationError } from './config/env.js';
import type { Environment } from './config/env.js';
import { createReadiness } from './modules/health/readiness.service.js';
import { withDeadline } from './utils/dependency.js';
import type { Dependency } from './utils/dependency.js';
import { DependencyError } from './utils/DependencyError.js';
import { classifyError, log } from './utils/logger.js';

/** The process operations used here; replaceable in tests. */
export interface Host {
  exitCode?: number | string | null | undefined;
  exit(code: number): void;
  on(event: string, listener: (argument: unknown) => void): unknown;
}

export interface BootstrapOptions {
  loadConfig: () => Environment;
  /** In connection order; closed in reverse. */
  createDependencies: (config: Environment) => readonly Dependency[];
  host?: Host;
  limits?: { drainMs: number; closeMs: number; totalMs: number };
}

// drainMs + closeMs for each dependency must fit inside totalMs.
const defaultLimits = { drainMs: 10_000, closeMs: 2_500, totalMs: 16_000 };
const exitFlushMs = 250;

function createHttpServer(app: ReturnType<typeof createApp>): Server {
  const server = createServer(
    { maxHeaderSize: 16 * 1024, connectionsCheckingInterval: 1_000 },
    app,
  );
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = 15_000;
  server.maxRequestsPerSocket = 100;
  server.on('timeout', (socket) => socket.destroy());
  return server;
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Resolves once startup finished or failed and was cleaned up; never rejects. */
export async function bootstrap(options: BootstrapOptions): Promise<void> {
  const host: Host = options.host ?? process;
  const limits = options.limits ?? defaultLimits;
  const startup = new AbortController();
  const opened: Dependency[] = [];
  let server: Server | undefined;
  let stopping: Promise<void> | undefined;

  function stop(exitCode: number): Promise<void> {
    // A failure is never downgraded by a later clean stop request.
    if (exitCode !== 0) host.exitCode = exitCode;
    stopping ??= runShutdown();
    return stopping;
  }

  async function drainHttp(): Promise<boolean> {
    if (!server?.listening) return true;
    const active = server;
    const closed = new Promise<boolean>((resolve) => {
      active.close((error) => resolve(error === undefined));
    });
    active.closeIdleConnections();
    try {
      return await withDeadline(closed, limits.drainMs, () => new Error());
    } catch {
      log('error', 'shutdown_timeout');
      active.closeAllConnections();
      return false;
    }
  }

  async function closeDependency(dependency: Dependency): Promise<boolean> {
    const { name } = dependency;
    try {
      await withDeadline(
        dependency.close(),
        limits.closeMs,
        () => new DependencyError(name, 'dependency_timeout'),
      );
      log('info', 'dependency_closed', { dependency: name });
      return true;
    } catch (error) {
      log('error', 'dependency_close_failed', {
        dependency: name,
        errorKind: classifyError(error),
      });
      return false;
    }
  }

  async function runShutdown(): Promise<void> {
    log('info', 'shutdown_started');
    startup.abort();
    const deadline = setTimeout(() => {
      log('error', 'shutdown_timeout');
      server?.closeAllConnections();
      host.exit(1);
    }, limits.totalMs);
    // Requests may need the dependencies, so HTTP drains first.
    let clean = await drainHttp();
    for (const dependency of opened.reverse())
      clean = (await closeDependency(dependency)) && clean;
    if (clean) {
      // Kept armed but unreferenced: it fires only if something leaked still
      // keeps the process alive.
      deadline.unref();
      host.exitCode ??= 0;
      log('info', 'shutdown_complete');
    } else {
      clearTimeout(deadline);
      host.exitCode = 1;
      log('error', 'shutdown_failed');
      // Nothing more can be released, so do not wait out the deadline. The
      // delay lets buffered log output flush.
      setTimeout(() => host.exit(1), exitFlushMs).unref();
    }
  }

  const fatal = (error: unknown) => {
    log('error', 'fatal_process_error', { errorKind: classifyError(error) });
    void stop(1);
  };

  try {
    const config = options.loadConfig();
    // Registered before connecting so a signal can interrupt startup.
    host.on('SIGINT', () => void stop(0));
    host.on('SIGTERM', () => void stop(0));
    host.on('uncaughtException', fatal);
    host.on('unhandledRejection', fatal);

    const dependencies = options.createDependencies(config);
    for (const dependency of dependencies) {
      // Recorded first: a half-open connection also needs cleanup.
      opened.push(dependency);
      await dependency.connect(startup.signal);
    }
    if (stopping) return await stopping;

    const readiness = createReadiness(
      dependencies,
      () => stopping === undefined,
    );
    server = createHttpServer(
      createApp(
        config,
        config.WATCHDOG_TOKEN === undefined
          ? undefined
          : { readiness, watchdogToken: config.WATCHDOG_TOKEN },
      ),
    );
    await listen(server, config.PORT);
    server.on('error', fatal);
    log('info', 'server_started', { port: config.PORT });
  } catch (error) {
    if (stopping) return await stopping;
    if (error instanceof ConfigurationError) console.error(error.message);
    // Only our sanitized field-name diagnostic is printable, never raw exceptions.
    log('error', 'startup_failed', { errorKind: classifyError(error) });
    await stop(1);
  }
}
