import type { Dependency } from '../../utils/dependency.js';
import { DependencyError } from '../../utils/DependencyError.js';
import type { DependencyName } from '../../utils/DependencyError.js';
import { withDeadline } from '../../utils/dependency.js';

export type DependencyState = 'available' | 'unavailable';

export interface ReadinessReport {
  ready: boolean;
  dependencies: Partial<Record<DependencyName, DependencyState>>;
  checkedAt: Date;
}

export interface Readiness {
  check(): Promise<ReadinessReport>;
}

/**
 * Checks every dependency under one deadline. Results are coalesced and cached
 * briefly so frequent probes cannot amplify an outage.
 */
export function createReadiness(
  dependencies: readonly Dependency[],
  isServing: () => boolean,
  { deadlineMs = 1_000, cacheMs = 1_000, now = Date.now } = {},
): Readiness {
  let cached: ReadinessReport | undefined;
  let pending: Promise<ReadinessReport> | undefined;

  async function state(dependency: Dependency): Promise<DependencyState> {
    try {
      const healthy = await withDeadline(
        dependency.check(deadlineMs),
        deadlineMs,
        () => new DependencyError(dependency.name, 'dependency_timeout'),
      );
      return healthy ? 'available' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  async function run(): Promise<ReadinessReport> {
    const states = await Promise.all(
      dependencies.map(async (item) => [item.name, await state(item)] as const),
    );
    cached = {
      ready: states.every(([, value]) => value === 'available'),
      dependencies: Object.fromEntries(states),
      checkedAt: new Date(now()),
    };
    return cached;
  }

  return {
    async check() {
      let report = cached;
      if (!report || now() - report.checkedAt.getTime() >= cacheMs) {
        pending ??= run().finally(() => {
          pending = undefined;
        });
        report = await pending;
      }
      // Never cached: shutdown must be visible immediately.
      return isServing() ? report : { ...report, ready: false };
    },
  };
}
