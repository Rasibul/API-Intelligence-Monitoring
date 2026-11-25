import type { Dependency } from '../../app/utils/dependency.js';
import type { DependencyName } from '../../app/utils/DependencyError.js';

export interface FakeDependency extends Dependency {
  calls: string[];
  checks: number;
  behavior: {
    connect: (signal: AbortSignal) => Promise<void>;
    check: () => Promise<boolean>;
    close: () => Promise<void>;
  };
}

export function fakeDependency(
  name: DependencyName,
  behavior: Partial<FakeDependency['behavior']> = {},
  calls: string[] = [],
): FakeDependency {
  const fake: FakeDependency = {
    name,
    calls,
    checks: 0,
    behavior: {
      connect: async () => undefined,
      check: async () => true,
      close: async () => undefined,
      ...behavior,
    },
    connect(signal) {
      calls.push(`${name}.connect`);
      return fake.behavior.connect(signal);
    },
    check() {
      fake.checks++;
      return fake.behavior.check();
    },
    close() {
      calls.push(`${name}.close`);
      return fake.behavior.close();
    },
  };
  return fake;
}
