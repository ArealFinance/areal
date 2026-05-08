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

> Deploy is handled by GitHub Actions. See [Deploy automation](#deploy-automation).

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

## Deploy automation

Deploy automation uses GitHub Actions to trigger safe, audited deployments to the Fornex VPS via SSH key authentication. The architecture follows a forced-command pattern: Actions SSH into the VPS as a restricted `deployer` user that can only invoke specific deployment verbs, which are routed through a wrapper and executed with `sudo` via sudoers NOPASSWD entries. This prevents accidental operator actions and keeps the CI credentials minimal.

### Architecture overview

The deployment flow:

```
GitHub Actions (main branch merge)
  ↓
  workflow_dispatch OR push on tracked paths
  ↓
  preflight job (shellcheck, validation)
  ↓
  deploy job: SSH to VPS as deployer@<host>
           ↓
           sshd applies forced-command lock → /usr/local/bin/areal-deploy wrapper
           ↓
           wrapper routes verb to /usr/local/sbin/areal-deploy-{observability,dashboard,app}
           ↓
           sudo (NOPASSWD) → verb script runs as root
           ↓
           git pull + build + rsync
  ↓
  health check job: curl /api/health, validate response
  ↓
  notify job: Telegram alert with status + GH Actions link
```

The deployer SSH key (`VPS_DEPLOYER_KEY`) is stored as a GitHub Actions secret and exists only in the Actions runner's memory during the job; it is never logged, committed, or accessible to other jobs.

### Per-workflow table

| Workflow | Trigger | Verb | Target paths | Concurrency group | Status |
|----------|---------|------|--------------|------------------|--------|
| `deploy-observability` | `push` to `main` | `deploy-observability` | `bots/observability/`, `scripts/observability/`, `scripts/lint/`, `INFRASTRUCTURE.md` | `deploy-observability` | Active |
| `deploy-dashboard` | `push` to `main` | `deploy-dashboard` | `dashboard/`, `.github/workflows/deploy-dashboard.yml` | `deploy-dashboard` | Active |
| `deploy-app` | `push` to `main` | `deploy-app` | `app/`, `.github/workflows/deploy-app.yml` | `deploy-app` | Active |
| `deploy-bots` | `workflow_dispatch` only | (stub) | (none) | (none) | Stub for Phase 21+ |

Each workflow has its own `concurrency.group`, so:
- Observability, dashboard, and app deploys can run in parallel (different targets).
- Multiple observability pushes serialize (the same target).
- `cancel-in-progress: false` — no cancellation mid-deploy; rsync state is unsafe to interrupt.

### `[skip deploy]` semantics

Include `[skip deploy]` anywhere in a commit message to skip the deploy job. The workflow's preflight job checks the commit message and exits early if the marker is found. This is useful for documentation-only commits that batch with code changes:

```bash
git commit -m "docs: update README and add logging

[skip deploy]"
```

Caveat: `[skip deploy]` works only on `push` events, not `workflow_dispatch` (manual trigger).

### Concurrency model

Each active workflow defines its own `concurrency.group`:

```yaml
concurrency:
  group: deploy-observability  # or deploy-dashboard, deploy-app
  cancel-in-progress: false
```

This ensures:
1. If you push to the observability stack twice in quick succession, the second workflow waits for the first to finish (no overlapping deploys).
2. Concurrently, a dashboard deploy can run without blocking the observability deploy (different groups).
3. `cancel-in-progress: false` prevents GitHub from canceling a running deploy job if a newer push arrives — this is critical because rsync state is not transactional.

### Failure runbook

#### deploy-observability RED

**Likely causes:**
- Shellcheck failed on a script in `scripts/observability/` or `bots/observability/` (preflight job).
- SSH connection failed (network, wrong `VPS_DEPLOYER_HOST` secret, host key changed).
- `areal-deploy-observability` verb script failed (git pull error, bootstrap script error).
- Health check failed (Prometheus/Loki/Grafana service down on the VPS).

**Triage:**
1. Click the Telegram alert link → GitHub Actions run page.
2. Expand the failed job log. Look for:
   - Shellcheck errors in the "Shellcheck observability scripts" step.
   - SSH setup or connection errors in the "Setup SSH" or "Trigger deploy-observability" steps.
   - Server-side errors in the "Trigger deploy-observability" step output (git, bootstrap, permissions).
   - Health endpoint errors in the "Health check" step.
3. For server-side errors, SSH to the VPS and check:
   ```bash
   ssh deployer@<vps-ip>
   # Read the error message from the deploy step output above
   # Check repo state
   cd /opt/areal && git status && git log -1
   # Check script errors
   tail -50 /tmp/observability-bootstrap.log  # if bootstrap logs exist
   # Check service status
   sudo systemctl status prometheus
   sudo systemctl status grafana-server
   sudo systemctl status loki
   ```

**Common recovery actions:**
- Shellcheck failure: fix the script syntax and re-push to main.
- Network failure: re-run the workflow via "Re-run jobs" on the Actions page.
- Bootstrap failure: investigate the error in the server log, fix the underlying issue (e.g., disk space, missing env var), then re-run.
- Health check timeout: services may be starting; wait 30 seconds and re-run.

#### deploy-dashboard RED

**Likely causes:**
- SSH connection failed.
- `areal-deploy-dashboard` verb script failed (git pull, npm ci, npm run build, or rsync error).
- Health check failed (nginx not serving).
- Insufficient disk space on VPS for build artifacts.

**Triage:**
1. Telegram alert → Actions page.
2. Expand the failed job. Look for:
   - SSH setup errors.
   - Build errors in "Trigger deploy-dashboard" (npm ci, npm run build).
   - Rsync errors (permission denied, disk full, path mismatch).
   - Health check error (nginx down or wrong response).
3. For server-side errors:
   ```bash
   ssh deployer@<vps-ip>
   # Check build logs
   cd /opt/areal/dashboard && npm run build 2>&1 | tail -100
   # Check rsync destination
   ls -lah /var/www/panel.areal.finance/
   df -h /var/www/  # disk space
   # Check nginx
   sudo systemctl status nginx
   sudo tail -20 /var/log/nginx/error.log
   ```

**Common recovery actions:**
- Build failure: usually a deps issue or SvelteKit config. Fix locally, commit, push to main.
- Rsync permission denied: check ownership of `/var/www/panel.areal.finance/` (should be owned by www-data or the nginx user). Re-run after fixing.
- Disk full: clean old build artifacts (`sudo rm -rf /var/www/panel.areal.finance/build.old`) or expand partition. Re-run after cleanup.
- Nginx down: restart it (`sudo systemctl restart nginx`). Re-run.

#### deploy-app RED

**Likely causes:**
- SSH connection failed.
- `areal-deploy-app` verb script failed (git pull, npm ci, npm run build, or rsync error).
- Health check failed (nginx not serving the app).
- Build failure due to TypeScript, missing deps, or environment config.

**Triage:**
1. Telegram alert → Actions page.
2. Expand the failed job. Look for the same categories as dashboard: SSH, build, rsync, health.
3. For server-side errors:
   ```bash
   ssh deployer@<vps-ip>
   # Check app build
   cd /opt/areal/app && npm run build 2>&1 | tail -100
   # Check rsync destination
   ls -lah /var/www/areal.finance/
   df -h /var/www/
   # Check nginx config for app
   sudo tail -20 /var/log/nginx/error.log
   ```

**Common recovery actions:**
- Build failure: fix locally, commit, push.
- Rsync/disk/nginx: same as dashboard.

#### deploy-bots STUB

The `deploy-bots` workflow is a skeleton placeholder for Phase 21+ work. Currently, `workflow_dispatch` triggers the workflow, but it only prints a stub message and does not deploy. Activation requires:
- Phase 21+ adds graceful-restart support to bot services.
- Phase 21+ adds `areal-deploy-bots` verb to `setup-deployer-user.sh` and creates `/usr/local/sbin/areal-deploy-bots`.
- Phase 21+ activates the push trigger in the workflow YAML.

Until then, this workflow is a no-op and should not be invoked.

### One-time operator setup

Follow these steps once to enable deploy automation on a fresh environment.

**1. VPS-side bootstrap** (one-time, run as root on the target VPS):

```bash
sudo bash scripts/setup-deployer-user.sh --pubkey-file /path/to/areal_deployer.pub
```

The script:
- Creates the `deployer` user and group (with UID/GID preferences, fallback to system defaults if taken).
- Installs `/usr/local/bin/areal-deploy` (forced-command wrapper that routes verbs).
- Installs `/usr/local/sbin/areal-deploy-{observability,dashboard,app,health}` (verb scripts).
- Installs `/etc/sudoers.d/areal-deployer` with NOPASSWD entries for the verbs and systemctl status commands.
- Appends the public key to `~deployer/.ssh/authorized_keys` with `command="…"` lock and no port/agent/X11/pty forwarding.

The script is **idempotent** — re-running it on an already-provisioned host converges to the same state without errors. All file operations check current state and skip writes if already correct.

**2. GitHub repository secrets** (one-time, run as an operator with admin access to the repo):

Create the following 5 secrets using the GitHub CLI or web UI:

```bash
# VPS hostname or IP address
gh secret set VPS_DEPLOYER_HOST --repo ArealFinance/areal --body "<vps-ip>"

# SSH user (must match --pubkey-file owner on VPS)
gh secret set VPS_DEPLOYER_USER --repo ArealFinance/areal --body "deployer"

# Private key in PEM format (ed25519 or RSA)
gh secret set VPS_DEPLOYER_KEY --repo ArealFinance/areal < ~/.ssh/areal_deployer

# Telegram bot token (from @BotFather)
gh secret set TELEGRAM_CI_BOT_TOKEN --repo ArealFinance/areal --body "<bot-token>"

# Telegram chat ID (format: -100... for supergroups, or plain number for channels)
gh secret set TELEGRAM_CI_CHAT_ID --repo ArealFinance/areal --body "<chat-id>"
```

**3. Telegram bot creation** (one-time, operator performs):

1. Message @BotFather on Telegram. Send `/newbot`.
2. Follow the prompts to create a new bot (e.g., "Areal CI Deploy Bot").
3. @BotFather returns a token: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`. Save this as `<bot-token>`.
4. Create a dedicated Telegram group or supergroup named "Areal CI" (separate from production-incident channels).
5. Add the bot to the group as an admin (it needs permission to post messages).
6. Send a test message in the group, e.g., `@ArealsAI_Bot_Name test`. The bot doesn't need to reply; this populates the group's metadata.
7. Call the Telegram API to get the chat ID:
   ```bash
   curl "https://api.telegram.org/bot<bot-token>/getUpdates" | jq '.result[0].message.chat.id'
   ```
   For supergroups, the ID is negative and prefixed: `-100123456789`. For channels, it's a plain number or negative without the `100` prefix. Use the full ID including the minus sign.
8. Save the chat ID as `<chat-id>` in the secret.

**4. Validation** (after all secrets are set):

Trigger a manual deploy using GitHub's `workflow_dispatch`:

```bash
gh workflow run deploy-observability.yml --repo ArealFinance/areal
```

Or, in the GitHub web UI: go to Actions → select `deploy-observability` → click "Run workflow" → confirm.

Wait for the workflow to complete. Expected outcome:
- All three jobs (preflight, deploy, notify) succeed.
- Telegram channel receives a message: `[OK] deploy-observability: success`.
- The status endpoint `https://status.areal.finance/api/health` returns HTTP 200 with JSON body (verify in the workflow's "Health check" step output).

### Migration from old `DEPLOYER_*` secrets

If you have previously set `DEPLOYER_HOST` and `DEPLOYER_SSH_KEY` secrets (from an earlier attempt or manual setup), migrate them to the new naming:

1. Set the new secrets (step 2 above): `VPS_DEPLOYER_HOST`, `VPS_DEPLOYER_USER`, `VPS_DEPLOYER_KEY`, and the Telegram secrets.

2. Run validation (step 4 above): trigger `workflow_dispatch` on one workflow and confirm success + Telegram alert.

3. Delete the old secrets only after validation passes:

   ```bash
   gh secret delete DEPLOYER_HOST --repo ArealFinance/areal
   gh secret delete DEPLOYER_SSH_KEY --repo ArealFinance/areal
   ```

**Order matters:** validate before deleting. If you delete first and the new secrets are misconfigured, all workflows will fail and you will not have the old secrets to fall back to.

### Manual fallback

The script `scripts/deploy-dashboard.sh` is preserved as an **emergency-only fallback** for when GitHub Actions is unavailable (e.g., GitHub outage, Actions service down, authentication token revoked). It performs the same steps as the `deploy-dashboard` workflow:

```bash
# Copy .env.example to .env and fill in DEPLOY_HOST and DEPLOY_PATH
cp .env.example .env
# Edit .env with VPS details
nano .env

# Run the deploy script
npm run dashboard:deploy
```

The script reads `DEPLOY_HOST` and `DEPLOY_PATH` from `.env`, builds the dashboard locally, then rsync's the build output to the remote webroot.

**Parity warning:** if you modify `scripts/deploy-dashboard.sh`, update `scripts/setup-deployer-user.sh` (the `install_verb_dashboard` function) to keep them in sync. Conversely, if the VPS verb script changes, test the fallback script to ensure the same steps are replicated. The intended use is Actions-first; the fallback is for outages only.

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
