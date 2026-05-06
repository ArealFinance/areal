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

## Observability

> **Status:** Phase 20 foundation (templates + Fornex deploy). Phases 21-24 layer bot instrumentation, chain invariants, frontend Sentry, and public docs/runbooks on top.

### Stack

| Component | Purpose |
|---|---|
| **Prometheus** | Pull-based metrics scraping (`/metrics` endpoints), 15-day TSDB retention, 5GB cap |
| **Alertmanager** | Alert routing → Telegram (separate channels for `critical` and `warning`) |
| **Grafana** | Dashboards, public read-only access via cloudflared |
| **node_exporter** | Host metrics (CPU/RAM/disk/network) |
| **blackbox_exporter** | HTTP probes against public endpoints (panel/app/RPC) |
| **UptimeRobot** (external) | Independent uptime check — only signal that survives if the Fornex VPS itself goes down |

### Public face

`https://status.areal.finance` serves Grafana with **anonymous Viewer** access:
- No Edit, no Explore (the entire `/explore` route is disabled globally in `grafana.ini`).
- No login form bypass — admins still authenticate normally.
- Datasource access mode: `proxy` (Prometheus is **not** exposed publicly even indirectly).

This is part of the project's commitment to ops transparency, particularly during the Solana Colosseum hackathon. External operators can deploy the same stack against the protocol's RPC endpoint by copying `bots/observability/.env.example` and running `scripts/observability/bootstrap-fornex.sh`.

### Locked port allocation (all `127.0.0.1`)

| Port | Service | Phase |
|---|---|---|
| 9090 | Prometheus | 20 |
| 9093 | Alertmanager | 20 |
| 9100 | node_exporter | 20 |
| 9115 | blackbox_exporter | 20 |
| 3000 | Grafana (publicly via cloudflared) | 20 |
| 9101..9106 | 6 bot cranks (merkle-publisher, revenue-crank, pool-rebalancer, convert-and-fund-crank, yield-claim-crank, nexus-manager) | 21 |
| 9201 | chain-invariants exporter | 22 |

### Repository layout

- **Configuration templates** — `bots/observability/` (in the `bots/` submodule):
  - `docker-compose.template.yml`, `prometheus.template.yml`, `alertmanager.template.yml`, `grafana.template.ini`
  - Provisioning: `grafana/provisioning/datasources/datasources.template.yml`, `grafana/provisioning/dashboards/dashboards.yml`
  - Dashboards: `grafana/dashboards/infra.json` — mounted to `/etc/grafana/dashboard-files/` in container, separate from provisioning provider YAMLs (Phase 20 ships only Infra; Phase 21+ adds Areal — Protocol Health, Bot Deep Dive, Chain Invariants)
  - Alert rules: `prometheus/rules/infra.yml` (Phase 20: 4 base alerts; Phase 21+ adds bot-specific and chain-invariant rules)
  - `.env.example` — template (all values empty by convention)
  - `README.md` — operator quickstart for `bots/observability/`
- **Bootstrap script** — `scripts/observability/bootstrap-fornex.sh` (in this meta-repo).
- **Hostname lint** — `scripts/lint/check-template-hostnames.sh` (in this meta-repo).
- **Pre-commit hooks** — `.pre-commit-config.yaml` includes the hostname lint; `.gitleaks.toml` includes Telegram bot token / Slack webhook / Sentry DSN regex rules.

### Operator runbook (manual post-pipeline actions)

Phase 20 ships the artifacts. Bringing them up on the Fornex VPS is an **operator action** not automated by the pipeline.

1. **Prepare environment file.** On the Fornex VPS:
   ```bash
   sudo mkdir -p /etc/areal-obs && sudo chmod 700 /etc/areal-obs
   sudo cp /opt/areal/bots/observability/.env.example /etc/areal-obs/.env
   sudo chmod 600 /etc/areal-obs/.env && sudo chown root:root /etc/areal-obs/.env
   sudo $EDITOR /etc/areal-obs/.env  # fill in real values
   ```
   - Generate `GF_SECURITY_ADMIN_PASSWORD` via `openssl rand -base64 32`.
   - Get Telegram bot token via `@BotFather` (Telegram). Get chat IDs by sending one message to the channel and reading `https://api.telegram.org/bot<TOKEN>/getUpdates`.
   - Use **separate** chat IDs for `TELEGRAM_CHAT_ID_CRITICAL` and `TELEGRAM_CHAT_ID_WARNING` (independence requirement) OR same ID with different routing if you accept the noise.

