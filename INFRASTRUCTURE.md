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
