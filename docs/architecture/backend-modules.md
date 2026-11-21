# Backend feature architecture

## Required layering

Use a single backend package with feature folders. For request-driven features, preserve **Model → Service → Controller → Route** as the construction/layering convention; runtime calls flow Route → Controller → Service → Model. Models own Mongoose schemas, indexes and persistence definitions. Services own business logic and transactions. Controllers adapt HTTP input/output. Routes define endpoints and attach authentication/validation middleware. Zod contracts live in validation files; TypeScript types live in interfaces files.

Workers and scheduled jobs call exported services directly. Never call the application's own HTTP API to reuse business logic. A service never depends on Express request/response, Socket.IO socket objects or a queue processor. Cross-feature calls use documented service exports; do not reach into another feature's models or create circular feature dependencies. The module owning a workflow coordinates any cross-feature transaction through service methods accepting the same database session.

## Proposed structure (illustrative paths only)

| Area | Proposed contents |
| --- | --- |
| `backend/src/modules/<feature>/` | `<feature>.model.ts`, `.service.ts`, `.controller.ts`, `.route.ts`, `.validation.ts`, `.interface.ts` as applicable |
| `backend/src/modules/<feature>/workers/` | Thin queue adapters calling the feature service; no business decisions |
| `backend/src/modules/<feature>/jobs/` | Thin scheduled adapters calling the feature service |
| `backend/src/bootstrap/` | Separate API, worker and scheduler composition roots; connection startup and graceful shutdown |
| `backend/src/config/` | Validated environment settings, security limits and process-specific configuration |
| `backend/src/infrastructure/` | Mongo connection, Redis/BullMQ connections, Resend transport, pub/sub and HTTP probe transport adapters |
| `backend/src/middleware/` | Generic HTTP auth/validation/error adapters, request IDs, parser bounds and origin enforcement |
| `backend/src/shared/` | Small safe primitives: clock, identifiers, bounded pagination, error types and logger; no business dumping ground |
| `sdk/src/` | Client, timing/error middleware, safe metadata, bounded buffer, batch transport, interfaces and versioned contracts |
| `frontend/src/features/` | Auth, projects, overview, endpoints, errors, monitors, incidents and settings in JavaScript |
| `docs/architecture/` | This design set; later contract and operations documents link here |

Do not create empty model/controller/route files for worker-only adapters or invent an HTTP layer for background execution. Backend and SDK may share a minimal versioned telemetry contract package later if duplication becomes harmful; the frontend stays JavaScript. Do not introduce a generic repository abstraction unless a concrete need appears; Mongoose models stay behind feature services.

## Feature ownership

| Feature | Models / business responsibilities | HTTP responsibility |
| --- | --- | --- |
| `auth` | Admin accounts, bcrypt verification, sessions, JWT issuance, strict refresh rotation/reuse detection, bootstrap/reset policy | Login, refresh, logout, session list/revoke; no public registration |
| `projects` | Monitored apps, bounded environments, route registry, lifecycle and safe configuration | Project/environment management |
| `api-keys` | High-entropy key issuance, hashing, scope, rotation, revocation and audit | Create/show-once/list-metadata/rotate/revoke |
| `ingestion` | Strict intake, sanitization, durable receipts, quotas, deduplication and transactional processing | Bounded batch acceptance and heartbeat intake in the same envelope |
| `telemetry` | Request-event persistence, quality counters and safe raw-event pagination | Authorized filtered event views |
| `analytics` | Metric windows, histogram construction/merge, exact-query limits and aggregate freshness | Overview, route metrics and latency distribution reads |
| `errors` | Safe occurrences, fingerprinting, group counts/status and bounded examples | Group list/detail and operator triage |
| `monitors` | Endpoint policy, configuration and active-check run/result lifecycle | Monitor configuration and check history |
| `alerts` | Versioned rules, evaluation state, breach/recovery/hysteresis and maintenance | Rule management and evaluation evidence |
| `incidents` | Single active incident, transitions, acknowledgement, timeline and administrative closure | Incident history/detail/acknowledge |
| `notifications` | Durable outbox, provider retries, idempotency and minimal templates | Delivery status, controlled replay and recipient configuration |
| `realtime` | Sanitized domain invalidations, room authorization and bounded fan-out | Socket handshake/event adapters; no telemetry ingestion over sockets |
| `platform` | Dependency status, process heartbeats, queue/backlog visibility, maintenance leases and budgets | Minimal public liveness; protected readiness/diagnostics |
| `audit` | Append-only privileged-action history with sanitized metadata | Authorized audit reads |

All identities are project/environment scoped where relevant, including keys, telemetry, errors, monitors, aggregates, rules and incidents. There is no tenant ID. An environment is a project-owned record with stable ID and a bounded name enum chosen by the administrator; no arbitrary telemetry-created environments.

## Workflow boundaries

- IngestionService coordinates receipt acceptance with budget storage; processing coordinates TelemetryService, ErrorsService and AnalyticsService in one bounded transaction.
- AnalyticsService produces finalized metric snapshots; AlertsService reads these through the service API, then calls IncidentsService and NotificationsService in one incident-transition transaction.
- MonitorsService owns SSRF policy and probe execution; a transport adapter cannot bypass destination validation. Scheduler adapters call MonitorsService to claim due runs.
- NotificationsService owns Resend semantics. Queue adapters never send directly or reconstruct email bodies from unsanitized data.
- RealtimeService receives safe committed change descriptions. Failure to publish cannot roll back a committed business operation.

## Process composition and error policy

The API process mounts routes and Socket.IO only. The worker registers queue consumers only. The scheduler registers finite periodic reconciliation loops only. Bootstrap and migrations are explicit administrative operations, not HTTP startup side effects. Disable production Mongoose automatic index creation; apply reviewed index migrations before enabling dependent features.

Validate process-specific configuration at startup. Use typed operational errors, bounded database/transport timeouts, structured logs with correlation IDs and no credentials. Controllers map operational failures consistently; worker adapters classify retryable versus terminal failures. Programmer errors or unknown process corruption trigger a sanitized fatal log, bounded shutdown and supervisor restart; do not continue blindly after an uncaught exception.

Backend tests focus on guarantees: transaction replay, authorization, bounded admission, incident races, statistical correctness and outage behavior. SDK tests additionally measure overhead and error/response transparency. Feature ownership must be checked during review so controllers, workers and cron callbacks do not accumulate business logic.

## Step 2 implementation boundary

Keep the feature ownership above; do not create separate deployments or a generic workflow engine per feature. `platform` owns bounded wake-up producers and shared lease mechanics; each feature owns durable work selection and retry state. `ingestion` owns inbox quota transactions; `analytics` owns dirty generation rebuilds. Worker adapters never infer business completion from queue state. [Implementation contracts](implementation-contracts.md) defines exact DTOs and the narrowly bounded Phase 2 - Step 1 scope. Exact percentile background queries, hourly rollups, reminders, multi-admin permissions and sampling estimation are deferred.
