# Security model

## Production requirements

- Set `NODE_ENV=production` and a random `SESSION_SECRET` of at least 32 characters. Startup fails if this is missing or weak.
- Set `SECURE_COOKIES=true` behind HTTPS. Set `TRUST_PROXY=true` only when traffic always arrives through a trusted reverse proxy.
- Keep `OS_INSECURE=false` and `SSO_INSECURE=false`. Import the private CA into the container trust store instead of disabling TLS verification.
- Use `DATA_ENCRYPTION_KEY` if infrastructure secrets need a key independent from session signing. Keep the key stable and in a secret manager; changing it makes previously encrypted Kubernetes join tokens unreadable.
- Use Redis sessions for multiple replicas. Memory and file sessions are single-instance options.
- Restrict the service account to the minimum projects and roles needed by enabled background features.

## Request protections

Sessions are HTTP-only, `SameSite=Lax`, and optionally Secure. State-changing API calls require `X-CMP-Request: 1`, cross-site Fetch Metadata is rejected, request bodies are capped, and login/API rate limits are separate. Security headers include CSP, frame restrictions, MIME sniffing prevention, and HSTS when secure cookies are enabled.

Every request receives an `X-Request-Id`. Mutation audit records include request ID, user, project, provider, cloud, region, action, result, source address, status, and duration. Passwords, cookies, bearer tokens, and request bodies are not written to the audit log.

## Provider safety

OpenStack endpoints are selected from the authenticated Keystone service catalog with explicit interface and region selection. Normal requests and streaming uploads have separate bounded timeouts. Provider failures are translated into stable error categories; unexpected internal errors are not returned to clients.

## Remaining risks

- Long-running RKE2 creation/deletion is not a durable saga and may require manual cleanup after partial failure.
- The built-in Redis client does not support TLS (`rediss://`) or Redis Cluster/Sentinel; use a private trusted network or replace it with a maintained client before exposed/high-availability deployments.
- File-backed state is not encrypted wholesale. Kubernetes join tokens are encrypted, but audit and policy metadata remain readable to the container volume owner.
- OpenStack remains the final authorization authority for ordinary resource operations. A future portal permission model should be enforced centrally before adding roles that are broader or narrower than Keystone roles.

