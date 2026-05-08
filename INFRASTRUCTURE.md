# Infrastructure

## Toolchain

| Tool | Version |
|------|---------|
| Rust | 1.94.1 (toolchain 1.89.0 for SBF builds) |
| Agave (Solana CLI) | 3.1.11 |
| Anchor CLI | 0.32.1 (used only for deploy; contracts are built on Arlex/Pinocchio) |
| Node.js | ≥ 22.17.0 |
| npm | ≥ 10 |

### Platform-tools workaround

`cargo-build-sbf` from Agave 3.1.11 pulls platform-tools v1.48 (rustc 1.84.1), which does not support `edition2024`. Symlink to v1.54:

```bash
ln -sf ~/.cache/solana/v1.54 ~/.cache/solana/v1.48
```

## Build

```bash
# Init submodules (once)
git submodule update --init --recursive

# Contracts (5 programs, Cargo workspace inside contracts/)
npm run contracts:build       # or: cd contracts && cargo build-sbf

# Dashboard
npm run install:all           # installs dashboard/ and bots/ deps
npm run dashboard:build       # → dashboard/build/

# Bots
cd bots && npm -w merkle-publisher run build
```

## Test validator

Contracts are tested against a local `solana-test-validator`. Defaults:

| Parameter | Value |
|-----------|-------|
| RPC | `http://localhost:8899` |
| WebSocket | `ws://localhost:8900` |
| Ledger | `./test-ledger` (or `/tmp/test-ledger`) |

Start:

```bash
solana-test-validator --reset --ledger /tmp/test-ledger
```

Point the CLI at it:

```bash
solana config set --url http://localhost:8899
```

For remote validators (shared team setup), use an SSH tunnel:

```bash
ssh -L 8899:localhost:8899 -L 8900:localhost:8900 <your-host>
```

## Dashboard hosting

The admin dashboard is a static SvelteKit build (`@sveltejs/adapter-static`, SPA fallback). Any static host works — S3, Netlify, Vercel, or nginx on a VM.

Production: https://panel.areal.finance (nginx, SPA fallback on `index.html`).

### Deploy

```bash
cp .env.example .env          # set DEPLOY_HOST, DEPLOY_PATH
npm run dashboard:deploy      # vite build + rsync
```

The script (`scripts/deploy-dashboard.sh`) reads `DEPLOY_HOST` and `DEPLOY_PATH` from `.env`, runs `npm run dashboard:build`, then `rsync -az --delete` into the remote path.

### Nginx sketch (for self-hosting)

```nginx
server {
    listen 80;
    server_name panel.example.com;
    root /var/www/panel.example.com;
    index index.html;

    location / {
        try_files $uri $uri.html $uri/ /index.html;
    }

    location /_app {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript;
}
```

Asset filenames include content hashes, so `/_app` can be cached long-term without invalidation.

## RPC endpoint

The dashboard connects to an RPC endpoint configured in `dashboard/src/lib/stores/network.ts`. For production behind a custom domain, proxy HTTP and WebSocket through nginx with appropriate CORS headers for your panel origin.

## Updating `@arlex/client`

`@arlex/client` is consumed by `dashboard/` (and will be by `app/` and the future `sdk/`) as a vendored tarball at `vendor/arlex-client-0.1.0.tgz`. This is a **pre-publish** arrangement; once Phase 6 of `plan/integration-plan.md` lands, the tarball will be replaced with `^0.1.x` from the npm registry and this section becomes obsolete.

### When to refresh

- Bug fix or feature in `framework/client/` lands on `main` of `ArealFinance/arlex`.
- Security patch in transitive deps of `@arlex/client`.
- Version bump (rare during pre-publish).

### Procedure

```bash
# 1. In the framework repo (separate working tree at ~/Documents/Solana/arlex/framework)
cd framework/client
npm test                  # MUST pass
npm run build             # rebuilds dist/
npm pack                  # produces arlex-client-<version>.tgz

# 2. In the meta-repo (this repo)
cp ../../Solana/arlex/framework/client/arlex-client-0.1.0.tgz vendor/
# Update vendor/README.md with the new framework SHA

# 3. In the dashboard submodule (or wherever consumed)
cd dashboard
rm -rf node_modules/@arlex package-lock.json   # cache-bust mandatory
npm install
npm run build && npm run check && npm run test  # verify

# 4. Commit, in dependency order:
#    a. Framework: test + build commits (push to ArealFinance/arlex:main)
#    b. Dashboard: package-lock.json regen commit (push to ArealFinance/dashboard:main)
#    c. Meta: vendor/ tarball + README + dashboard pointer bump (push to ArealFinance/areal:main)
```

