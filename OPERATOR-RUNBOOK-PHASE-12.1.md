# Operator Runbook — Phase 12.1 Backend Deploy

> Step-by-step for deploying the `@areal/backend` (Nest.js + Postgres + Redis)
> on the Fornex VPS that already runs the Phase 20 observability stack.
>
> Audience: the operator (you). Self-contained — no other docs required.
>
> Estimated time: **30–45 min** for the first run, **5 min** for re-runs.

---

## 1. Prerequisites

- [ ] SSH access to the Fornex VPS (you already have it from the Phase 20 deploy).
- [ ] The Phase 20 observability stack is running on the VPS (`docker ps` shows `prometheus`, `alertmanager`, `grafana`, `node-exporter`, `blackbox-exporter`).
- [ ] Cloudflared tunnel is configured and serving `panel.areal.finance` + `status.areal.finance`.
- [ ] You have a place to store secrets (suggested: `pass` or `age`-encrypted file in your dotfiles).
- [ ] Local: `gh` CLI authenticated against `ArealFinance` org (for setting GitHub repo secrets later).

---

## 2. SSH to VPS + clone meta-repo

```bash
ssh deployer@<fornex-ip>           # or root if deployer user not yet provisioned (Phase 25)

# Create the meta-repo workspace.
sudo mkdir -p /opt/areal
sudo chown "$USER:$USER" /opt/areal

# Clone with submodules. The backend image build requires sibling sdk/ and
# vendor/ directories — the meta-repo is the only checkout that has them.
cd /opt/areal
git clone --recurse-submodules https://github.com/ArealFinance/areal.git areal-meta
cd areal-meta

# Verify all submodules are at the right pointers.
git submodule status
```

You should see lines like:

```
 8c3f...  backend (heads/main)
 a9b2...  sdk (heads/main)
 ...
```

---

## 3. Generate secrets

Run these locally (NOT on the VPS — keep secrets in your password manager first, then transfer):

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)"
echo "REDIS_PASSWORD=$(openssl rand -hex 32)"
echo "JWT_SECRET=$(openssl rand -hex 32)"
echo "JWT_REFRESH_SECRET=$(openssl rand -hex 32)"
echo "BACKUP_PASSPHRASE=$(openssl rand -hex 32)"
```

Save all 5 to your password manager. **You will need `BACKUP_PASSPHRASE` to decrypt backups in DR.**

---

## 4. Configure `/opt/areal/areal-meta/backend/.env`

On the VPS:

```bash
cd /opt/areal/areal-meta/backend
cp .env.example .env
chmod 600 .env
nano .env       # or vi/vim
```

Required fields (paste the secrets generated in §3):

```bash
# Runtime
NODE_ENV=production              # MUST be 'production' — gates CORS allow-list
PORT=3010

# Database — backend talks to postgres over the docker bridge, sslmode=disable
# is intentional (see ARCHITECTURE.md "Postgres TLS" rationale).
POSTGRES_DB=areal
POSTGRES_USER=areal
POSTGRES_PASSWORD=<paste from §3>
POSTGRES_PORT=5432

# Redis
REDIS_PASSWORD=<paste from §3>
REDIS_PORT=6379

# JWT — distinct values, both required
JWT_SECRET=<paste from §3>
JWT_REFRESH_SECRET=<paste from §3>
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d

# Solana RPC — Helius / QuickNode / private node. Public mainnet-beta will
# rate-limit the indexer within minutes.
RPC_URL_MAINNET=https://mainnet.helius-rpc.com/?api-key=<your-key>
RPC_WS_MAINNET=wss://mainnet.helius-rpc.com/?api-key=<your-key>
RPC_URL_DEVNET=https://devnet.helius-rpc.com/?api-key=<your-key>
RPC_WS_DEVNET=wss://devnet.helius-rpc.com/?api-key=<your-key>
SOLANA_CLUSTER=devnet            # set to 'mainnet' once devnet rehearsal is GREEN

# Indexer
BACKFILL_BLOCKS=216000
RECONCILE_INTERVAL_SECS=300
MAX_RECONCILE_SIGNATURES=50000

