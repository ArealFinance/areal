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
