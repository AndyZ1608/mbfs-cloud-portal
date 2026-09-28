# MBFS Cloud Portal

MBFS Cloud Portal is a self-hosted OpenStack management portal. It provides tenant-scoped compute, network, block/object storage, load-balancer, backup, monitoring, audit, marketplace, RKE2, and external Billing-service integration through a React SPA and an Express API.

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

Requires Node.js 22.13 or newer for the CMP classification database (`node:sqlite`).

```bash
cd web
npm ci
npm run build

cd ../server
npm ci
npm test
```

The CI workflow also syntax-checks every backend module and builds the Docker image.

## UI languages

The portal supports Vietnamese (`vi`) and English (`en`). Vietnamese is the default; the language selector in the header (and on the login screen) changes labels immediately without changing the OpenStack session or selected project. The non-sensitive preference is stored in browser `localStorage` as `cmp.locale`. Translation resources live in `web/src/i18n/locales/vi.js` and `en.js`; keep their semantic keys in sync when adding UI text. OpenStack resource names, identifiers, and raw status values are not translated.

## Architecture and security

- [Architecture and module boundaries](./docs/ARCHITECTURE.md)
- [Security model and operational requirements](./docs/SECURITY.md)
- [External Billing integration](./docs/BILLING.md)

The API is intentionally a modular monolith. Route modules orchestrate use cases while `server/openstack.js` is the provider boundary. A second provider should be introduced behind a use-case/provider interface only when its behavior and capability differences are known.

## VM Labels & Tags

`/labels-tags` manages customer-created classifications for the current Keystone project. A Label has reusable values (one value per Label per VM); a Tag is a flat reusable marker (many per VM). Names preserve display casing but are unique case-insensitively within their project or Label. Each Label value and Tag stores a customer-selected `#RRGGBB` color. No business definitions are seeded.

The CMP SQLite database at `DATA_DIR/classifications.sqlite` is the sole classification store. Migration `server/migrations/001_classifications.up.sql` creates the schema on first access; its down file is supplied for rollback tooling. Include the SQLite database and WAL files in backups of `DATA_DIR`. These records are never copied to Nova metadata/tags, Glance, Billing, or automation. Existing Nova metadata/tags are intentionally **not imported**.

Project-scoped catalog reads are available to authenticated users; `member` and `admin` roles can manage definitions and assign them to owned VMs. The API derives project ID from the CMP session and validates VM ownership through the existing Nova-backed project guard before assignment. Rename/recolor changes a definition in place and updates every VM display automatically. Confirmed deletion of a used value/definition removes only its CMP assignments, never the VM. VM deletion through CMP removes assignments; a complete project VM-list synchronization lazily prunes assignments for VMs deleted outside CMP.

VM-list filters combine with **AND** and run against CMP assignments joined to a complete, safely paginated current-project Nova list. The list endpoint reads assignments in 500-ID batches, avoiding per-VM queries and incorrect filtering of a partial first page. The authoritative project context remains the current CMP session.
