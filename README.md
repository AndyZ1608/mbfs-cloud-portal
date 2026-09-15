# MBFS Cloud Portal

MBFS Cloud Portal is a self-hosted OpenStack management portal. It provides tenant-scoped compute, network, block/object storage, load-balancer, backup, monitoring, cost, audit, marketplace, and RKE2 cluster workflows through a React SPA and an Express API.

The repository currently supports OpenStack only. VMware and generic multi-cloud provider support are not implemented.

## Quick start

```bash
cp .env.example .env
# Set a strong SESSION_SECRET before production use.
docker compose up -d --build
```

Open `http://localhost:8080`. With `OS_MOCK=true`, any non-empty username/password can be used against in-memory demo data.

For OpenStack, SSO, HTTPS reverse proxy, service-account, backup, monitoring, and troubleshooting instructions, see [INSTALL.md](./INSTALL.md). Upgrade notes are in [UPGRADE.md](./UPGRADE.md).

## Development

Requires Node.js 20.

```bash
cd web
npm ci
npm run build

cd ../server
npm ci
npm test
```

The CI workflow also syntax-checks every backend module and builds the Docker image.

## Architecture and security

- [Architecture and module boundaries](./docs/ARCHITECTURE.md)
- [Security model and operational requirements](./docs/SECURITY.md)

The API is intentionally a modular monolith. Route modules orchestrate use cases while `server/openstack.js` is the provider boundary. A second provider should be introduced behind a use-case/provider interface only when its behavior and capability differences are known.