### Cache-bust note

`npm` caches `file:` tarballs by integrity hash. Refreshing the tarball **without** bumping its filename version (e.g., overwriting `arlex-client-0.1.0.tgz` in place) requires deleting `node_modules/@arlex` and `package-lock.json` from each consumer before `npm install`. Skipping this step makes npm reuse the cached old hash silently.

If the version in `framework/client/package.json` bumps (e.g., to `0.2.0`), the tarball name changes accordingly (`arlex-client-0.2.0.tgz`); update the `file:` path in every consumer's `package.json` to match.

### Path resolution

The `file:` path is **relative to the consuming `package.json`**, not to cwd. From `dashboard/package.json`, it's `file:../vendor/arlex-client-0.1.0.tgz` (one `..` up to meta-root, then into `vendor/`).

### Forward-looking

After Phase 6 GREEN of `plan/integration-plan.md`:
1. `npm publish @arlex/client@0.1.0` to npmjs (requires `npm login` + `@arlex` org).
2. In each consumer, replace `"@arlex/client": "file:../vendor/arlex-client-X.Y.Z.tgz"` with `"@arlex/client": "^0.1.0"`.
3. Remove `vendor/arlex-client-*.tgz` files (and possibly the `vendor/` directory if empty).
4. Delete this section from `INFRASTRUCTURE.md`; replace with a "Releasing @arlex/client" section.

## Backend (Phase 12.1)

Production-grade Nest.js indexer + REST API for the 5 on-chain programs. Lives in the `backend/` submodule (`ArealFinance/backend` v0.1.0). Co-located on the Fornex VPS with the Phase 20 observability stack.

### Architecture

| Service | Image | Bind | Notes |
|---------|-------|------|-------|
| `postgres` | `postgres:15-alpine` | `127.0.0.1:5432` | Primary store; named volume; `pg_isready` healthcheck. |
| `redis` | `redis:7-alpine` | `127.0.0.1:6379` | Bull queue + caching; appendonly + password. |
| `backend` | local build (`backend/Dockerfile`) | API `127.0.0.1:3010`, metrics `127.0.0.1:9201` | Nest 11, ESM. Dual listener: API + isolated metrics app. See `backend/ARCHITECTURE.md`. |

The Nest app is **single-process** for Phase 12.1 — chain listener + Bull worker + REST + metrics co-located. Splitting into separate workers is left for Phase 12.2/12.3 if profile data forces it.

### Public surface

- `https://api.areal.finance/health` — DB + RPC ping (200/503 + JSON body).
- `https://api.areal.finance/api/docs` — Swagger UI (autogenerated).
- `https://api.areal.finance/auth/*` — wallet-signature → JWT (access 7d, refresh 30d).
- `https://api.areal.finance/metrics` — **always 404** (Cloudflared ingress rule blocks the path; metrics live on the localhost-only listener).

### Internal surface (Prometheus only)

- `127.0.0.1:9201/metrics` — `prom-client` registry. Scraped by the Phase 20 Prometheus job `areal-backend`.

### Deploy procedure

The deploy is a single idempotent script driven by an operator over SSH (or, after Phase 25 wiring, by `backend/.github/workflows/deploy.yml` against a restricted `deployer` user).

**First-time deploy:** see [`OPERATOR-RUNBOOK-PHASE-12.1.md`](./OPERATOR-RUNBOOK-PHASE-12.1.md) for the full step-by-step. Summary:

1. SSH to the Fornex VPS (`deployer@<host>`).
2. Clone the meta-repo with submodules to `/opt/areal/areal-meta`.
3. Populate `/opt/areal/areal-meta/backend/.env` from `.env.example` + `openssl rand -hex 32` for every secret.
4. Run `sudo bash /opt/areal/areal-meta/scripts/backend/bootstrap-fornex.sh`.
5. Merge `backend/scripts/cloudflared-config.snippet.yml` into the existing cloudflared config; reload.
6. Add the `areal-backend` scrape job to `bots/observability/prometheus.template.yml`; reload Prometheus.
7. Install the cron entry for nightly backups (see Backups below).

