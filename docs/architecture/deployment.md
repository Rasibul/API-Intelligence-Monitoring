# Deployment, capacity and recovery

## Initial topology

Vercel serves the React/Vite static application. The browser connects directly to the Docker-compatible VM API and Socket.IO TLS hostname; no monitoring workers or scheduler run on Vercel. Keep frontend JavaScript, public API origin and build metadata there; no database, JWT-signing, Resend or ingestion secrets in Vite environment output.

One Docker-compatible VM initially hosts a TLS reverse proxy, API process, worker process, scheduler process and Redis. Use Docker Compose with separate API, worker and scheduler services, restart policies, memory/CPU limits and persistent volumes. The VM provider is unselected; Oracle is only a candidate. No Kubernetes. Run processes as non-root, expose only the proxy, and give each process its own health/freshness signal. A worker restart does not restart HTTP; a scheduler failure is visible even while `/live` succeeds.

| Process | Startup dependencies | Operational behavior |
| --- | --- | --- |
| API | Valid config, MongoDB for durable/auth routes; Redis optional only with bounded fallback | Bounded HTTP intake; readiness reflects durable ingestion and admin capabilities separately |
| Worker | MongoDB and Redis | Separate queue pools/concurrency; dependency circuits and bounded job shutdown |
| Scheduler | MongoDB; Redis needed to dispatch | Create finite durable due work; reconcile when Redis returns; never run from route handlers |
| Redis | Persistent storage and memory budget | AOF with every-second fsync initially, `noeviction`, authenticated private access, supervised restart |
| External watchdog | Separate host/network/notification route | Monitor API reachability plus worker/scheduler/processing freshness, not just HTTP 200 |

One API replica initially avoids distributed Socket.IO fan-out and fallback-rate-limit complexity. Workers publish invalidations over Redis pub/sub to that API. If later adding API replicas, introduce shared authorization/admission behavior, a suitable Socket.IO adapter, and sticky routing when long-polling is enabled. Treat this as measured scaling work, not initial scope.

