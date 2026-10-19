# Per-VM Monitoring integration

CMP's Monitoring tab calls `GET /api/servers/:id/monitoring?range=1h|6h|24h|7d` through the authenticated CMP backend. The backend uses the current Keystone project context to fetch the Nova server with `fetchOwned` **before** contacting Monitoring. This check applies to cloud-admin users too. Browser-supplied project IDs and PromQL are rejected.

The backend currently uses the Monitoring service's read-only admin VM snapshot and history endpoints. Its `X-API-Key` stays in the CMP backend environment and is never sent to the browser. This is a temporary trusted-backend adapter; it is not an admin API proxy. CPU percent, memory-used percent, disk read/write B/s, and network RX/TX B/s are returned. The adapter also accepts six **optional, already calculated** service values (packet RX/TX pps, packet RX/TX drops/s, read/write average latency ms/op). The currently available Monitoring API source does not expose those six values; CMP displays N/A until the service implements them. QEMU host RSS is not used as guest memory, and reachability remains N/A. Response instance and project identities are checked again against the authorized Nova instance and selected project.

## Deployment

Set `monitoring.enabled`, `monitoring.base_url`, and `monitoring.timeout_seconds` in `server/config/application.yml`. Set `MONITORING_API_KEY` in the deployment's untracked `.env` or its secret-management equivalent; do not commit the value. `docker-compose.yml` passes `.env` only to the CMP backend service, not to the frontend build. If the key or URL is absent, the tab remains visible when enabled but reports that Monitoring is unavailable.

After configuring the secret, recreate the CMP backend container:

```sh
docker compose up -d --build --force-recreate mbfs-cloud-portal
```

Do not put the key in browser environment variables, `application.yml`, URLs, or logs. Ensure the CMP backend host can reach the Monitoring API. Rotate the key through the deployment secret store and recreate the container when needed.

## Data and limits

The admin snapshot returns `metadata`, `metrics`, `collected_at_unix`, and `notes`. Each history response returns `metadata`, `metric`, `unit`, `points` (`[Unix seconds, value|null]`), and `null_is_missing`. CMP allowlists six existing metrics and six optional future API keys; it strips all admin metadata. Optional history is requested only when its key is present in the snapshot. Missing snapshot data yields N/A and empty charts; real zero remains zero. A single history failure leaves other metrics available and shows a partial-history notice.

## Optional packet and latency contract

The proposed additive Monitoring API snapshot/history keys are `network_rx_pps`, `network_tx_pps` (`pps`), `network_rx_drops_per_sec`, `network_tx_drops_per_sec` (`drops/s`), and `disk_read_latency_ms`, `disk_write_latency_ms` (`ms/op`). These are **API field names**, not claims about exporter metric names. The service must perform counter-rate and latency calculations; CMP never derives them. Negative or unavailable optional values become null. A present key with null value advertises support but does not claim a measurement. The existing 7d history limit remains unchanged.

The available Phase 3 Monitoring source maps Nova UUID via `libvirt_domain_openstack_info.instance_id` and selects its compute host and libvirt domain. Its Grafana dashboard references `libvirt_domain_interface_stats_receive_drops_total` and `libvirt_domain_interface_stats_transmit_drops_total`, and its API uses `libvirt_domain_block_stats_read_requests_total` and `libvirt_domain_block_stats_write_requests_total` for IOPS. It does **not** establish packet-counter families or cumulative block service-time names/units. Therefore PPS and latency formulas cannot yet be implemented or validated there. The drop counters are virtual-interface observations, not physical NIC or Cinder/backend drops.

On 2026-10-19, the live service's `/openapi.json` was reachable and still listed the admin instance snapshot and history routes; the admin instance list returned HTTP 401 without an API key. Its OpenAPI schemas did not enumerate metric response fields, so that check cannot verify the six optional metrics. Prometheus port 9090 timed out from the CMP development machine. No authenticated live VM sample or writable Monitoring service checkout was available for validation; the API field names above remain a proposed additive contract, not a claim that the running service implements them.

For the Monitoring service implementation, rate each verified VM interface's cumulative packet/drop counter with reset-aware Prometheus `rate(...)`, then sum only interfaces selected by the VM's host/domain identity. Return null when the source is absent; never substitute host-wide counters. For latency, first verify that read/write time counters are cumulative operation service time and determine their units. If in seconds, calculate `1000 * sum(rate(service_time_seconds_total)) / sum(rate(requests_total))` across that VM's disks, separately for reads and writes; return null when the operation rate is zero or absent. This is operation-weighted libvirt/QEMU virtual block latency, **not** Cinder or physical backend latency. Do not publish latency until the counter semantics and reset/migration behavior are tested in the Monitoring service.

The Monitoring history endpoint supports at most 48 hours. CMP requests 1h, 6h, and 24h with bounded sampling and at most two concurrent history calls. It does **not** invent a 7-day series: selecting 7d retains the current snapshot, leaves charts empty, and shows an unsupported-history notice. Monitoring service outages show a localized error without affecting other VM Detail tabs.
