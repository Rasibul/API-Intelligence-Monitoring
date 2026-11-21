# Implementation roadmap and decision record

## Delivery order

| Phase / step | Scope | Exit criteria |
| --- | --- | --- |
| Phase 1 — Step 1 (this delivery) | Seven architecture documents; assumptions, security, durability, statistics and capacity plan | Documents reviewed for consistency; no implementation, installation, deployment or production changes |
| Phase 1 — Step 2 (next, only when requested) | Resolve architecture questions and write implementation-ready contracts/design specifications as defined below | Decisions and contracts reviewed; failure/acceptance matrix complete; still no application implementation |
| Phase 2 — Foundation | Initialize backend TypeScript/Express, frontend JavaScript/Vite and SDK package boundaries; config validation, logging, error handling, Mongo/Redis connections and process bootstraps | Independent startup/shutdown; secrets absent from builds/logs; dependency failures bounded; index migrations explicit |
| Phase 3 — Security and configuration | Admin bootstrap/login/refresh/logout/session revoke, projects/environments, API key lifecycle, audit and admission primitives | Credential scope, revocation, refresh races, CSRF/origin and login throttling verified |
| Phase 4 — Durable ingestion vertical slice | Versioned allowlisted batch contract, transactional inbox/quota, dispatcher, queue admission, receipt processing and deduplication | Crash before/after enqueue/commit and duplicate batches cannot inflate counts; Redis loss recoverable; finite quotas demonstrated |
| Phase 5 — SDK and canary | TypeScript-source JS-compatible package, safe timing/error metadata, bounded buffer/transport and health counters | Staging compatibility/overhead and secrets tests; monitoring outages do not change response semantics; production opt-in reviewed separately |
| Phase 6 — Active monitoring | Approved target registry, SSRF-safe probe transport, independent scheduler and durable check runs | Probes occur without API traffic; stale schedules recorded; DNS/redirect/private-address/time/size protections pass adversarial checks |
| Phase 7 — Analytics and errors | Unique raw queries, generation-based histogram rollups, bounded exact mode, quality flags and error grouping | Reference datasets verify percentiles; merges and duplicate replay agree; late/partial windows and cardinality overflow visible |
| Phase 8 — Alerts and notifications | Versioned evaluation, evidence/freshness policy, incident transitions, maintenance, durable outbox and Resend | One active incident under concurrent evaluation; no false recovery on unknown data; bounded provider retries and ambiguity handling |
| Phase 9 — Dashboard and real time | Login/project overview, endpoints/errors/checks/incidents/settings; TanStack Query and Recharts; Socket.IO invalidations | All data authorized; refresh/reconnect and polling converge; sampled/stale/estimated data clearly labeled |
| Phase 10 — Operational rollout | Capacity test, backups/restores, external watchdog, TLS/network hardening, pilot and gradual 5–6 backend rollout | Recovery drills, measured admission/processing headroom, accepted hosting/RPO/RTO and documented rollback before broad use |

Each phase can deliver a small vertical UI slice once its API is stable; do not wait for every chart before validating ingestion safety. Active health checks can ship before SDK production adoption because they do not require backend code changes. Broad production rollout remains a later explicit action, not a consequence of accepting these documents.

## Required acceptance evidence

1. **Production isolation:** stalled submission, invalid monitoring credentials, full buffers, serializer failures and monitor shutdown cannot change application status/body/error handling; bounded overhead measured on realistic requests and streams.
2. **Confidentiality:** seeded passwords/JWTs/cookies/PII in headers, URLs, errors and Mongoose failures do not appear in outgoing batches, database, Redis, logs, audit or email.
3. **Durability and bounds:** concurrent quota races, ambiguous commits/enqueues, dispatcher restarts, Redis flush/loss and worker crash after commit recover without duplicate counts or unbounded permits/jobs/receipts.
4. **Analytics:** exact nearest-rank fixtures, empty/small/tied populations, histogram bounds/overflow, weighted averages, sample bias, replay, lateness and aligned edge intervals are tested against known data.
5. **Active checks:** DNS rebinding, mixed IPv4/IPv6 answers, private/metadata addresses, redirect attempts, policy edits and slow/oversize targets fail safely; missed slots do not become target outages.
6. **Incident correctness:** concurrent/replayed/out-of-order evaluations, unknown data, maintenance, acknowledgement, hysteresis and notification retry ambiguity preserve one coherent lifecycle.
7. **Recovery:** MongoDB/Redis/Resend downtime and VM loss produce visible stale states; off-host backup restores and external alarms work without this platform being healthy.

## Architecture decision summary