**Subsequent deploys (pointer bump):** re-run the bootstrap. The script pulls the new ref, rebuilds the image, applies migrations, smoke-tests `/health`. No state loss — postgres + redis volumes persist across runs.

### Env vars

Reference: [`backend/.env.example`](./backend/.env.example).

Required for production:

| Var | How to generate / source |
|-----|-------------------------|
| `NODE_ENV` | `production` (gates CORS allow-list — see `backend/src/main.ts`). |
| `POSTGRES_DB`, `POSTGRES_USER` | Pick once; never rotate. |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | `openssl rand -hex 32`. Store in `pass`/`age`. |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | `openssl rand -hex 32` (distinct values). |
| `RPC_URL_DEVNET`, `RPC_URL_MAINNET` | Helius / QuickNode / private node. **Not** public mainnet-beta. |
| `SOLANA_CLUSTER` | `devnet` for staging, `mainnet` for prod. |
| `BACKUP_PASSPHRASE` | `openssl rand -hex 32`. Required for `backup-postgres.sh`. |

### Cloudflared route

The `api.areal.finance` ingress rule is committed as a snippet in [`backend/scripts/cloudflared-config.snippet.yml`](./backend/scripts/cloudflared-config.snippet.yml). The operator merges it into the existing Fornex cloudflared config (which already serves `panel.areal.finance` + `status.areal.finance`).

DNS prerequisite: `cloudflared tunnel route dns <tunnel-name> api.areal.finance` (one-time).

### Backups

Nightly encrypted `pg_dump` driven by [`backend/scripts/backup-postgres.sh`](./backend/scripts/backup-postgres.sh). Crontab:

```
0 3 * * * /opt/areal/areal-meta/backend/scripts/backup-postgres.sh >> /var/log/areal-backup.log 2>&1
```

- Local copies live in `/var/backups/areal/`, retained 7 days.
- Remote copies go to the S3-compatible bucket configured via `BACKUP_S3_BUCKET` + `BACKUP_S3_ENDPOINT`. R2 / B2 lifecycle policy retains 90 days.
- Plaintext dump is deleted immediately after AES-256-CBC encryption (PBKDF2, 600k iterations).
- Prometheus textfile metric `areal_backup_last_*` written to `/var/lib/node_exporter/areal_backup.prom` — Phase 22 alert rule fires on stale metric.

### Observability integration

Add this scrape job to `bots/observability/prometheus.template.yml`, then re-render + reload via the Phase 20 bootstrap:

```yaml
- job_name: 'areal-backend'
  static_configs:
    - targets: ['localhost:9201']
      labels:
        service: 'backend'
        instance: 'fornex'
```

The metrics listener is bound to `127.0.0.1:9201` inside the container; the prod compose template publishes it to `127.0.0.1:9201` on the host via port mapping so Prometheus on the same VPS can reach it without joining the docker bridge.

### Migrations

TypeORM migrations live in `backend/src/migrations/`. After bumping the backend pointer to a ref containing new migrations:

```bash
docker compose -f docker-compose.prod.yml --env-file .env exec backend npm run migration:run
```

(`bootstrap-fornex.sh` does this automatically.) Revert with `npm run migration:revert`.

### Rollback

The bootstrap script is idempotent; rolling back is a re-run with an older ref:

```bash
sudo AREAL_BACKEND_REF=v0.0.x bash /opt/areal/areal-meta/scripts/backend/bootstrap-fornex.sh
```

Database schema rollback is a separate step — only `migration:revert` if the new code requires the old schema. The default posture is **forward-only** for migrations.

### Troubleshooting

- **`/health` returns 503 with `db: down`:** check `docker compose logs postgres`. Most common cause is a stale `.env` after rotating `POSTGRES_PASSWORD` without recreating the postgres volume. Volume needs to be recreated to pick up the new initdb password — there is no in-place fix.
- **`/health` returns 503 with `rpc: down`:** Helius/QuickNode rate limit or network blip. Check `RPC_URL_*` correctness and the indexer logs for `429`.
- **Bull queue stuck:** redis is the queue backing store. `docker compose exec redis redis-cli -a "$REDIS_PASSWORD" llen bull:indexer:wait` shows depth. Restart the backend container if the worker hangs.
- **Indexer falling behind:** check Prometheus `events_persisted_total` rate vs chain TPS. The reconcile job runs every `RECONCILE_INTERVAL_SECS` (default 300s) and refills any gaps.
