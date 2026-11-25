import { setTimeout as sleep } from 'node:timers/promises';
import { DependencyError } from './DependencyError.js';
import type { DependencyErrorKind, DependencyName } from './DependencyError.js';
import { log } from './logger.js';
import type { MongoTopology } from './logger.js';

/** Lifecycle contract shared by the MongoDB and Redis connection managers. */
export interface Dependency {
  readonly name: DependencyName;
  /** Bounded initial connection; rejects only with DependencyError. */
  connect(signal: AbortSignal): Promise<void>;
  /** Live check, bounded by `deadlineMs`. Rejection means unavailable. */
  check(deadlineMs: number): Promise<boolean>;
  /** Safe before, during or after connect. */
  close(): Promise<void>;
}

/** The losing promise stays observed, so a late rejection is never unhandled. */
export async function withDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Capped exponential backoff; jitter keeps at least half of the delay. */
export function backoff(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 30));
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}

async function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new Error('aborted'));
        signal.addEventListener('abort', cancel, { once: true });
      }),
    ]);
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel);
  }
}

/** Runs a connection attempt a finite number of times. */
export async function connectWithRetry(options: {
  name: DependencyName;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  signal: AbortSignal;
  attempt: () => Promise<void>;
}): Promise<void> {
  const { name, maxAttempts, signal } = options;
  for (let attempt = 1; !signal.aborted; attempt++) {
    try {
      await untilAborted(options.attempt(), signal);
      return;
    } catch (raw) {
      if (signal.aborted) break;
      const error = DependencyError.from(name, raw);
      log('error', 'dependency_unavailable', {
        dependency: name,
        errorKind: error.kind,
        attempt,
        maxAttempts,
      });
      if (error.permanent || attempt >= maxAttempts) throw error;
    }
    await sleep(
      backoff(attempt, options.baseDelayMs, options.maxDelayMs),
      undefined,
      { signal },
    ).catch(() => undefined); // Abort is handled by the loop condition.
  }
  throw new DependencyError(name, 'dependency_cancelled');
}

/**
 * Logs availability changes once per transition, whether a driver event or a
 * live check notices first. Silent before connecting and while closing.
 */
export class AvailabilityLog {
  #state: 'idle' | 'available' | 'unavailable' | 'closing' = 'idle';
  #reconnecting = false;

  constructor(private readonly dependency: DependencyName) {}

  get established(): boolean {
    return this.#state === 'available' || this.#state === 'unavailable';
  }

  connected(topology?: MongoTopology): void {
    if (this.#state !== 'idle') return;
    this.#state = 'available';
    log('info', 'dependency_connected', {
      dependency: this.dependency,
      ...(topology === undefined ? {} : { topology }),
    });
  }

  lost(errorKind?: DependencyErrorKind): void {
    if (this.#state !== 'available') return;
    this.#state = 'unavailable';
    this.#reconnecting = false;
    log('error', 'dependency_unavailable', {
      dependency: this.dependency,
      ...(errorKind === undefined ? {} : { errorKind }),
    });
  }

  reconnecting(): void {
    if (this.#state !== 'unavailable' || this.#reconnecting) return;
    this.#reconnecting = true;
    log('info', 'dependency_reconnecting', { dependency: this.dependency });
  }

  recovered(): void {
    if (this.#state !== 'unavailable') return;
    this.#state = 'available';
    log('info', 'dependency_reconnected', { dependency: this.dependency });
  }

  closing(): void {
    this.#state = 'closing';
  }
}