| Decision | Rationale | Accepted cost / follow-up |
| --- | --- | --- |
| Modular feature-based monolith | Small internal platform, shared domain model and maintainable deployment | Enforce service boundaries in review; split processes without splitting business services |
| Separate API, worker and scheduler | Background work continues without user requests; isolates routine restarts | More process supervision; still one VM failure domain |
| MongoDB durable inbox and transactional outbox | Redis can fail without making accepted work vanish | Additional database writes and replica-set transactions; explicit finite expiry/loss policy |
| BullMQ reference jobs and finite admission | Decouple bounded intake from processing without copying sensitive payloads into Redis | Admission permits/leases require careful crash-tested design |
| SDK fails open with bounded loss | Production request availability has priority | Telemetry gaps are expected and must be measured; no zero-overhead/zero-loss claim |
| Metadata-only collection | Avoid passwords, cookies, JWTs and sensitive payloads | Less debugging context; safe error groups may be coarse |
| Raw retention + fixed histograms | Exact short-range analysis and mergeable bounded historical estimates | Approximation range/schema and record size must be visible and measured |
| Probe scheduling independent of traffic | Detect reachability even when no request arrives | Own monitor failure yields unknown; requires external watchdog |
| Admin JWT + revocable DB sessions | Short-lived tokens plus immediate revocation | Session reads require MongoDB; custom same-site domains needed for proposed refresh cookie |
| API key digest + scoped authorization | Limit write credentials to one project/environment | Compromised senders can still falsify scoped telemetry; quota/audit/IP defense needed |
| REST source of truth + socket invalidations | Simple reconnect and dropped-message recovery | Slight refetch overhead and eventual UI freshness |
| Oracle VM as conditional hosting | Fits initial internal deployment intent | Capacity/free-tier stability and off-host recovery remain unresolved |

## Unresolved risks and decisions

- **Traffic/capacity:** actual mean/burst RPS, route count, request sizes, SDK process count and error rate remain unknown. Pilot defaults do not prove the proposed VM can support the workload.
- **Meaning of self-hosted:** decide whether MongoDB must also be self-managed. Managed MongoDB changes the privacy/operations boundary; no provider or plan is selected.
- **Availability/budget:** choose MongoDB topology, Oracle region/shape, fallback VPS and off-host backup destination. Accept or improve the single-VM/single-node pilot risks and proposed RPO/RTO.
- **Production integration:** inventory Express/Node versions and middleware order. The “do not modify existing production backends” constraint remains in force now; later SDK integration requires an explicit scoped rollout decision. External checks alone cannot deliver route telemetry.
- **Health destinations:** list existing safe HTTPS health endpoints, host/IP ownership, expected statuses and public versus VPN reachability. Do not assume a new endpoint or private network exemption.
- **Privacy:** review route templates, release labels and optional safe stack symbols. Free-form error messages remain excluded; regex-only sanitization is insufficient.
- **Authentication/deployment:** select same-site custom frontend/API domains and VPN versus public API access. Define cross-tab refresh concurrency behavior and whether additional MFA is needed before exposing administration broadly.
- **Queue admission:** specify atomic permit reservation, ambiguous enqueue reconciliation, lease fencing and crash recovery without relying on unsupported BullMQ internals. This is a prerequisite to implementation, not an unproven exactly-once mechanism.
- **Analytics delay and uncertainty:** the 12-minute event-time watermark delays routine metric alerts. Confirm that fast active probes plus provisional charts meet expectations; choose histogram precision and raw retention after sizing.
- **Notification availability:** confirm recipient/domain verification and provider limits, plus an external watchdog channel that does not rely on the same VM and credential path.
- **Finite loss policy:** validate the 2,000-receipt/128 MiB inbox, 24-hour pending expiry, 10-minute SDK age, 7-day raw retention and admission thresholds against acceptable monitoring gaps.

## Exact scope of Phase 1 — Step 2

When separately requested, Step 2 is **detailed design and contract specification only**:

1. Record answers to the unresolved deployment, domain, privacy, integration and capacity decisions; distinguish confirmed choices from provisional defaults.
2. Specify versioned telemetry/heartbeat envelopes, units, IDs, route labeling, redaction, limits, timestamp acceptance, sampling/quality semantics and HTTP success/error contracts.
3. Specify the admin/project/environment/API-key/monitor/analytics/incident REST endpoint catalog and authentication/authorization matrix, with request/response examples and pagination limits.
4. Specify field-level MongoDB schemas, exact compound/partial/TTL indexes, transaction boundaries, supported MongoDB topology/version, state transitions, quota accounting, leases/fencing and migrations.
5. Specify each queue/job contract, permit reservation/reconciliation algorithm, retry/expiry/quarantine behavior, scheduler missed-slot policy and worker concurrency budgets.
6. Specify histogram boundaries/versioning, exact-query resource policy, aggregate generations/watermarks, error fingerprints, rule evaluation and incident/notification state machines.
7. Specify Socket.IO event envelopes, auth/expiry behavior, safe room membership and REST resynchronization.
8. Produce a final feature/file responsibility map, dependency order, threat/failure matrix and measurable acceptance checklist for implementation.

Step 2 does not install packages, scaffold projects, write executable application/SDK code, edit production applications, create infrastructure, send messages, deploy services or begin Phase 2. This proposed next-step boundary avoids treating a broad architecture review as authorization to implement. Stop after Step 1 until the user requests the next step.