# Backups (read by scripts/backup-postgres.sh, NOT by the Nest app)
BACKUP_PASSPHRASE=<paste from §3>
BACKUP_S3_BUCKET=s3://areal-backups
BACKUP_S3_ENDPOINT=https://<r2-account>.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=<r2 access key>
AWS_SECRET_ACCESS_KEY=<r2 secret key>
```

Verify:

```bash
ls -l .env       # must show -rw------- (600)
grep -c '^[A-Z]' .env   # should be ~25 lines
```

---

## 5. Run bootstrap

```bash
sudo bash /opt/areal/areal-meta/scripts/backend/bootstrap-fornex.sh
```

You should see, in order:

```
[INFO]  Areal backend bootstrap (Phase 12.1) starting
[STEP]  Verifying prerequisites
[INFO]  prerequisites OK ...
[STEP]  Ensuring docker network 'areal-net' exists
[STEP]  Syncing backend repo ...
[STEP]  Validating /opt/areal/areal-meta/backend/.env
[INFO]  .env OK (9 required vars present, no placeholders detected)
[STEP]  Rendering docker-compose.prod.yml from template
[STEP]  Starting postgres + redis (waiting for healthcheck)
[INFO]  postgres healthy
[STEP]  Building + starting backend
[STEP]  Running TypeORM migrations
[INFO]  migrations applied
[STEP]  Smoke testing /health + /metrics
[INFO]  /health -> 200 OK
[INFO]  /metrics -> 200 OK (Prometheus-scrapable from host)
[STEP]  Done. Next operator actions
```

If any step fails, the script halts with `[ERROR]` and exits non-zero. Re-run after fixing — it's idempotent.

**First-run quirks to expect:**
- The image build takes ~3-5 min (no Docker cache yet).
- `npm ci` inside the container pulls ~600 packages.
- Migrations run instantly on the first run (empty DB).

---

## 6. Cloudflared route

On the VPS, edit your existing cloudflared config (likely `/etc/cloudflared/config.yml`):

```bash
sudo nano /etc/cloudflared/config.yml
```

Open `/opt/areal/areal-meta/backend/scripts/cloudflared-config.snippet.yml` in another pane and merge the `ingress:` entries into your existing `ingress:` list. Order matters — the `path: /metrics` rule must come BEFORE the catch-all `api.areal.finance` rule.

Validate + reload:

```bash
sudo cloudflared tunnel ingress validate
sudo systemctl reload cloudflared
```

Add the DNS record (one-time per zone):

```bash
sudo cloudflared tunnel route dns <your-tunnel-name> api.areal.finance
```

Verify externally from your laptop:

```bash
curl -sS https://api.areal.finance/health | jq
# Expected: {"status":"ok","db":"up","rpc":"up","ts":"..."}

curl -sS -o /dev/null -w "%{http_code}\n" https://api.areal.finance/metrics
# Expected: 404 (blocked by ingress rule)
```

---

## 7. Prometheus scrape

The Phase 20 observability stack runs Prometheus on the same VPS. Add the backend scrape job:

```bash
nano /opt/areal/areal-meta/bots/observability/prometheus.template.yml
```

Append (under `scrape_configs:`):

```yaml
  - job_name: 'areal-backend'
    static_configs:
      - targets: ['localhost:9201']
        labels:
          service: 'backend'
          instance: 'fornex'
```

Re-run the obs bootstrap to re-render + reload Prometheus:

```bash
sudo bash /opt/areal/areal-meta/scripts/observability/bootstrap-fornex.sh
```

Verify Prometheus is scraping:

```bash
curl -sS http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | select(.labels.job=="areal-backend")'
```

`health: "up"` means it's working. If `health: "down"`, the most likely cause is the `127.0.0.1:9201` port not being published from the container — see §10 troubleshooting.

---

## 8. Backups

Install the cron entry as the `deployer` (or `root`) user:

```bash
sudo crontab -e -u root
```

Add:

```cron
# Areal backend nightly Postgres backup (03:00 UTC)
0 3 * * * /opt/areal/areal-meta/backend/scripts/backup-postgres.sh >> /var/log/areal-backup.log 2>&1
```

Test the backup manually before walking away:

```bash
sudo /opt/areal/areal-meta/backend/scripts/backup-postgres.sh
ls -la /var/backups/areal/
# Expect: areal-<timestamp>.sql.gz.enc, ~few KB on first run.

# Confirm metric was written:
cat /var/lib/node_exporter/areal_backup.prom
# areal_backup_last_result 1
```

If `BACKUP_S3_BUCKET` is set, also verify the upload:

```bash
aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 ls s3://areal-backups/
```

---

## 9. Smoke test (devnet RPC + indexer)

Within ~5 minutes of bootstrap completing:

```bash
# Indexer should be subscribing to the chain.
docker compose -f /opt/areal/areal-meta/backend/docker-compose.prod.yml \
               --env-file /opt/areal/areal-meta/backend/.env \
               logs --tail=50 backend | grep -E '(ChainListener|backfill|reconcile)'
