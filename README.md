# API Intelligence & Monitoring — Backend

Private backend for monitoring existing Node.js applications through future metadata-only telemetry and independent active checks. It currently implements the HTTP foundation and the MongoDB and Redis connection lifecycles. There are no domain models, queues, authentication, SDK, external probes, analytics or notifications yet.

This existing Git repository is exclusively the backend. All application files belong directly in its root; do not add a nested `backend/` directory or initialize another Git repository. The React/JavaScript/Vite frontend will have an independent GitHub repository, dependencies, environment configuration and deployment. Both repositories may sit beside each other in a local parent workspace with shared AI instructions. They will communicate through `/api/v1` REST APIs and versioned Socket.IO events; REST remains authoritative. SDK packaging and source location remain undecided.

## Requirements and setup

Use a supported Node.js LTS line matching `package.json` engines and npm. Verified locally with Node.js **22.23.2** and npm **10.9.2**. Runtime dependencies are Express 5, Zod 4, Mongoose 9 and ioredis 6. Starting the server requires a reachable MongoDB and Redis.

**The project uses a Docker-free development and deployment strategy.** Node.js runs directly on your computer; MongoDB Atlas provides the development database and Redis Cloud the development Redis. No containers or local database servers are required. Put their URLs in `.env`, and add your public IP to the Atlas Network Access list. See [docs/infrastructure.md](docs/infrastructure.md#docker-free-environment) for setup pitfalls.

Development uses strict TypeScript, ESLint 10, Prettier, tsx and Node's built-in test runner. Exact dependency versions and the dependency tree are recorded in package.json/package-lock.json.

From this repository root:

```sh
npm ci
cp .env.example .env
npm run dev
```

PowerShell equivalent for the copy is `Copy-Item .env.example .env`. If PowerShell execution policy blocks npm.ps1, use `npm.cmd` in place of `npm`. The npm scripts invoke tools through Node directly so Windows paths containing spaces and `&` work without relying on generated tool command shims.

## Environment configuration

Server startup loads an optional root `.env` with Node's built-in `loadEnvFile`; existing process environment variables take precedence. Zod validates everything before any connection is opened. See `.env.example` for a template.

| Variable                              | Required      | Default | Rule                                                                                            |
| ------------------------------------- | ------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `NODE_ENV`                            | Yes           | —       | `development`, `test` or `production`                                                           |
| `PORT`                                | Yes           | —       | Whole port, 1–65535                                                                             |
| `CORS_ORIGIN`                         | Yes           | —       | Comma-separated exact HTTP(S) origins; no wildcard, `null`, path, credentials or trailing slash |
| `MONGODB_URI`                         | Yes           | —       | `mongodb://` or `mongodb+srv://` with an explicit database name                                 |
| `MONGODB_MAX_POOL_SIZE`               | No            | 10      | 1–100                                                                                           |
| `MONGODB_CONNECT_TIMEOUT_MS`          | No            | 5000    | 500–10000                                                                                       |
| `MONGODB_SERVER_SELECTION_TIMEOUT_MS` | No            | 5000    | 500–30000                                                                                       |
| `REDIS_URL`                           | Yes           | —       | `redis://` or `rediss://`; optional database 0–99; no query or fragment                         |
| `REDIS_CONNECT_TIMEOUT_MS`            | No            | 5000    | 500–30000                                                                                       |
| `REDIS_RECONNECT_MAX_DELAY_MS`        | No            | 5000    | 100–60000                                                                                       |
| `STARTUP_MAX_ATTEMPTS`                | No            | 3       | 1–10 connection attempts per dependency                                                         |
| `WATCHDOG_TOKEN`                      | In production | —       | 32+ random URL-safe characters; blank disables `GET /ready`                                     |

Production should supply actual settings through the environment.

Invalid configuration exits with code 1 and reports only invalid field names, never supplied values. `.env` is ignored; only `.env.example` is intended for Git. Logs contain only fixed events and allowlisted IDs, status, port, dependency name, topology and attempt metadata; raw errors, request headers, bodies, URLs and environment objects are never logged.

## Commands

| Command                    | Purpose                                                   |
| -------------------------- | --------------------------------------------------------- |
| `npm run dev`              | Start tsx watch mode with automatic restart               |
| `npm run build`            | Compile application TypeScript into dist, excluding tests |
| `npm start`                | Run compiled dist/app/server.js; build first              |
| `npm run typecheck`        | Check source and tests without emitting files             |
| `npm run lint`             | Run ESLint                                                |
| `npm run format`           | Format code/config/README; architecture docs are excluded |
| `npm run format:check`     | Verify formatting without edits                           |
| `npm test`                 | Run the full suite; needs no external servers             |
| `npm run test:integration` | Opt-in tests against real development services            |

For compiled production execution, set NODE_ENV=production, run `npm run build`, then `npm start`. No deployment is configured by this step; the future approach is independent Node.js processes under a supervisor such as systemd or PM2, described in [deployment.md](docs/architecture/deployment.md#docker-free-strategy).

## HTTP behavior

`GET /health` returns 200 when the HTTP app is operational, without external services:

```json
{
  "data": { "status": "ok" },
  "meta": {
    "requestId": "server-generated-uuid",
    "asOf": "2026-11-21T00:00:00.000Z"
  }
}
```

```sh
curl http://localhost:5000/health
```

`GET /live` retains the architecture's minimal `{ "status": "alive" }` response. Neither endpoint indicates dependency readiness.

`GET /ready` reports MongoDB and Redis availability. It requires `Authorization: Bearer <WATCHDOG_TOKEN>` and does not exist when no token is configured. It returns 200, or 503 with `Retry-After`:

```json
{
  "data": {
    "status": "not_ready",
    "dependencies": { "mongodb": "available", "redis": "unavailable" }
  },
  "meta": {
    "requestId": "server-generated-uuid",
    "asOf": "2026-11-21T00:00:00.000Z"
  }
}
```

Unknown routes return 404:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Resource not found",
    "retryable": false
  },
  "requestId": "server-generated-uuid"
}
```

Responses follow [implementation-contracts.md](docs/architecture/implementation-contracts.md), taking precedence over the illustrative success/message envelope in the implementation request. Request IDs are generated by the server, returned in X-Request-Id, and never taken from arbitrary client input. AppError carries safe operational messages/codes; centralized middleware maps malformed JSON to 400, oversized JSON to 413, unsupported encoding to 415, disallowed Origin to 403, unknown routes to 404 and unexpected errors to a generic 500. Internal messages and stacks are never exposed in any mode. Express 5 forwards rejected async controllers automatically, so no catchAsync wrapper is needed.

JSON parsing is limited to 256 KiB with decompression disabled. No form endpoints exist, so URL-encoded parsing is omitted. Exact Origin allowlists are enforced; originless server-to-server requests are supported. CORS currently permits GET/HEAD/OPTIONS and Content-Type; credentialed CORS and domain mutations are deferred to reviewed authentication work. CORS is not authentication. Express identifying headers/ETags and proxy trust are disabled, with basic response security headers. Reverse proxy/TLS policy remains future deployment work.

HTTP startup limits headers to 16 KiB, header receipt to 5 seconds, request receipt to 10 seconds and inactive sockets to 15 seconds. SIGINT/SIGTERM stop accepting requests, close idle connections and drain for at most 10 seconds before forced closure and exit 1, then close Redis and MongoDB, within 16 seconds overall. Normal shutdown exits 0; an unclean one exits 1; startup failures and fatal process exceptions/rejections exit nonzero with sanitized logs. A supervisor is responsible for restarting a failed production process.

## Structure and architecture scope

```text
docs/architecture/                # Eight existing authoritative documents
docs/infrastructure.md           # MongoDB and Redis behavior, outages and limits
src/app/
  config/                        # Environment, MongoDB and Redis managers
  middlewares/                   # Error, not-found and watchdog credential
  modules/health/                # Health, liveness and readiness
  routes/index.ts
  utils/                         # Errors, dependency lifecycle, allowlisted logger
  app.ts                         # Side-effect-free Express factory
  bootstrap.ts                   # Startup and shutdown lifecycle
  server.ts                      # Process entry point
