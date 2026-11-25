# Security design

## Trust boundaries and data minimization

Production applications trust the SDK only to collect an explicitly bounded metadata set. Treat SDK submissions as untrusted even with a valid API key. The browser is untrusted; all authorization and project/environment binding happen server-side. Redis, MongoDB, Resend and the VM are separate credential boundaries. Ingestion keys cannot access admin APIs, query telemetry, join sockets, configure probes or create other keys.

Use positive field allowlists. Collect method, reviewed route template, status/outcome, duration, timestamps, random telemetry IDs, configured application/environment/release labels and restricted error categories. Do not collect request/response bodies, query strings, original URLs, headers, cookies, authorization values, JWTs, passwords, user IDs, customer IPs, MongoDB query parameters or arbitrary custom objects. Telemetry IDs must be generated independently of user data. Reject unknown fields rather than persisting them accidentally.

Sanitize in the SDK before serialization and again at ingestion before persistence. Free-form error messages/stacks are excluded by default. Structured logs, proxy access logs, traces, queue failure reasons, audit events and email templates follow the same policy; never include Authorization/Cookie/Set-Cookie, login bodies or ingestion payload dumps. Proxy security IP logs, if needed for abuse controls, are separate from telemetry, minimized and short-lived (proposed 24 hours). A redaction regex is defense in depth, not permission to collect a forbidden field.

## Network boundaries

| Path | Policy |
| --- | --- |
| Internet → VM | TLS 443 only; 80 solely if needed for redirect/certificate issuance; no direct Node port |
| SDK → ingestion | Fixed TLS hostname with certificate verification; optional known VPS IP allowlist as a second control, never key replacement |
| Admin browser → API/socket | Prefer VPN/IP restriction for internal use; authenticated origin/session enforced regardless |
| Operator → SSH | Key authentication, narrow source allowlist/VPN, no password/root login |
| API/worker/scheduler → Redis | Self-hosted: loopback/private network, authenticated ACLs, never public 6379. Managed: TLS with certificate verification, authenticated ACLs and source allowlist; plaintext `redis://` over the internet is not acceptable for production |
| Processes → MongoDB | Private network where possible; TLS and least privilege, explicit source allowlist, never open 27017 to the world |
| Probe worker → targets | Approved public HTTPS destinations/ports only; metadata/private networks blocked at egress |
| Notifications → Resend | TLS API with server-only sending credential |

“Private” describes access policy and ownership; a publicly reachable authenticated ingestion endpoint may still be needed for separate VPS senders. With a public Vercel frontend, only static assets/configured public origin are exposed; sensitive data always requires backend authentication. A browser can use a private/VPN backend if the administrator's device has connectivity. Choose VPN versus public authenticated API before deployment.

Terminate TLS at a maintained reverse proxy. Trust forwarded headers only from that proxy; never trust arbitrary client `X-Forwarded-For`. Configure request/header/body/time limits and separate ingestion/admin budgets. Use exact origin lists, including WebSocket upgrades; CORS is not authentication and does not protect server-to-server ingestion. Disable caching for login, tokens and API-key responses. Apply security headers and a restrictive frontend CSP; render error metadata as plain text, never executable HTML.

## Admin authentication and sessions

One initial owner account, created by a one-time local administrative procedure; no default password or public signup/reset endpoint. Password reset initially requires trusted operator access and revokes all sessions. Store a bcrypt password hash with per-password salt and a benchmarked cost targeting approximately 100–250 ms on the chosen hardware. Bound password byte length explicitly to bcrypt's 72-byte behavior; reject longer UTF-8 input rather than silently truncate. Require a long unique password, throttle login by IP and account, use generic failure messages, and prevent unlimited parallel hash work. No password/JWT enters telemetry or logs.

Access JWT: 10-minute lifetime, explicit algorithm allowlist, issuer, audience, subject, session ID, issued-at and expiry. Keep it in browser memory, not localStorage or a URL. Verify signature and the active MongoDB session/admin status on every privileged API request; revocation is immediate once committed. Store signing keys in server secrets with key IDs and overlap only for bounded verification during rotation.

