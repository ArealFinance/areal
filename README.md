# Areal Finance

On-chain protocol on Solana for launching, owning, and participating in real-world assets (RWA). Tokenized ownership, on-chain governance, reward token issuance with NAV pricing, native AMM, and Merkle-based yield distribution — all built on the [Arlex](https://github.com/ArealFinance/arlex) framework.

This repository is a **meta-repo** that aggregates the five components of Areal as git submodules. Each component lives in its own repository with an independent release cycle.

- **Website:** https://areal.finance
- **Admin panel:** https://panel.areal.finance
- **Twitter:** [@areal_finance](https://twitter.com/areal_finance)

> **Layer 10 status (2026-04-29).** Layer 10 (bootstrap orchestration + zero-deployer-authority handover + audit/reproducibility tooling) is **code-complete** and frozen. The R20 RWT_MINT pin migration shipped behind a compile-time tripwire (`cargo build-sbf` fails if the dev-placeholder mint feature is on for a production build). All five contract-state authorities rotate atomically to the multisig in Phase 7; deployer-zero-authority is verified post-rotation by both POSITIVE and NEGATIVE on-chain audits. See [`docs.areal.finance/architecture/layer10-bootstrap`](https://docs.areal.finance/architecture/layer10-bootstrap) for the deploy walkthrough.

---

## Components

| Submodule | Repo | Role |
|---|---|---|
| [`contracts/`](./contracts) | [ArealFinance/contracts](https://github.com/ArealFinance/contracts) | Five on-chain programs (Rust, Arlex) |
| [`dashboard/`](./dashboard) | [ArealFinance/dashboard](https://github.com/ArealFinance/dashboard) | Admin and monitoring UI (SvelteKit) |
| [`bots/`](./bots) | [ArealFinance/bots](https://github.com/ArealFinance/bots) | Off-chain services (TypeScript) |
| [`docs/`](./docs) | [ArealFinance/docs](https://github.com/ArealFinance/docs) | Protocol documentation (Mintlify) |

Also:

- [ArealFinance/arlex](https://github.com/ArealFinance/arlex) — Solana framework the contracts are built on (not a submodule here; consumed by `contracts` as a Cargo git dependency).

---

## Architecture

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
           │ CPI (convert, compound)       │ CPI (vault_swap)
           ▼                                ▼
                ┌──────────────────────┐
                │  Native DEX          │
                │  (standard + CL)     │
                └──────────────────────┘
```

### Programs (in `contracts/`)

| Program | Instructions | Purpose |
|---|---|---|
| `ownership-token` | 8 | Tokenized ownership, revenue distribution, treasury |
| `futarchy` | 8 | Per-OT governance via CPI proposals |
| `rwt-engine` | 11 | Reward token minting, NAV bookkeeping, vault, DEX swaps |
| `native-dex` | 21 | StandardCurve + concentrated-liquidity AMM, **LiquidityNexus** (Layer 9) |
| `yield-distribution` | 12 | Merkle-proof claims, USDC → RWT conversion, **LiquidityHolding atomic drain** (Layer 9) |

#### Deployed program IDs (test-validator)

| Program | Address |
|---|---|
| `ownership-token` | `oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL` |
| `futarchy` | `FUTsbsdyJmEWa5LSYHWXMr9hQFyVsrJ1agGvRQGR1ARL` |
| `rwt-engine` | `RWT9hgbjHQDj98xP7FYsT5QYp5X32XyK6QfMRmFtARL` |
| `native-dex` | `DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL` |
| `yield-distribution` | `YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF` |

RPC: [`http://rpc.areal.finance`](http://rpc.areal.finance) (proxies to a local test-validator).

### Off-chain services (in `bots/`)

| Service | State |
|---|---|
| `merkle-publisher` | ✅ active |
| `pool-rebalancer` | ✅ active |
| `revenue-crank` | ✅ active |
| `convert-and-fund-crank` | ✅ active |
| `yield-claim-crank` | ✅ active |
| `nexus-manager` | ✅ active |

All 6 bots are spawned in Phase 8 of `scripts/deploy.sh` after the authority chain lands; each runs under a `proper-lockfile` flock to prevent double-instance.

## Bootstrap orchestration

`scripts/deploy.sh` is the single end-to-end orchestrator that takes a fresh validator to a fully-running protocol with zero deployer authority remaining. Eight phases:

| Phase | Step | Outcome |
|---|---|---|
| 1 | Deploy 5 contracts at vanity IDs | `.so` artifacts live on-chain |
| 2 | R20 RWT mint pin migration | YD program rebuilt with the canonical RWT mint pinned (compile-time tripwire) |
| 3 | SPRK OT initialisation + revenue/distributor wiring | Singletons + SPRK OT distributor seeded |
| 4 | DEX pool creation (RWT/USDC + auxiliary) | Master pool live, Nexus deposit/withdraw routes resolvable |
| 5 | Liquidity Nexus initialisation | Nexus singleton + manager rotation prepared |
| 6 | Bot wallet provisioning | 6 keypair files + airdrops |
| 7 | Authority transfer chain (atomic) | All 5 contract-state authorities rotated to multisig; POSITIVE + NEGATIVE audits land |
| 8 | Bot startup | 6 bots spawned in defined ordering, on-chain liveness probe gates Phase 8 completion |

See [`docs.areal.finance/architecture/layer10-bootstrap`](https://docs.areal.finance/architecture/layer10-bootstrap) for the full walkthrough.

---

## Quick start

```bash
git clone --recurse-submodules https://github.com/ArealFinance/areal.git
cd areal

# Contracts
npm run contracts:build           # cargo build-sbf in contracts/

# Dashboard
npm run install:all               # installs deps in dashboard/ and bots/
npm run dashboard:dev             # http://localhost:5173
npm run dashboard:build

# Bots
npm run bot:merkle
npm run bot:rebalancer
```

If you forgot `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

### Updating submodules

Each submodule tracks `main` of its source repo. To pull latest:

```bash
git submodule update --remote
# ...then commit the pointer update in this repo
```

---

## Requirements

See [INFRASTRUCTURE.md](./INFRASTRUCTURE.md) for toolchain versions, build notes, and deployment.

---

## Deployment

### Dashboard

```bash
cp .env.example .env              # set DEPLOY_HOST and DEPLOY_PATH
npm run dashboard:deploy          # vite build + rsync
```

Production: https://panel.areal.finance.

### Contracts

See the [contracts](https://github.com/ArealFinance/contracts) repo and [Arlex](https://github.com/ArealFinance/arlex) for deploy tooling.

---

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