src/tests/                       # Unit, protocol-level and process tests
eslint.config.js
tsconfig.json
tsconfig.build.json
package.json
package-lock.json
```

ESM (`type: module`) and NodeNext module resolution use explicit .js import paths that resolve to TypeScript during development and compiled JavaScript in production. ES2023 targets the tested LTS runtime. Strict mode, unchecked-index protection and exact optional-property checks apply to source and tests; builds exclude tests and emit only into ignored dist. No unnecessary empty interfaces, models, services or async wrappers are created.

The [architecture foundation scope](docs/architecture/implementation-contracts.md#exact-phase-2--step-1-implementation-scope) also includes the migration runner, worker/scheduler entry points and heartbeats, which remain deferred. The src/app layout replaces illustrative architecture paths. Architecture documents are unchanged except for the Docker-free deployment revision. Connection behavior, its limits and how to run integration tests are described in [docs/infrastructure.md](docs/infrastructure.md).

Tests cover health envelopes, liveness, unknown routes, exact CORS, parser bounds, async/operational errors, log sanitization, invalid settings, occupied ports, graceful signal handlers, MongoDB/Redis connection lifecycles and readiness. The suite runs the real drivers against loopback protocol stand-ins; these verify client behavior, not MongoDB or Redis themselves. On Windows, lifecycle tests invoke Node signal events through IPC because Windows child termination does not deliver POSIX signals. They exercise the actual server handlers; native OS signal delivery remains a host-level verification.
