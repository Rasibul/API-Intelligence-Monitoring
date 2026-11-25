# MongoDB and Redis connections

How the API process connects to its dependencies, what happens when they fail, and which settings still need measurement. Design authority remains `docs/architecture/`; this describes what is implemented.

## Docker-free environment

**The project uses a Docker-free development and deployment strategy.** Node.js runs directly on the computer through npm scripts. MongoDB Atlas provides the development database and Redis Cloud the development Redis. No containers or local database servers are required. Future deployment runs the API, workers and scheduler as independent Node.js processes under a supervisor such as systemd or PM2; MongoDB and Redis may stay managed. See [deployment.md](architecture/deployment.md#docker-free-strategy).

Managed service setup:

- **Atlas:** the URI must include a database name, and the client's public IP must be in the project's Network Access list. An unlisted IP is refused during the TLS handshake (alert 80), so it is logged as `dependency_tls`, not as an authentication failure.
- **Redis Cloud:** `REDIS_URL` is only the URL. The console's copied command begins with `redis-cli -u`, which must be removed or startup fails with `Invalid environment configuration: REDIS_URL`. Use `rediss://` when the endpoint has TLS enabled; a `rediss://` URL against an endpoint without TLS fails as `dependency_tls`. Plaintext `redis://` sends the password unencrypted over the internet.
- **Before BullMQ:** the Redis instance must use `noeviction` and persistence, as the architecture requires.

## Libraries

| Package    | Version | Why                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mongoose` | 9.12.3  | The approved architecture specifies Mongoose models with explicit indexes. It bundles the matching `mongodb` 7.8 driver, so the driver is not a direct dependency. 9.13.x was under three days old when selected.                                                                                                               |
| `ioredis`  | 6.1.0   | BullMQ requires `ioredis >= 5` and its current release is developed against 6.x, so one client library serves both. 6.1.0 rather than 6.0.0 because it fixes behavior used here: ending cleanly when closed while reconnecting, reusing a client after it ended, and redacting credentials from the command attached to errors. |

Both support the Node.js versions in `package.json`. Versions are pinned exactly.

## MongoDB

One client per process, on Mongoose's default connection, so later models attach to it without opening another pool.

| Option                     | Value                                 | Effect                                                             |
| -------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `maxPoolSize`              | `MONGODB_MAX_POOL_SIZE` (10)          | Pools multiply by process; the architecture budgets 10 for the API |
| `minPoolSize`              | 0                                     | Connections open on demand                                         |
| `waitQueueTimeoutMS`       | 2000                                  | Bounds waiting for a pooled connection                             |
| `connectTimeoutMS`         | `MONGODB_CONNECT_TIMEOUT_MS` (5000)   | Per socket connection                                              |
| `serverSelectionTimeoutMS` | `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | Bounds finding a usable server                                     |
| `socketTimeoutMS`          | 10000                                 | Bounds a stalled operation                                         |
| `bufferCommands`           | false                                 | Operations fail during an outage instead of accumulating           |
| `autoIndex`, `autoCreate`  | false                                 | Schema changes come only from reviewed migrations                  |

These are passed as options, which take precedence over the same settings in the URI. Startup runs `listCollections` (not `ping`) because `ping` succeeds without credentials on a server that requires them.

**Standalone versus replica set.** Transactions require a replica set or sharded cluster; a standalone server rejects them. The durable ingestion, processing and incident designs depend on transactions, so a standalone server is not a compatible deployment. Nothing transactional exists yet, so startup does not reject a standalone server. It logs `topology` as `standalone`, `replica_set` or `sharded`; the step that introduces the first transaction must turn this into a startup requirement. A single-node replica set supports transactions but has no redundancy.

**Reconnection** is performed by the driver's own monitoring. Outage and recovery are logged once each, whether a driver event or a readiness check notices first.

**Operation deadlines.** Later queries must pass `timeoutMS` or `maxTimeMS` according to their endpoint's budget. Without one, the driver can wait indefinitely to write to a socket whose peer has just disappeared.

## Redis

One general-purpose client per process.

| Option                          | Value                                                           | Effect                                            |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| `connectTimeout`                | `REDIS_CONNECT_TIMEOUT_MS` (5000)                               | Per connection attempt                            |
| `commandTimeout`                | 2000                                                            | Per command                                       |
| `disconnectTimeout`             | 1000                                                            | Destroys a closing socket whose peer ignores it   |
| `socketTimeout`                 | 10000                                                           | Replaces a half-open socket that never answers    |
| `enableOfflineQueue`            | false                                                           | Commands fail during an outage; no memory growth  |
| `maxRetriesPerRequest`          | 0                                                               | In-flight commands fail when the connection drops |
| `autoResendUnfulfilledCommands` | false                                                           | Ambiguous commands are never silently repeated    |
| `retryStrategy`                 | 200 ms, doubling to `REDIS_RECONNECT_MAX_DELAY_MS`, with jitter | Active only after a successful startup            |
| `protocol`                      | 2                                                               | RESP3 push-based endpoint handoffs are not used   |

Query parameters in `REDIS_URL` are rejected because ioredis would apply them as client options and could override these bounds.

**BullMQ needs separate connections.** Workers use blocking commands and require `maxRetriesPerRequest: null`, so they wait through an outage. This client does the opposite: it fails at once so a request never hangs. Workers must also not share a `commandTimeout` or `socketTimeout` shorter than their blocking time. Queue producers may use settings like the ones here. Do not reuse or `duplicate()` this client for a worker without overriding these options.

## Startup, readiness and outages

Startup readiness is a gate; ongoing readiness is a report.

| Phase              | MongoDB or Redis unavailable                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Startup            | Up to `STARTUP_MAX_ATTEMPTS` attempts with backoff, then opened resources are closed and the process exits 1. HTTP never listens |
| Startup, permanent | Authentication, TLS and configuration failures stop after one attempt                                                            |
| Running            | The process stays up and reconnects. `/live` and `/health` still return 200; `/ready` returns 503; operations fail promptly      |
| Recovery           | Automatic; `/ready` returns 200 after the next successful check                                                                  |

Both dependencies are currently required at startup. The architecture allows the API to start without Redis once bounded local admission limits exist; revisit this with ingestion.

### `GET /ready`

Requires `Authorization: Bearer <WATCHDOG_TOKEN>`. Without the variable the route does not exist (404); in production the variable is mandatory. The token is the application half of the control: the architecture also requires a network restriction, which must be enforced at the reverse proxy or firewall, and the path should not be published there.

Checks share a one-second deadline, are coalesced while one is running, and are cached for one second. The response contains dependency names and `available`/`unavailable` only. The fuller `GET /api/v1/platform/readiness` contract (capabilities, heartbeat ages, administrator access) is not implemented yet.

## Shutdown

`SIGINT`, `SIGTERM` or a fatal error: stop accepting HTTP and drain (10 s), then close Redis, then MongoDB (2.5 s each), within 16 s overall. A signal during startup cancels it. Exit code 0 means everything closed; a forced drain, a failed close, a fatal error or the overall deadline gives 1 and is logged.

Known driver limitation: if MongoDB disappears at the instant of shutdown, the driver can wait forever while ending sessions. The 2.5 s limit applies, the failure is logged as `dependency_close_failed`, and the process exits 1.

## Settings that need load testing

`MONGODB_MAX_POOL_SIZE`, the wait-queue, socket and command timeouts, `REDIS_RECONNECT_MAX_DELAY_MS`, the readiness deadline and cache, and the shutdown budgets are pilot values chosen without traffic measurements. The architecture's drain budget is 30 s; the existing 10 s HTTP drain was kept because no background jobs exist yet. A supervisor's stop timeout must exceed 16 s: systemd's default of 90 s is sufficient, PM2's default `kill_timeout` of 1.6 s is not.

## Integration tests

`npm test` uses the real Mongoose and ioredis clients against loopback protocol stand-ins and needs no servers or network. `npm run test:integration` connects to real **development** services, only when these variables are set in the shell; it never reads `.env` and never writes data. It connects, pings and closes, and tries one wrong Redis password.

```sh
export INTEGRATION_MONGODB_URI='<development Atlas URI with a database name>'
export INTEGRATION_REDIS_URL='<development Redis Cloud URL>'
npm run test:integration
```

In PowerShell set the variables with `$env:NAME = '...'`. A test whose variable is unset is skipped. Never point it at production.
