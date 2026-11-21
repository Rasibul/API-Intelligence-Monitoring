# Database design, analytics and retention

## Storage choice and conventions

Use ordinary MongoDB collections with explicit Mongoose models initially. Regular collections simplify unique event indexes, bounded transactions, error relationships and selective deletes. Do not start with MongoDB time-series collections or sharding. ObjectIds identify configuration records; telemetry carries random event/batch IDs scoped to a project/environment. Use BSON UTC dates and half-open time windows `[start, end)` throughout. Store monotonic duration as an integer number of microseconds; presentation may use milliseconds. Store event occurrence, server receipt and processing times separately.

This design requires MongoDB replica-set transaction support for acceptance quotas, replay-safe processing and incident/outbox commits. A single-node replica set can support the development topology but provides no replica redundancy. Production preference is a properly secured multi-node replica set across failure domains. Standalone MongoDB is not a compatible substitute. [MongoDB transactions](https://www.mongodb.com/docs/manual/core/transactions/) and [replication](https://www.mongodb.com/docs/manual/replication/).

Notation: `U` means unique, `P` partial filter, `TTL` single-field `expiresAt` with expiry of zero seconds. Index direction is ascending unless `desc` is stated. Treat indexes below as the initial query-driven set; measure actual query plans before adding more. Foreign references are enforced by services, not MongoDB foreign-key constraints.

## Collections and indexes

| Collection | Main fields and relationships | Required indexes | Retention |
| --- | --- | --- | --- |
| `admins` | Normalized login/email, bcrypt hash, enabled, password version, timestamps | U(normalizedLogin) | Until explicit deletion; no account signup |
| `admin_sessions` | adminId, session/family ID, hashed current refresh token, previous token reuse evidence, rotation version, expiry, revokedAt | U(sessionId); (adminId, createdAt desc); TTL | 30-day absolute maximum; 7-day inactivity; expiry checked synchronously |
| `projects` | Unique stable slug, name, enabled, bounded config version | U(slug) | Explicit archive/delete workflow |
| `environments` | projectId, stable name, enabled | U(projectId, name) | Project lifecycle |
| `api_keys` | Public key ID, secret digest, hash version, projectId, environmentId, scope, expiry, revokedAt, rotation relationship | U(keyId); (projectId, environmentId, createdAt desc) | Revoked metadata 90 days; no plaintext key |
| `ingestion_receipts` | projectId, environmentId, batchId, canonical hash, finite sanitized payload, payloadBytes, min/max event time, state, receive/lease/replay times, attempt count, failure code | U(projectId, environmentId, batchId); (state, nextAttemptAt, leaseUntil); (deleteAfter) for explicit terminal cleanup; no receipt TTL | Pending payload max 24 hours via explicit expiry service; terminal compact receipts 48 hours after terminal transition |
| `request_events` | eventId, project/environment, routeKey, method, statusCode, outcome, durationUs, occurredAt, receivedAt, sampleProbability, bootId, approved release | U(projectId, environmentId, eventId); (projectId, environmentId, occurredAt desc); (projectId, environmentId, routeKey, occurredAt desc); TTL | 48-hour query visibility; physical dedupe at least 72 hours from original receipt |
| `sdk_states` | project/environment, bootId, lastSequence, cumulative observed/selected/drop counters, heartbeatAt, source quality | U(projectId, environmentId, bootId); (projectId, environmentId, heartbeatAt desc); TTL | 7 days after last server heartbeat; roll interval deltas into quality metrics first |
| `metric_windows` | project/environment, optional route/method scope, granularity, start/end, generation, count/sum/min/max, status counts, histogram/schema, source quality, completeThrough | U(projectId, environmentId, scopeKey, population, granularity, windowStart); (projectId, environmentId, granularity, windowStart); TTL | Minute 7 days initially; hourly rollups deferred |
| `aggregation_tasks` | Window key, requested/applied generation, lease/fence, dirty state | U(windowKey); (dirty, nextAttemptAt); (deleteAfter) explicit counted cleanup, no TTL | Completed 48 hours; pending max 24 hours then explicit stale failure |
| `error_occurrences` | eventId equals requestEventId, requestEventId, project/environment, fingerprint, safe code/type; frames deferred, occurredAt, receivedAt, release | U(projectId, environmentId, eventId); (projectId, environmentId, fingerprint, occurredAt desc); TTL | 7 days from receipt |
| `error_groups` | project/environment, versioned fingerprint, routeKey, safe summary, lifetime occurrence count, first/lastSeen, triage status, bounded sample IDs | U(projectId, environmentId, fingerprintVersion, fingerprint); (projectId, environmentId, lastSeen desc); TTL | Expire after 30 days inactivity; count describes current group lifetime, not all-time application errors |
| `monitors` | project/environment, approved URL and destination policy, interval, expected status, enabled, nextDueAt, lease/version | (enabled, nextDueAt); (projectId, environmentId) | Explicit lifecycle; archive preserves incident context |
| `check_runs` | monitorId, scheduledFor, policy version, state, lease/fence, start/finish, outcome, latency, safe failure code | U(monitorId, scheduledFor); (state, nextAttemptAt); (monitorId, scheduledFor desc); TTL on terminal | 7 days; missed/expired runs remain explicit results |
| `alert_rules` | project/environment, kind, filter, thresholds, sample minimum, windows, recovery, cooldown, enabled, immutable version history/reference | (enabled, nextEvaluationAt); (projectId, environmentId) | Until archive; retain incident-linked rule snapshots |
| `alert_states` | ruleId, scopeKey, version, evaluatedThrough, breach/recovery streak, activeIncidentId, freshness | U(ruleId, scopeKey) | Rule lifecycle; bounded evaluation evidence |
| `incidents` | ruleId, scopeKey, isActive, state, version, opened/acknowledged/resolved times, safe evidence, rule snapshot, priorIncidentId | U(ruleId, scopeKey) P(isActive=true); (projectId, environmentId, openedAt desc); TTL on resolved only | Resolved 90 days; active never TTL-expired |
| `incident_events` | incidentId, transition/evaluation identity, timestamp, actor ID, safe evidence/reason | U(incidentId, eventKey); (incidentId, createdAt); TTL aligned with incident | 90 days after resolution |
| `notification_outbox` | incidentId, transitionVersion, channel, reminderSlot, recipient config ID, minimal template data, state, lease, attempt, provider ID | U(incidentId, transitionVersion, channel, reminderSlot); (state, nextAttemptAt); TTL on terminal | Pending max 24 hours; terminal 30 days |
| `audit_logs` | actor, privileged action, target, time, safe changed-field names and result | (createdAt desc); (actorId, createdAt desc); TTL | 90 days |
| `platform_state` | Stable key for quotas, leases, process heartbeat, bounded diagnostics and backlog state | U(key) | Current bounded records; historical metrics 30 days |

Split indexes by real access path; do not index raw error messages, arbitrary payloads or all fields automatically. TTL indexes are separate single-field indexes, not assumed to work as compound TTL. Deletable terminal documents alone receive `expiresAt`; counted ingestion receipts use explicit `deleteAfter` cleanup instead. Retention expiry is asynchronous; queries enforce cutoffs and credential expiry directly rather than waiting for TTL deletion. [MongoDB TTL behavior](https://www.mongodb.com/docs/manual/core/index-ttl/).

## Relationships and deletion

Project → environments → telemetry/keys/monitors/rules. Monitor → check runs. Request event → optional error occurrences → error group. Rule + scope → sequential incidents → incident events and notifications. Admin → sessions and audit actor references.

Keep event records denormalized with stable project/environment and route keys; avoid dashboard joins over millions of raw records. Group example references may expire and must tolerate missing records. Incident evidence is a bounded safe snapshot so retention of raw data does not destroy its meaning. Store timeline entries separately, not in an unbounded incident array.

Project/environment deletion first disables keys, monitors and rules, closes active incidents with an explicit reason, then runs bounded indexed cleanup batches. Audit and historical incidents follow configured retention unless an explicit purge is requested. Never issue an unbounded cross-collection cascade inside an API request. Hard purge removes associated backups only according to documented backup expiry, not instantly.

## Accurate performance analytics

### Measurement and denominators

Duration measures Express middleware entry to response finish. Aborted requests have a separate outcome and duration distribution; do not invent HTTP 499 as if the app returned it. Requests still in flight are absent until completion, so long-running/hung requests create survivor bias. Probes supply a separate external latency and availability series.

For completed requests, `requestCount` counts deduplicated received events, `serverErrorCount` counts 500–599 responses, `clientErrorCount` counts 400–499 separately, and `serverErrorRate = serverErrorCount / requestCount`. An exception occurrence is not an additional failed request. Aborts and SDK drops have separate counters. Throughput is count divided by actual covered seconds; chart gaps and partial edge windows remain explicit. Never divide by a full day for a partial-day query.

Default pilot sampling probability is 1. If volume requires uniform independent request sampling, include the fixed configured probability in each event and expose sampling metadata. Observed count is not production count. Estimated traffic can sum inverse probabilities, but percentile results then describe the sampled distribution with sampling uncertainty; do not advertise exact population percentiles. Keep error-detail sampling distinct from the request metric stream; retaining every error and few successes in the same latency population would bias metrics. Overflow/retry loss is not random sampling and must never be corrected with a fabricated sampling factor.

### Exact percentile mode

Define the convention explicitly: sort valid completed durations ascending and choose nearest rank `x[ceil(p × n)]`, with ranks starting at one; p50/p95/p99 use p=.50/.95/.99. Empty input returns null; n=1 returns its only value. With durations 10, 20, 30, 40, 50 ms, p50=30 ms and p95=p99=50 ms. Equal values are valid; do not average precomputed minute percentiles.

Exact mode is a later opt-in feature, not an MVP endpoint. It reads only retained raw events for the requested project/environment/route and exact interval. Enforce a maximum 50,000 matching durations, finite range within 48-hour raw retention, bounded concurrency, query `maxTimeMS`, cursor and response limits. Scan at most limit+1 before sorting in a bounded analytics worker; if exceeded, return `exact_unavailable` or require explicit approximate mode. No silent sampling, no sorting an unlimited result into application memory, and no sorting in the API event loop. Return `method=nearest_rank`, n, time boundaries, sampling/coverage metadata and data watermark. Exact means exact for the selected received dataset, not proof that no production request was lost.

MongoDB's `$percentile` **group accumulator is approximate** and cannot be used to claim exact results. If used later for exploratory queries, mark its t-digest output approximate and do not assume stable bit-for-bit results. [MongoDB percentile accumulator](https://www.mongodb.com/docs/manual/reference/operator/aggregation/percentile/).

### Mergeable long-term percentiles

Use histogram `latency-v1`: upper bounds in microseconds are 0, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 512000, 1000000, 2000000, 4000000, 8000000, 16000000, 32000000, 64000000, 120000000, 600000000, 3600000000, followed by overflow. This is 25 bins. Bin zero contains exactly zero; each following finite bin is `(previousUpper, upper]`. Overflow is `(3600000000, 86400000000]` under the admitted duration cap of 24 hours.

Merge corresponding bin counts, sums and counts; never average percentile scalars. Locate rank `ceil(p*n)` in cumulative counts and return its lower/upper bounds, with midpoint only as a labeled display estimate. Zero has bounds [0,0]; overflow returns a lower bound and null point estimate. Precision is deliberately coarse, often a factor of two; there is no 2% precision claim. Latency alert breach requires lower bound above threshold; recovery requires upper bound below recovery threshold. Separate completed normal and streaming populations, and aborted events. A narrower histogram can be versioned later after measurement.

Rebuild dirty minute windows deterministically from unique raw events rather than applying replay-prone `$inc` rollups. Ingestion updates a dirty generation in its transaction. Aggregation captures a consistent snapshot and generation, replaces the entire computed window, and clears dirty state only if the generation has not advanced. Single-owner leases/fencing prevent stale writers; newer arrivals force another rebuild. Hourly parents, if introduced later, must be invalidated when minute generations change. Build project-wide and route/method scopes separately; queries must choose one scope level to avoid double counting.

Allow up to 10-minute event age on intake and a maximum 24-hour inbox processing delay. Finalize an event-time minute for routine alert evaluation after a 12-minute watermark (10-minute lateness plus 2-minute future/clock tolerance); expose live provisional values earlier. Rare processing backlog can still revise older windows and sets quality/staleness flags. Rebuild corrections before raw retention expires. Reconciliation must detect any generation lag older than 24 hours; mark incomplete and notify the operator rather than declare finalized completeness. Latency alerting is therefore delayed by the watermark; use active probes for faster outage detection.

The watermark is necessary but insufficient: a window is eligible for alert evaluation only when no pending receipt's event-time range overlaps it, aggregation generations are current, and source heartbeat/collection quality meets the rule policy. Advance `completeThrough` only across such eligible windows. Terminal/expired receipts and reported SDK drops create explicit incomplete intervals. Missing heartbeats, unknown source coverage or dependency outages must prevent a clean-completeness claim; clock time alone never finalizes incomplete work.

For windows spanning partially covered minute boundaries, exact mode uses raw records. Approximate rollup queries either combine raw edge slices with nonoverlapping whole bins while raw data exists, or explicitly align the query to whole retained windows and return the actual interval. Never include entire edge minutes while claiming an exact arbitrary interval. MVP rollup queries align to whole minutes and return actual bounds; reject ranges older than seven days. Hourly rollups and raw-edge blending are deferred.

Latency thresholds use uncertainty: breach only when the percentile bin's lower bound exceeds the threshold, recover only when the upper bound is below the recovery threshold; overlap is indeterminate. Minimum request count and collection coverage are also required. Keep `sampleCount`, method, histogram version, late/drop counters, `asOf`, `completeThrough` and incomplete/estimated flags in analytics responses. Do not draw a healthy zero where data is missing.

## Error sanitization and grouping

Default error detail is a safe category (`UnhandledError`, `Timeout`, approved application error code), route template, HTTP outcome, approved release ID and reviewed stack frame symbols. Never serialize an Error wholesale: messages, causes, Mongoose validation values, database queries, driver diagnostics and stacks can contain passwords or customer data. Drop free-form messages by default. Stack frames are optional and off until a canary review confirms sanitization: no raw stack string, arguments, absolute filesystem paths or dynamic source excerpts. Keep at most 10 allowlisted relative module/function identifiers. Ingestion repeats allowlist enforcement even when SDK claims sanitization.

Fingerprint is SHA-256 over a canonical tuple of fingerprint version, project/environment, safe type/code, route template, and first few approved in-application frame identities. Normalize numeric path positions/addresses and omit line numbers if release churn would fragment groups. Release is a filter, not part of the default fingerprint. When safe frames are absent, grouping is coarser; acknowledge collisions rather than capture sensitive messages to distinguish them.

Update occurrence uniqueness, group first/lastSeen, lifetime count and bounded examples in the same transaction that inserts a new occurrence. Separate group triage (`new`, `acknowledged`, `ignored`, `resolved`) from alert incident state. A new occurrence after triage resolution can reopen the group while the alert engine independently decides whether to open an incident. Initial cap: 1,000 active fingerprints per project/environment; overflow goes to one explicit safe overflow group with a counter. A surge cannot create unbounded labels or groups.

## Retention operations

Use explicit `expiresAt` per safely deletable record and separate TTL indexes; counted ingestion receipts use explicit deleteAfter cleanup instead. Pending work expires by a service transition with counters, not TTL. A daily maintenance pass reconciles quotas, orphan relationships, stuck leases and index/retention lag in bounded pages. Shortening retention requires an impact estimate and staged indexed deletions to avoid a large deletion storm.

Backup retention is separate: proposed encrypted daily backups retained 7 days, including configuration, incidents, outbox and raw telemetry unless an explicitly documented backup exclusion accepts the resulting telemetry gap. Record what each backup includes. TTL is not immediate secure erasure and backups may outlive live records. Disk-capacity controls, retention and admission limits all apply; TTL alone cannot prevent disk exhaustion. High-cardinality aggregates can outgrow raw events: size histogram records and route counts explicitly in the capacity model.

## Step 2 schema authority and pilot limits

See [field-level contracts](implementation-contracts.md#database-field-contracts) for types, required fields, lease fencing, caps and transaction boundaries. All retention values here are provisional capacity defaults, not service promises. Initial project limit is 6, environments 3/project, route templates 200/environment, monitors 30 total, rules 60 total; raise only after sizing. MVP request sampling is 1 and stack frames are disabled. Fixed-size histograms are sparse by active scope; do not pre-create empty route-minute documents.

Keep terminal receipts 48 hours after terminal transition; raw event deduplication is retained at least through receipt receive time + 72 hours even though visible raw queries stop at 48 hours. Set physical expiry to the later deadline. This exceeds the original 24-hour pending window plus bounded replay; heartbeat-only receipts use the same receipt lifecycle. TTL deletion is not used to authorize a replay.