2. **Clone meta-repo on VPS** (if not already):
   ```bash
   sudo git clone --recurse-submodules https://github.com/ArealFinance/areal /opt/areal
   ```
   Or pull latest if already cloned: `sudo git -C /opt/areal pull && sudo git -C /opt/areal submodule update --init --recursive`.

3. **Run bootstrap script:**
   ```bash
   sudo /opt/areal/scripts/observability/bootstrap-fornex.sh
   ```
   Expected outcome: 5 healthy containers in `docker compose ps`. The script also adds 2GB swap if missing, validates rendered configs (`promtool`, `amtool`, `docker compose config`), and audits all port bindings to ensure they're 127.0.0.1 only.

   To preview without applying: `sudo /opt/areal/scripts/observability/bootstrap-fornex.sh --dry-run`.

4. **Cloudflared route.** The Fornex VPS already runs a `cloudflared` tunnel. Add a new ingress rule mapping `status.areal.finance` to `http://127.0.0.1:3000`:
   ```yaml
   # in your existing /etc/cloudflared/config.yml (NOT in this repo):
   ingress:
     - hostname: status.areal.finance
       service: http://127.0.0.1:3000
     - service: http_status:404  # default catch-all (keep at end)
   ```
   Then: `sudo cloudflared service restart`.

5. **Cloudflare DNS.** In the Cloudflare dashboard for `areal.finance`:
   - Add CNAME record: `status` → `<your-tunnel-id>.cfargotunnel.com`
   - Proxy status: **Proxied** (orange cloud) — provides DDoS protection and TLS termination.

6. **UptimeRobot setup** (free tier, 5-min interval):
   - Create an account at uptimerobot.com if you don't have one.
   - Add three HTTP(S) monitors:
     - `https://panel.areal.finance`
     - `https://app.areal.finance`
     - `https://rpc.areal.finance/health`
   - Configure Telegram integration with a **separate** Telegram channel (NOT the Alertmanager channel — must be independent so a Fornex-VPS outage still triggers external alert).

7. **Verify.** From any machine:
   ```bash
   curl -I https://status.areal.finance/login          # expect HTTP/2 200, Grafana cookie
   curl -fsS https://status.areal.finance/api/health   # expect {"database":"ok",...}
   ```
   On the Fornex VPS:
   ```bash
   ss -tlnp | grep -E ':(9090|9093|9100|9115|3000)\s'  # expect ALL bind 127.0.0.1
   ```

### Updating the stack

Pull latest meta-repo + `bots/` submodule, then re-run bootstrap:
```bash
sudo git -C /opt/areal pull
sudo git -C /opt/areal submodule update --remote bots
sudo /opt/areal/scripts/observability/bootstrap-fornex.sh
```
Bootstrap is idempotent — re-running with no template changes is a no-op except for `docker compose up -d` reconciliation. With template changes, containers are recreated as needed.

### Phase 21 follow-up

The `Infra` dashboard is currently provisioned in the public default folder so `status.areal.finance` has something to render in Phase 20. Phase 21 will add the `Areal — Protocol Health` dashboard as the public default and **demote `Infra` to an internal folder** gated behind admin authentication (folder permissions in Grafana provisioning). Until then, the only public dashboard is Infra — node_exporter recon value is acceptable at this stage given the Fornex VPS is publicly known to host the test-validator.

### Security invariants

- All `/metrics` endpoints bind `127.0.0.1` only — verified by `bootstrap-fornex.sh` audit step before bringing the stack up.
- All secrets live exclusively in `/etc/areal-obs/.env` on the VPS (`chmod 600`, `root:root`).
- `.env.example` values are always empty after `=`. The bootstrap script aborts if any value is non-empty in `.env.example`.
- Anonymous Grafana access is **Viewer only** with **Explore globally disabled**.
- Cloudflared tunnel handles DDoS protection and TLS termination — no public ports opened on the VPS for the observability stack itself.
- Pre-commit hooks: `gitleaks` scans for Telegram bot tokens, Slack webhooks, Sentry DSN. `check-template-hostnames.sh` rejects literal hostnames in `bots/observability/**/*.template.{yml,ini}` (whitelist: `localhost`, `127.0.0.1`, `0.0.0.0`, `${VAR}`, docker-compose service names).

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
