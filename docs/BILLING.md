# Billing Integration

Billing is an independent service and the sole source of truth for inventory, metering, rating, pricing, VM billing, project totals, and billing history. CMP does not access the Billing database and performs no monetary calculations.

## Configuration

Edit `server/config/application.yml`:

```yaml
billing:
  enabled: true

  # Billing internal REST API.
  # Format:
  #   http://x.x.x.x:port
  #
  # Example:
  #   http://100.64.64.150:8080
  #
  # Replace the example IP with the actual Billing VM address.
  base_url: "http://x.x.x.x:port"

  timeout_seconds: 10
```

The committed configuration keeps `enabled: false` so a fresh installation does not call a placeholder host. Set a real absolute HTTP or HTTPS URL, then enable the integration. Trailing slashes are normalized. URLs without a protocol, URLs containing credentials, and timeouts outside 1–120 seconds are rejected at startup.

Set `CMP_CONFIG_FILE` to use a different YAML file. Docker Compose mounts `server/config/application.yml` read-only at `/app/config/application.yml`, so the endpoint can be changed without modifying application source code.

## Request flow

```text
Browser
  -> CMP /api/billing
  -> current CMP session's project-scoped Keystone token
  -> X-Auth-Token
  -> Billing service
  -> Keystone token validation
  -> token.project.id
  -> project-filtered Billing response
```

CMP never sends a browser-controlled or server-calculated `project_id` to select Billing scope. It does not fall back to an admin, service-account, unscoped, or another user's token.

Local Keystone login and Keystone WebSSO provide a user project-scoped token and support Billing. The legacy Keycloak bridge mode uses an OpenStack service-account token internally; CMP therefore rejects Billing access in that mode instead of forwarding privileged credentials. Use Keystone WebSSO federation for SSO users who need Billing.

## Endpoints

| CMP endpoint | External Billing endpoint |
| --- | --- |
| `GET /api/billing` | `GET /api/v1/portal/billing` |
| `GET /api/billing/instances` | `GET /api/v1/portal/billing/instances` |
| `GET /api/billing/instances/:instanceId` | `GET /api/v1/portal/billing/instances/{instance_id}` |

External responses are passed through as JSON after status, size, and JSON-structure validation. The UI displays fields actually returned by Billing and makes a dedicated detail request when an instance is opened.

## Failure behavior

Billing timeouts, connection failures, malformed responses, and upstream 5xx errors affect only Billing pages. OpenStack compute, network, and storage routes remain available. Billing 401, 403, and 404 responses remain distinct and are never converted into a zero-cost response.