Refresh credential: opaque cryptographically random token, stored only as a digest in `admin_sessions`; browser holds it in an HttpOnly, Secure, host-only cookie scoped to `/api/v1/auth`, SameSite=Strict. Rotate it transactionally on every refresh with a compare-and-set digest/version. Retain used digests (maximum 500 per session) until absolute expiry for confirmed replay detection; when the cap is reached require a new login. No concurrency grace in MVP: the frontend serializes refresh across tabs, and replay of a known consumed token revokes the session family. A lost refresh response may therefore require login again; this is an explicit simplicity/security trade-off. Unknown tokens fail generically without revoking a session identified only by an attacker-controlled ID. Details and lost-CSRF bootstrap are in [implementation contracts](implementation-contracts.md#admin-session-contract).

Proposed inactivity expiry is 7 days, absolute session expiry 30 days; enforce in services, not just TTL. Logout revokes the session, expires the cookie and disconnects corresponding sockets. Password change/reset, admin disablement or security reset revokes all sessions. MongoDB unavailability fails closed for authenticated requests and socket revalidation; existing stale charts must be marked disconnected.

Recommended deployment uses `console.monitor.example.com` on Vercel and `api.monitor.example.com` on the VM: cross-origin but same-site HTTPS. Axios uses credentials only for the configured backend. Exact CORS origin and credentials policy are required. Protect refresh/logout and other cookie-authenticated mutations with Origin validation, JSON/content-type restrictions and a session-bound CSRF token issued in a safe response and returned in a custom header. Protect login against login CSRF with origin checks. Bearer-authenticated APIs also enforce intended origin where applicable. Cookie path/SameSite alone are insufficient CSRF design.

Default `*.vercel.app` and an unrelated API domain are cross-site: the proposed Strict cookie will not work. Custom same-site domains are a deployment prerequisite for this session design. If unavailable, document a reviewed BFF/same-origin proxy alternative before implementation; do not silently change to insecure token persistence or depend on third-party cookies. Restrict preview deployments from production credentials and production CORS.

## API key lifecycle

Generate at least 32 cryptographically random secret bytes. A key includes a public lookup ID/prefix and encoded secret; public IDs are not credentials. Show the full key only once at creation over TLS. Store SHA-256 digest of the high-entropy secret, key ID, hashing version, project/environment, ingestion-only scope, created/expiry/revoked timestamps and replacement relationship. A deterministic fast digest is appropriate for random 256-bit secrets; bcrypt remains for human passwords. Compare fixed-length digests in constant time after lookup. Never store, echo, log or send plaintext keys in email.

Default expiry: 90 days with advance reminder; operator can choose a shorter period. Use one key per project/environment/deployment group to limit compromise. Keep keys only in production server secret configuration, never React Vite variables or source control. A compromised key can submit false telemetry within its scope; it cannot be made trustworthy merely by hashing storage. Quotas, audits and VPS source allowlists reduce abuse.

Rotation creates a new independent key linked to the old key, deploys the new secret out of band in a later approved rollout, verifies last-use telemetry, and revokes the old key after a maximum 24-hour overlap. Limit active overlap to two keys per deployment group. Emergency revoke takes effect immediately: ingestion reads current key state from MongoDB for every batch; no long-lived positive auth cache. Requests already admitted cannot be retroactively uncommitted; incident response may flag/quarantine the affected key's accepted data. Retain only key ID for provenance, never its secret.

On MongoDB auth lookup failure, return 503 without accepting a batch. Redis failure does not permit unrestricted traffic: Step 2 uses bounded single-API-process local rate limits plus durable MongoDB quota transactions in normal operation and outages. Reject intake if these guards are unavailable. This initial fallback assumes one API replica; multiple API replicas require a shared admission policy before scaling.

## Health-check SSRF controls

Monitor configuration is privileged but remains an SSRF input. Apply defense in depth at create/update **and on every actual connection**, including retries:

1. Parse with a standard URL parser. Allow only HTTPS, approved exact hostnames, approved port 443 and a reviewed read-only path. Reject embedded credentials, fragments, arbitrary queries, nonstandard schemes, wildcard domains and unexpected IP literal encodings. HTTP or custom ports require a separate explicit destination policy review.
2. Resolve A and AAAA under a deadline. Reject the target if any candidate is outside the approved destination policy or is loopback, private, link-local, unique-local, multicast, unspecified, reserved/non-global, IPv4-mapped private IPv6 or cloud metadata. Include `169.254.169.254` and relevant IPv6 metadata addresses. Do not resolve an arbitrary user-selected proxy.
3. Pin the connection to an address already validated, while preserving the approved hostname for Host, SNI and TLS certificate verification. Validate every fallback address; prevent a second unchecked DNS lookup, DNS rebinding and connection-pool reuse across policy changes.
4. Disable redirects and environment proxy inheritance. Never forward authorization/cookies. A 3xx is an unexpected status, not permission to fetch its Location. Bound DNS, connect, handshake, read and total time; cap response bytes and discard content.
5. Enforce network-level egress denial for internal networks and metadata in the probe execution context. Deny probe access to Redis/MongoDB/admin listeners even when these coexist on the VM. Infrastructure connections use explicit separate allow rules; a broad worker egress exemption must not bypass the probe client policy.
6. Revalidate edited destinations, DNS changes and persisted job configuration versions immediately before execution. No API key or SDK event may specify probe targets. Audit denied attempts with safe reason codes.

Private-IP production probes are out of initial scope. If later required over VPN, use a separate tightly allowlisted probe policy and execution boundary; do not disable the public-probe protections globally. Application validation remains necessary even with a firewall. Test mixed A/AAAA answers, alternate IP formats, mapped IPv6, redirect chains, rebinding and slow/oversize responses. [OWASP SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html).

## Secrets and operational access

Use separate credentials for MongoDB runtime/migrations/backups and constrained Redis ACLs compatible with BullMQ. Socket pub/sub and queues use separate key prefixes/ACL patterns where practical. Secrets include JWT signing material, MongoDB/Redis credentials, Resend key and production ingestion keys. Store outside repository and frontend build outputs, restrict filesystem access, rotate after exposure and redact diagnostic tools. Encrypt backups and restrict restore access; disk encryption alone does not stop an authenticated application leak.

Privileged actions require audit records: login/session revoke, project changes, key create/rotate/revoke, probe destination changes, rule/maintenance changes and manual replays. Record key IDs and field names, not secret values. Use dependency/version pinning and security updates during later implementation; no packages are installed during this step.

## Step 2 defaults

Only custom same-site frontend/API HTTPS domains or a reviewed same-origin proxy are supported for deployment. Default Vercel preview domains receive no production access. The domain purchase/provider, optional MFA and VPN choice remain open. No stack frame collection, arbitrary error messages, private-IP probes or custom HTTP probe headers in MVP. API key rotation never installs secrets into production applications during this documentation task.