```

You should see lines like `ChainListener subscribed`, `backfill started`, etc.

Check Prometheus that events are arriving:

```bash
curl -sS http://localhost:9090/api/v1/query?query=events_persisted_total | jq '.data.result'
```

Should show a non-zero value within 5 min of devnet activity.

---

## 10. Common issues

### Image build fails: "Cannot find module '@areal/sdk'"

The backend Dockerfile expects sibling `sdk/` and `vendor/` directories in the build context. This works only when running `bootstrap-fornex.sh` from the meta-repo (which has them as submodules). If you cloned only the backend submodule alone, image build will fail.

Fix: clone the meta-repo with submodules to `/opt/areal/areal-meta` (per §2) and re-run.

### `/health` returns 503

```bash
docker compose -f /opt/areal/areal-meta/backend/docker-compose.prod.yml \
               --env-file /opt/areal/areal-meta/backend/.env \
               exec backend curl -sS http://127.0.0.1:3010/health | jq
```

- `db: down` → check `docker compose logs postgres`. If you rotated `POSTGRES_PASSWORD` after the first run, the postgres volume still has the old password baked in via initdb. Recreate: `docker compose down postgres && docker volume rm backend_postgres-data` (DESTRUCTIVE — only on a fresh deploy).
- `rpc: down` → check `RPC_URL_*` correctness. Public `mainnet-beta`/`devnet` will rate-limit and flap `up`/`down`.

### Port conflict on 3010 or 9201

```bash
sudo ss -tlnp | grep -E ':(3010|9201)'
```

If something else is bound to those ports (likely a previous deploy attempt), stop it:

```bash
docker compose -f /opt/areal/areal-meta/backend/docker-compose.prod.yml --env-file .env down
```

### Bull queue stuck

```bash
docker compose -f /opt/areal/areal-meta/backend/docker-compose.prod.yml --env-file .env \
  exec redis redis-cli -a "$REDIS_PASSWORD" llen bull:indexer:wait
```

If depth keeps growing without draining: `docker compose restart backend`.

### RPC rate limits

Public RPCs (`api.mainnet-beta.solana.com`) will rate-limit the indexer within minutes — backfill is especially heavy. Always use a dedicated provider (Helius / QuickNode / Triton) for production. Free Helius tier covers Phase 12.1 traffic comfortably.

### Prometheus scrape "down"

Check the metrics port is reachable from the host:

```bash
curl -sS http://127.0.0.1:9201/metrics | head -5
```

If this is empty / refused, the prod compose template isn't publishing 9201 to the host. Re-pull the latest backend ref (the published port mapping was added in Phase 12.1 deploy infra commit) and re-run bootstrap.

---

## 11. GitHub Actions deploy (optional, after Phase 25 wiring)

Once the `deployer` user + restricted sudoers are set up on the VPS (Phase 25 §A), pushes to `backend/main` will trigger `backend/.github/workflows/deploy.yml`. Required GitHub repo secrets on `ArealFinance/backend`:

```bash
gh secret set DEPLOY_USER --body "deployer"               --repo ArealFinance/backend
gh secret set DEPLOY_HOST --body "<fornex-ip>"            --repo ArealFinance/backend
gh secret set DEPLOY_SSH_KEY < ~/.ssh/areal_deployer_key  --repo ArealFinance/backend  # private key
gh secret set DEPLOY_KNOWN_HOSTS < ~/.ssh/areal_known_hosts --repo ArealFinance/backend
```

Trigger a deploy manually:

```bash
gh workflow run deploy.yml --ref main --repo ArealFinance/backend
gh run watch --repo ArealFinance/backend
```

Skip a deploy on a doc-only commit by including `[skip deploy]` in the commit message.

---

## 12. Final checklist

- [ ] `https://api.areal.finance/health` returns `{"status":"ok",...}`.
- [ ] `https://api.areal.finance/metrics` returns 404.
- [ ] `https://api.areal.finance/api/docs` shows Swagger UI.
- [ ] Prometheus target `areal-backend` is `up`.
- [ ] `events_persisted_total` is incrementing on devnet.
- [ ] First nightly backup ran (or manual test ran) and produced `/var/backups/areal/areal-*.sql.gz.enc`.
- [ ] `BACKUP_PASSPHRASE` is in your password manager (NOT only on the VPS).
- [ ] Cloudflared route is reloaded; `cloudflared tunnel ingress validate` is green.

If all 8 are checked, Phase 12.1 deploy is acceptance-ready.
