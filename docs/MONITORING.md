# Per-VM Monitoring integration

CMP's Monitoring tab calls `GET /api/servers/:id/monitoring?range=1h|6h|24h|7d` through the authenticated CMP backend. The backend uses the current Keystone project context to fetch the Nova server with `fetchOwned` **before** contacting Monitoring. This check applies to cloud-admin users too. Browser-supplied project IDs and PromQL are rejected.

The backend currently uses the Monitoring service's read-only admin VM snapshot and history endpoints. Its `X-API-Key` stays in the CMP backend environment and is never sent to the browser. This is a temporary trusted-backend adapter; it is not an admin API proxy. Only CPU percent, memory-used percent, disk read/write B/s, and network RX/TX B/s are returned. QEMU host RSS is not used as guest memory, and reachability remains N/A. Response instance and project identities are checked again against the authorized Nova instance and selected project.

## Deployment

Set `monitoring.enabled`, `monitoring.base_url`, and `monitoring.timeout_seconds` in `server/config/application.yml`. Set `MONITORING_API_KEY` in the deployment's untracked `.env` or its secret-management equivalent; do not commit the value. `docker-compose.yml` passes `.env` only to the CMP backend service, not to the frontend build. If the key or URL is absent, the tab remains visible when enabled but reports that Monitoring is unavailable.

After configuring the secret, recreate the CMP backend container:

```sh
docker compose up -d --build --force-recreate mbfs-cloud-portal
```

Do not put the key in browser environment variables, `application.yml`, URLs, or logs. Ensure the CMP backend host can reach the Monitoring API. Rotate the key through the deployment secret store and recreate the container when needed.

## Data and limits

The admin snapshot returns `metadata`, `metrics`, `collected_at_unix`, and `notes`. Each history response returns `metadata`, `metric`, `unit`, `points` (`[Unix seconds, value|null]`), and `null_is_missing`. CMP allowlists six metric names and strips all admin metadata. Missing snapshot data yields N/A and empty charts; real zero remains zero. A single history failure leaves other metrics available and shows a partial-history notice.

The Monitoring history endpoint supports at most 48 hours. CMP requests 1h, 6h, and 24h with bounded sampling and at most two concurrent history calls. It does **not** invent a 7-day series: selecting 7d retains the current snapshot, leaves charts empty, and shows an unsupported-history notice. Monitoring service outages show a localized error without affecting other VM Detail tabs.
