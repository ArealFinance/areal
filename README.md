# Areal Finance

On-chain protocol on Solana for launching, owning, and participating in real-world assets (RWA). Tokenized ownership, on-chain governance, reward token issuance with NAV pricing, native AMM, and Merkle-based yield distribution — all built on the [Arlex](https://github.com/) framework (Pinocchio-based, no Anchor).

- **Website:** https://areal.finance
- **Admin panel:** https://panel.areal.finance
- **Docs:** https://github.com/ArealFinance/docs
- **Twitter:** [@areal_finance](https://twitter.com/areal_finance)

---

## Architecture

Five on-chain programs coupled via CPI, plus off-chain services and an admin dashboard.

```
┌──────────────────────┐        ┌──────────────────────┐
│  Ownership Token     │◄─CPI───│  Futarchy            │
│  (revenue, treasury) │        │  (governance)        │
└──────────┬───────────┘        └──────────────────────┘
           │ CPI (claim)
           ▼
┌──────────────────────┐        ┌──────────────────────┐
│  Yield Distribution  │◄─CPI───│  RWT Engine          │
│  (Merkle streams)    │───CPI─►│  (NAV, vault)        │
└──────────┬───────────┘        └──────────┬───────────┘
           │ CPI (convert, compound)       │ CPI (vault swap)
           ▼                                ▼
                ┌──────────────────────┐
                │  Native DEX          │
                │  (standard + CL)     │
                └──────────────────────┘
```

### Programs

| Program | Instructions | Purpose |
|---|---|---|
| `ownership-token` | 8 | Tokenized ownership of an asset; revenue distribution; treasury |
| `futarchy` | 8 | Per-OT governance with proposals executed via CPI |
| `rwt-engine` | 11 | Reward token minting, NAV bookkeeping, vault management |
| `native-dex` | 12 | StandardCurve + concentrated-liquidity AMM, swaps, LP |
| `yield-distribution` | 10 | Merkle-proof claims, USDC → RWT conversion |

### Off-chain services

| Service | State | Role |
|---|---|---|
| `merkle-publisher` | ✅ active | Builds yield distribution Merkle roots, publishes on-chain, serves proofs |
| `pool-rebalancer` | ✅ active | Keeps concentrated-liquidity pools active by shifting bins around price |
| Revenue crank | 🚧 planned | Distributes OT revenue on cooldown |
| Convert & Fund crank | 🚧 planned | Converts USDC accumulators into RWT and funds distributors |
| Yield Claim crank | 🚧 planned | Claims yield on behalf of users |
| Nexus Manager | 🚧 planned | Manages Liquidity Nexus — shared concentrated-liquidity layer |

### Dashboard

SvelteKit admin UI (`@sveltejs/adapter-static` → nginx). Covers all five programs: initialisation, state inspection, and end-to-end test scenarios driven from the browser.

---

## Repository layout

```
areal/
├── contracts/                  # Rust — 5 Solana programs (Cargo workspace)
│   ├── ownership-token/
│   ├── futarchy/
│   ├── rwt-engine/
│   ├── native-dex/
│   └── yield-distribution/
├── dashboard/                  # SvelteKit admin UI (npm workspace member)
├── bots/                       # TypeScript off-chain services (npm workspace members)
│   ├── merkle-publisher/
│   └── pool-rebalancer/
├── docs/                       # Submodule → ArealFinance/docs (protocol specs, Mintlify)
├── scripts/                    # Build / deploy helpers
├── Cargo.toml                  # workspace root
└── package.json                # npm workspaces root
```

---

## Requirements

| Tool | Version |
|---|---|
| Rust | 1.94.1 (toolchain `1.89.0` for SBF) |
| Agave (Solana CLI) | 3.1.11 |
| Anchor CLI | 0.32.1 (used for deploy only, not contracts) |
| Node.js | ≥ 22.17.0 |
| `git-filter-repo` | optional, for monorepo splits |

Contracts depend on the [Arlex](https://github.com/ArealFinance/arlex) framework (also hosted under the Areal Finance org). Cargo fetches it automatically from GitHub on first build — no separate clone required.

### Platform-tools workaround

`cargo-build-sbf` from Agave 3.1.11 pulls platform-tools v1.48 (rustc 1.84.1) which does not support `edition2024`. Symlink to v1.54:

```bash
ln -sf ~/.cache/solana/v1.54 ~/.cache/solana/v1.48
```

---

## Quick start

```bash
# Clone with submodule
git clone --recurse-submodules git@github.com:ArealFinance/areal.git
cd areal

# Install JS deps (dashboard + bots)
npm install

# Build all contracts
cargo build-sbf

# Run dashboard locally
npm run dashboard:dev
```

### Common scripts

```bash
# Dashboard
npm run dashboard:dev        # vite dev
npm run dashboard:build      # production build (adapter-static)
npm run dashboard:check      # svelte-check
npm run dashboard:deploy     # build + rsync to $DEPLOY_HOST

# Bots
npm run bot:merkle           # start merkle publisher
npm run bot:rebalancer       # start pool rebalancer
```

---

## Deployment

### Contracts

Deployed program IDs and deploy procedure live in per-contract `Cargo.toml` and scripts. For a test validator, see Arlex deploy tooling.

### Dashboard

```bash
cp .env.example .env           # set DEPLOY_HOST, DEPLOY_PATH
npm run dashboard:deploy       # vite build + rsync
```

Production: https://panel.areal.finance (nginx, SPA fallback).

---

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
