export type DependencyName = 'mongodb' | 'redis';

// Most specific first; classification reports the first kind that applies.
export const dependencyErrorKinds = [
  'dependency_cancelled',
  'dependency_authentication',
  'dependency_tls',
  'dependency_configuration',
  'dependency_unreachable',
  'dependency_timeout',
  'dependency_failed',
] as const;
export type DependencyErrorKind = (typeof dependencyErrorKinds)[number];

// Retrying cannot fix these; startup fails on the first occurrence.
const permanentKinds: readonly DependencyErrorKind[] = [
  'dependency_cancelled',
  'dependency_authentication',
  'dependency_tls',
  'dependency_configuration',
];

/**
 * The only failure that leaves a connection manager. It carries a fixed
 * category and deliberately no `cause`: driver errors can contain hosts,
 * connection strings, commands and credentials.
 */
export class DependencyError extends Error {
  readonly permanent: boolean;

  constructor(
    readonly dependency: DependencyName,
    readonly kind: DependencyErrorKind,
    permanent = permanentKinds.includes(kind),
  ) {
    super(`${dependency}: ${kind}`);
    this.name = 'DependencyError';
    this.permanent = permanent;
  }

  static from(dependency: DependencyName, error: unknown): DependencyError {
    if (error instanceof DependencyError) return error;
    return new DependencyError(dependency, classifyDependencyError(error));
  }
}

// MongoDB Unauthorized, AuthenticationFailed and the Atlas equivalent.
const authCodes = new Set<unknown>([13, 18, 8000]);
const tlsCodes =
  /^(ERR_TLS|ERR_SSL|CERT_|EPROTO$|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_)/;
const unreachableCodes = new Set<unknown>([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ENODATA',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);
const timeoutNames = new Set([
  'MongoNetworkTimeoutError',
  'MongoOperationTimeoutError',
  'MongoServerSelectionError',
  'MongooseServerSelectionError',
]);
const configurationNames = new Set([
  'MongoParseError',
  'MongoInvalidArgumentError',
  'MongoMissingCredentialsError',
]);

function classifyOne(error: Error): DependencyErrorKind | undefined {
  const code = 'code' in error ? error.code : undefined;
  if (authCodes.has(code) || /^(WRONGPASS|NOAUTH|NOPERM)\b/.test(error.message))
    return 'dependency_authentication';
  if (typeof code === 'string' && tlsCodes.test(code)) return 'dependency_tls';
  if (configurationNames.has(error.name)) return 'dependency_configuration';
  if (unreachableCodes.has(code) || error.name === 'MongoNetworkError')
    return 'dependency_unreachable';
  if (
    code === 'ETIMEDOUT' ||
    timeoutNames.has(error.name) ||
    error.message === 'Command timed out'
  )
    return 'dependency_timeout';
  return undefined;
}

/** Wrapped errors, including each server's own error in a Mongo topology. */
function relatedErrors(error: Error): unknown[] {
  const found: unknown[] = [error.cause];
  if (error instanceof AggregateError) found.push(...error.errors);
  const reason = 'reason' in error ? error.reason : undefined;
  if (
    typeof reason === 'object' &&
    reason !== null &&
    'servers' in reason &&
    reason.servers instanceof Map
  ) {
    for (const server of reason.servers.values())
      found.push((server as { error?: unknown } | undefined)?.error);
  }
  return found;
}

export function classifyDependencyError(root: unknown): DependencyErrorKind {
  const kinds = new Set<DependencyErrorKind>();
  const seen = new Set<unknown>();
  const queue = [root];
  // Bounded walk: causes may be cyclic or deep.
  while (queue.length > 0 && seen.size < 20) {
    const error = queue.shift();
    if (!(error instanceof Error) || seen.has(error)) continue;
    seen.add(error);
    const kind = classifyOne(error);
    if (kind !== undefined) kinds.add(kind);
    queue.push(...relatedErrors(error));
  }
  return (
    dependencyErrorKinds.find((kind) => kinds.has(kind)) ?? 'dependency_failed'
  );
}
