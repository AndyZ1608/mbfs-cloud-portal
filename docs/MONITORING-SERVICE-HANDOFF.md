# Monitoring service patch required for PPS, drops and latency

This is a handoff for the **Monitoring service repository**, not executable CMP logic. Only archived Phase 1/3 source is available on this machine; there is no writable Monitoring checkout or authenticated Prometheus/API session. Do not deploy this specification as though it were a tested service patch. CMP already accepts the six API fields below and leaves them null/empty until the service supplies them.

## Confirmed source counters

The operator verified these Libvirt Exporter counter families for a real Nova VM. Each query must select the VM through `libvirt_domain_openstack_info.instance_id`, retaining the matching `cluster`, exporter `instance`, and `domain` labels. Include `target_device` when matching per-interface or per-disk series. Never put the example VM UUID, host, domain, or device names into application code.

| API key | Counter | Unit |
| --- | --- | --- |
| `network_rx_pps` | `libvirt_domain_interface_stats_receive_packets_total` | `pps` |
| `network_tx_pps` | `libvirt_domain_interface_stats_transmit_packets_total` | `pps` |
| `network_rx_drops_per_sec` | `libvirt_domain_interface_stats_receive_drops_total` | `drops/s` |
| `network_tx_drops_per_sec` | `libvirt_domain_interface_stats_transmit_drops_total` | `drops/s` |
| `disk_read_latency_ms` | `libvirt_domain_block_stats_read_time_seconds_total` and `libvirt_domain_block_stats_read_requests_total` | `ms/op` |
| `disk_write_latency_ms` | `libvirt_domain_block_stats_write_time_seconds_total` and `libvirt_domain_block_stats_write_requests_total` | `ms/op` |

The latency time counters are reported as cumulative seconds by their verified metric names. Before deployment, confirm their exporter HELP/TYPE documentation and sample behavior in the Monitoring environment; do not relabel guest-virtual I/O as Cinder or physical backend latency.

## Changes to `monitoring-api/app/instance_api.py`

The archived `_find_vm` currently selects by Nova UUID and rejects multiple active exporter candidates with 409. Extend its metadata and selector to retain **cluster** alongside exporter `instance` and `domain`; keep ambiguous migration candidates rejected rather than choosing a host. Escape each selected label using the existing `_esc` helper. Do not change authorization: `/api/v1/admin` continues to require `X-API-Key`.

Extend the fixed `_metric_queries` registry and `_METRIC_UNITS` with the six API keys above. For each network counter, apply `rate(counter{job,cluster,instance,domain}[5m])` per `target_device` series **before** summing across the selected VM's interfaces. Prometheus `rate` handles ordinary counter resets; a missing series must produce null, not zero. No host-wide or cross-domain aggregation is permitted.

For each latency direction, calculate `1000 * sum(per-disk rate(time_seconds_total)) / sum(per-disk rate(requests_total))`. Match numerator and denominator on `cluster`, `instance`, `domain`, and `target_device` so disks lacking one side are excluded from **both** sums. This produces an operation-weighted average; do not average individual disk latencies. A zero or unavailable matched request rate must produce null. Reject negative, non-finite, or missing results instead of converting them to zero.

Use the **same registry expressions** for the snapshot's instant queries and the history endpoint's range queries. History retains Unix-second timestamps, `null_is_missing: true`, existing sample limits, and per-key units. The six new snapshot fields should be present with `null` where unavailable so CMP can discover which optional histories the service supports.

## Verification before CMP deployment

Add Monitoring-service tests for exact query selectors, two VM interfaces and two disks, missing matching disk series, zero operations, counter reset, migration ambiguity, null/zero responses, snapshot/history agreement, and the admin-key guard. With operator-approved read-only access, compare Prometheus instant/range results with the Monitoring API for the verified VM and another authorized VM. Keep migrations or duplicate exporter candidates unavailable until uniquely resolved; do not merge hosts.

Deploy the Monitoring service through its operator workflow first, verify its live snapshot/history, then deploy CMP and check the existing cards/charts. The archived service uses `docker compose up -d --no-deps --build monitoring-api`, but confirm the current checkout and Compose service name before running it. No live service or OpenStack resource was changed from the CMP checkout.
