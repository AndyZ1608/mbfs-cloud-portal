# Security model

## Production requirements

- Set `NODE_ENV=production` and a random `SESSION_SECRET` of at least 32 characters. Startup fails if this is missing or weak.
- Set `SECURE_COOKIES=true` behind HTTPS. Set `TRUST_PROXY=true` only when traffic always arrives through a trusted reverse proxy.
- Serve CMP over HTTPS in production before enabling self-service account password changes. The browser sends current/new passwords only to the CMP backend; CMP sends them to Keystone's self-service Identity API. Plain HTTP between browser and CMP would expose those credentials in transit. Use a trusted HTTPS Keystone endpoint or a protected internal connection as appropriate for the deployment.
- Keep `OS_INSECURE=false` and `SSO_INSECURE=false`. Import the private CA into the container trust store instead of disabling TLS verification.
- Use `DATA_ENCRYPTION_KEY` if infrastructure secrets need a key independent from session signing. Keep the key stable and in a secret manager; changing it makes previously encrypted Kubernetes join tokens unreadable.
- Use Redis sessions for multiple replicas. Memory and file sessions are single-instance options.
- Restrict the service account to the minimum projects and roles needed by enabled background features.

## Request protections

Sessions are HTTP-only, `SameSite=Lax`, and optionally Secure. State-changing API calls require `X-CMP-Request: 1`, cross-site Fetch Metadata is rejected, request bodies are capped, and login/API rate limits are separate. Security headers include CSP, frame restrictions, MIME sniffing prevention, and HSTS when secure cookies are enabled.

Every request receives an `X-Request-Id`. Mutation audit records include request ID, user, project, provider, cloud, region, action, result, source address, status, and duration. Passwords, cookies, bearer tokens, and request bodies are not written to the audit log.

VM password changes use the current Keystone project token, a portal-side `member`/`admin` gate, and a fresh Nova server lookup to confirm the VM belongs to the current project. Nova decides whether the password-change operation is supported; CMP does not inspect image metadata or guest configuration. The audit entry records only actor, project, VM, action, result, and timing. The submitted password is neither returned nor persisted; provider errors from this operation are mapped to messages that cannot echo it.

Account password changes are separate from VM password changes. A local Keystone login may call `POST /api/account/change-password`; CMP derives the user ID from its authenticated session and calls Keystone `POST /v3/users/{user_id}/password` with the original and new passwords. CMP never uses an administrative reset token for this operation, never records either password in audit or logs, rate-limits attempts, and destroys the CMP session after success. SSO/WebSSO sessions cannot use this local-password flow. The CMP session is ended, but this does not assert revocation of every Keystone token on other devices.

Billing requests forward the current project-scoped Keystone token in `X-Auth-Token`. The token is never sent to the browser as Billing configuration, placed in a URL, or written to logs. CMP does not send `project_id`; the Billing service validates the token with Keystone and derives project scope itself.

## Current-project resource boundary

Tenant resource routes use the Keystone project in the authenticated CMP session, never a browser-supplied project ID. Provider list filters are paired with CMP-side ownership checks because admin-scoped OpenStack responses can contain other projects' resources. Detail and mutation routes check fresh provider ownership before returning data or acting; missing or conflicting ownership metadata fails closed with 404. Background backup, power, and monitoring jobs also check ownership when using service credentials. Project switching hides the previous project's page until the new scoped session loads.

`GET /api/networks` and router management show only project-owned resources. `GET /api/available-networks` is a deliberate VM/VIP selector containing owned and Neutron-shared non-external networks; `GET /api/external-networks` is limited to explicit external gateway networks. Public/community Glance images remain globally usable; shared images require accepted project membership, while private images belong to the current project. Nova keypairs are user-scoped rather than project-owned. Swift operations use the project account endpoint from the scoped Keystone catalog. System administration endpoints under `/api/admin` are intentionally distinct and retain their administrator-wide behavior.

## Provider safety

OpenStack endpoints are selected from the authenticated Keystone service catalog with explicit interface and region selection. Normal requests and streaming uploads have separate bounded timeouts. Provider failures are translated into stable error categories; unexpected internal errors are not returned to clients.

## Remaining risks

- Long-running RKE2 creation/deletion is not a durable saga and may require manual cleanup after partial failure.
- The built-in Redis client does not support TLS (`rediss://`) or Redis Cluster/Sentinel; use a private trusted network or replace it with a maintained client before exposed/high-availability deployments.
- File-backed state is not encrypted wholesale. Kubernetes join tokens are encrypted, but audit and policy metadata remain readable to the container volume owner.
- OpenStack remains the final authorization authority for ordinary resource operations in addition to CMP's current-project boundary. A future portal permission model should be enforced centrally before adding roles that are broader or narrower than Keystone roles.