Oracle free capacity, limits and reclamation conditions must be verified in the selected region/account before deployment. Do not assume a particular free shape exists or that a free VM supplies a production SLA. Keep configuration portable to another VPS. [Oracle Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

## MongoDB decision

| Option | Advantages | Costs / limitations |
| --- | --- | --- |
| Self-managed replica set on separate infrastructure | Strict self-hosting, control, isolation from monitoring VM | Administration, backups, TLS and multiple failure domains cost resources |
| Self-managed single-node replica set, initially on VM or separate host | Low cost; compatible transactional topology for pilot | No failover; co-location competes for RAM/disk and loses every component together |
| Managed MongoDB replica set | Managed operations/backups depending on plan, independent VM failure domain | External data processing, quota/network cost; not strictly fully self-hosted; requires explicit acceptance of that trade-off |

Recommend a self-managed replica set separate from the API VM if strict self-hosting is required and resources allow. A budget pilot may use a single-node replica set with a clearly accepted availability risk and off-host backups; that is not a high-availability production recommendation. Do not select a managed free tier merely because traffic is unknown. Evaluate current storage, connection, transaction, backup, network and suspension limits against measured load. No specific provider/plan is selected in Step 2.

Budget RAM before choosing co-location: operating system/proxy, API heap/native memory, worker heap, scheduler, Redis dataset plus AOF rewrite/fork headroom, and MongoDB cache/index/transaction memory. Set independent process/connection-pool limits; Mongoose pools multiply across processes. A small VM can be incapable of this topology even when low average CPU looks acceptable. Start with low concurrency and profile actual resident memory.

## Failure handling and recovery

| Failure | User/SDK behavior | Recovery and observable evidence |
| --- | --- | --- |
| Monitoring API or network unavailable | Production requests finish; SDK buffers/retries within limits, then counts drops | Jittered SDK recovery; external watchdog alerts; last heartbeat and gaps displayed |
| MongoDB unavailable | Ingestion returns 503, no 202; admin/auth fails closed; workers/scheduler pause durable operations | Bound Mongoose operation buffering/timeouts; reconnect, check transactions/leases and resume; no unbounded driver buffer |
| Redis unavailable | API may accept into finite Mongo inbox using conservative fallback quotas; no false processed claim | Stop dispatch; sockets use REST polling; recreate jobs from durable pending state when Redis returns |
| Mongo inbox/Redis near budget | 429 for ingestion pressure, 503 for storage unavailability; SDK backoff then finite loss | Pause low-priority work, drain fairly; expose queue age, counts, bytes and drops; never enlarge limits automatically |
| Worker crashes mid-transaction | Job can retry; uncommitted data invisible | Transaction rollback, BullMQ stalled recovery and Mongo unique guards; do not duplicate counts |
| Worker commits then crashes before queue acknowledgement | Duplicate execution possible | Receipt/event uniqueness makes replay a no-op; publish invalidation best effort; REST still correct |
| Scheduler stops | No fresh checks/evaluations; dashboard becomes stale/unknown | Separate heartbeat alarm; restart reconciles current work, records skipped slots, no probe storm |
| Redis loses queued jobs | Durable inbox/check runs/outbox still authoritative | Reconcile pending/leased records, recreate the fixed wake-up jobs and reclaim expired durable leases; already processed receipts not replayed |
| Redis memory/persistence error | Queue command fails; no eviction of BullMQ internals | Pause dispatch and alert; investigate actual bytes, persistence/disk, resume after recovery |
| Resend unavailable or throttled | Incident still commits and appears in UI | Durable finite outbox retries/cooldown; provider error counters; separate watchdog channel for platform outage |
| Monitoring VM lost | All local processes unavailable; SDK eventually drops telemetry | External alarm, rebuild from documented config and off-host backup; report irrecoverable telemetry gap |
| Disk nearly full | Fail new acceptance before storage failure; no silent retention truncation | External disk alerts, capacity/admission thresholds, staged cleanup and restore validation |

MongoDB buffering should be disabled or strictly bounded for runtime models; use server-selection, socket and operation deadlines appropriate to the endpoint budget. HTTP server deadlines must exceed the short bounded durable commit path but must not allow stalled transactions to occupy every connection. Producer Redis clients fail promptly with offline queues disabled/bounded; worker connections reconnect according to BullMQ requirements. Never use infinite API retries.

An accepted MongoDB receipt is recoverable while its durable data survives and remains within the 24-hour pending policy. With Redis AOF every-second persistence, recent queue mutations can be lost on crash; Recreated wake jobs rediscover MongoDB work, but cannot recover lost MongoDB data. A journaled majority commit means durability only for the actual replica topology: a single-node replica set has no protection against disk/host loss. Never promise zero telemetry loss.

## Operations and self-observability

Expose minimal unauthenticated liveness without versions, credentials or dependency details. Keep detailed readiness and diagnostics behind admin/VPN/watchdog credentials. Dependency checks are bounded and cached briefly so health probes cannot amplify an outage. Separate API acceptance readiness, analytics freshness and scheduler/worker readiness. A healthy HTTP process does not imply healthy monitoring.

Record process heartbeat every 15 seconds; stale after 60 seconds. Report ingestion accepted/rejected/dropped counts, event/byte rate, queue health, durable backlog depth/age and quota utilization, terminal failures, transaction conflicts, processing watermark, dirty-window age, probe schedule lag, notification failures, heap/RSS/event-loop lag, disk and Mongo/Redis health. Restrict label cardinality. Use sanitized rotating local logs with finite disk quotas and externally observed platform metrics. Do not depend solely on this platform's own incident engine to alert on its failure.

Shutdown order: stop accepting/claiming new work, drain short API requests and sockets, finish or abandon jobs within a finite grace (initially 30 seconds), commit or roll back active transactions, then close queue/Redis/Mongo connections. A timed-out drain leaves leases/jobs for recovery. Scheduler stops claims before exit. Supervisors restart with jitter/backoff to avoid hot crash loops.

Deploy backward-compatible schema/contract changes first, then worker/scheduler, API and frontend, with SDK releases independently versioned. Support a documented previous telemetry schema during rollout. Apply indexes/migrations explicitly; no automatic destructive sync. Keep rollback artifacts and preserve unknown-version jobs safely rather than retrying poison payloads indefinitely. Verify `/live`, protected readiness, fresh worker/scheduler heartbeat, a synthetic ingestion receipt and a safe canary monitor after deployment.

Proposed pilot objectives, subject to budget: detect external platform loss within 2 minutes, recover from a process crash within 2 minutes, and rebuild a lost VM within 4 hours. Off-host encrypted daily backups imply up to 24 hours of data loss after catastrophic MongoDB loss; better RPO requires more frequent backups/oplog strategy and a redundant database. Test restores before calling the system production-ready. Keep Resend/provider credentials and restore keys recoverable outside the failed VM.

## Estimate volume before traffic is known

First use read-only existing VPS/proxy counters/log aggregates if available and approved; do not add instrumentation to production in this step. Inventory route count, process count, health endpoints and known peak periods. Later run a bounded staging/canary SDK pilot for 24–72 hours, then observe at least a full week including peaks. Measure per-project RPS, p95/peak bursts, bytes/event (wire and BSON), errors, route/group cardinality, queue bytes, processing throughput, index size and compression.

Let total fleet mean traffic be R requests/second, metric sample probability s, encoded event bytes b, error fraction e, and safe error-extra bytes x:

- Request events/day = `86,400 × R × s`.
- Approximate request payload bytes/day = `86,400 × R × s × b`; add error detail `86,400 × R × e × errorDetailSampling × x`, heartbeats and envelope overhead separately.
- Batch jobs/day is between payload bytes / byte batch cap and events / event batch cap, plus timer-triggered partial batches per process. Do not assume batches are always full.
- Raw disk ≈ measured `(BSON bytes + index bytes per event) × retained event count`, plus error collections, receipts, aggregates, oplog/journal and free-space margin.
- Minute windows/day ≈ `1,440 × active(project/environment/scope combinations)`. Multiply by measured histogram record size and 7-day minute retention; sparse creation and coarser retention matter.
- Pending backlog growth ≈ `max(0, arrival rate − processing rate) × elapsed seconds`; count and byte caps still take precedence.
- Drain time after outage ≈ `backlog events / (sustained processing rate − live arrival rate)`; if the denominator is ≤0, recovery cannot catch up.

Illustrative fleet-wide volumes at s=1 and b=600 bytes, decimal GB, excluding all storage/index/replication/error overhead:

| Mean fleet RPS | Events/day | Payload GB/day | Seven-day payload GB |
| --- | ---: | ---: | ---: |
| 1 | 86,400 | 0.052 | 0.363 |
| 10 | 864,000 | 0.518 | 3.629 |
| 100 | 8,640,000 | 5.184 | 36.288 |
| 1,000 | 86,400,000 | 51.840 | 362.880 |

At 100 RPS and 600 bytes/event, a 128 MiB inbox holds roughly 37 minutes of payload before overhead, not 24 hours. At 1,000 RPS it holds roughly 3.7 minutes. The 24-hour policy is a maximum age, not a storage guarantee. Fixed Redis wake queues and raw histograms add further cost. Real BSON/index footprint must be measured; do not present an assumed compression ratio as a guarantee.

Require sustained measured worker throughput above observed peak admitted traffic, preferably at least 2× for recovery, without breaking CPU/memory/DB budgets. Test burst admission and maximum-size events, not only averages. If the VM cannot meet budget, reduce retention/detail, use explicitly labeled uniform sampling, move MongoDB/CPU-heavy workers, or buy a larger VPS. Maintain data quality visibility whenever collection changes.

## Step 2 deployment gates

Prefer a managed replica-set deployment if its verified quotas, backup capability, privacy policy and budget fit the measured pilot; otherwise a self-managed single-node replica set is a budget pilot option with acknowledged host/disk loss and no failover. A managed free plan is not presumed to include backups, sufficient transactions/connections/storage or an availability commitment. For either option validate transaction support with an actual commit/rollback drill, restore an encrypted off-host backup and measure disk/index growth before production. MongoDB selection remains open; do not silently substitute standalone MongoDB.

Bound total Mongo connection pools initially to 10/API, 10/worker and 5/scheduler; verify against the selected plan. Disk warning 70%, reject new intake at 85% of the allocated data budget or if remaining space cannot cover maintenance/journal headroom. Redis memory warning 70% and stop new dispatch at that threshold pending investigation. Docker memory/CPU numbers remain unassigned until actual VM RAM is known; their review is a deployment gate, not an implicit unlimited setting. Cap rotating logs to 100 MiB per process and queue event streams to 1,000 entries per queue (verify trimming on the selected BullMQ version).

Daily encrypted off-host logical backups require a consistent replica-set-aware snapshot/oplog procedure; a naive live multi-collection dump is insufficient for cross-collection correctness. Retain seven successful daily backups, alert on age >26 hours, test monthly restore and after migration. Record included collections, encryption-key custody and restore duration. Backups must include durable inbox/outbox and configuration; telemetry can be excluded only with an explicit recovery gap. Resend requires a verified sender and verified account limits; queue attempts obey rate caps and cannot guarantee delivery. Vercel serves static assets only; no scheduled probes/workers there. No free provider is assumed always on; keep a paid/fallback VM and backup budget decision open.
