# Architecture

## Runtime view

```text
Browser / React SPA
        |
        | same-origin JSON and streaming HTTP
        v
Express request boundary
  request ID -> headers/rate limits/CSRF -> session -> authentication
        |
        v
Feature route modules
  compute, network, storage, load balancing, backup, marketplace,
  Kubernetes, monitoring, resource optimization, administration
        |
        v
OpenStack provider boundary
  Keystone auth -> service-catalog endpoint selection -> bounded fetch
        |
        v
Keystone / Nova / Neutron / Cinder / Glance / Octavia / Swift

Billing routes follow a separate boundary:

Browser -> CMP Billing controller -> Billing service/client
        -> External Billing REST API (current scoped Keystone token)
```

The backend is a modular monolith. This is deliberate: there is one deployed service, one provider implementation, and several workflows share an OpenStack-scoped session. Splitting it into network services would add failure modes without establishing a clearer product boundary.

## Important modules

- `server/index.js`: process startup, background-worker startup, listener, and graceful shutdown only.
- `server/app.js`: testable Express composition and route registration.
- `server/config.js`: parsed process configuration and production startup validation.
- `server/middleware.js`: request context, CSRF, authentication/role checks, and the error contract.
- `server/openstack.js`: Keystone authentication, service-catalog resolution, timeouts, and provider error translation.
- `server/billing/*`: external Billing client/service boundary; contains no pricing, metering, rating, or project filtering.
- `server/routes/*`: feature-level HTTP adapters and current use-case orchestration.
- `server/audit.js`: tenant-filtered append-only activity records.
- `server/store.js`, `server/sessionstore.js`: lightweight local persistence and session-store adapters.
- `web/src/api.js`: shared JSON API client; pages contain feature presentation state.

The React sidebar has one data-driven route map in `web/src/components/SidebarNavigation.jsx`. Dashboard stands alone; Compute contains Virtual Machines, Images, and SSH Keys; Storage contains Volumes, Object Storage, and Backup; Network contains Networks & Routers, Floating IPs, Security Groups, and Load Balancers. Feature-gated Billing is a standalone top-level link to `/billing`. Platform / Services contains Kubernetes and Marketplace; Operations contains Power Schedule, Resource Optimization, Activity Log, and the admin-only Cloud Administration link. Routers, Snapshots, Flavors, and Monitoring do not have standalone routes and therefore have no duplicate menu entries. Grouping does not change URLs or backend authorization.

## API conventions

Existing success response shapes remain feature-specific for compatibility. Errors use:

```json
{
  "error": "Human-readable message",
  "code": "stable_machine_code",
  "requestId": "trace-id"
}
```

All non-safe `/api` requests require `X-CMP-Request: 1`. This protects cookie-authenticated operations from cross-site form submission. The Keystone WebSSO callback is the only explicit exception because it is a cross-site signed-token POST.

Application/service integration settings are loaded from `server/config/application.yml` (or `CMP_CONFIG_FILE`). Billing is scoped exclusively by the current project-scoped Keystone token; CMP never sends a project selector to Billing.

### Create Network contract

`POST /api/networks` accepts the existing flat `name`, `cidr`, optional `gateway_ip`, and `dns` fields plus `mode: "isolated" | "routed"`. `isolated` is the default for legacy callers that omit `mode`; an isolated request ignores any stale `router_id`. Routed requests require `router_id`, which is verified against the current Keystone project before creation. The backend creates network and subnet, then attaches the new subnet to that router. Both modes always send `enable_dhcp: true` to Neutron, ignoring any deprecated client `enable_dhcp` value. Gateway remains configurable in either mode. If subnet creation or router attachment fails, CMP attempts to delete only resources created by that request. On attachment errors it first attempts to remove any interface created for the new subnet, including a possible late success after a timeout. An incomplete rollback returns `network_partial_failure` with the created resource IDs for operator cleanup.

## State and background work

Policies, cluster metadata, notifications, and audit records live under `DATA_DIR` (normally `/data`). Sessions may use memory, files, or Redis. The scheduler, power controller, monitor, report generator, and alerts execute in the web process, so only one replica may run them safely today.

## Known architectural limits

- Route modules still combine HTTP adaptation and use-case orchestration. Extract application services when workflows gain independent tests or a second caller.
- Background operations do not use a durable queue, lease, or idempotency key. Multiple replicas can duplicate work.
- JSON persistence and synchronous filesystem calls are suitable for a small installation, not a large multi-replica control plane.
- The RKE2 deployment workflow is long-running and only partially compensates failed infrastructure creation.
- RBAC relies primarily on OpenStack policy enforcement; only cluster administration has an explicit portal-side `admin` gate.
- The frontend has no automated component/accessibility test suite and several pages remain oversized.
