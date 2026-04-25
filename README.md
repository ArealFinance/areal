# Areal Finance

On-chain protocol on Solana for launching, owning, and participating in real-world assets (RWA). Tokenized ownership, on-chain governance, reward token issuance with NAV pricing, native AMM, and Merkle-based yield distribution — all built on the [Arlex](https://github.com/ArealFinance/arlex) framework.

This repository is a **meta-repo** that aggregates the five components of Areal as git submodules. Each component lives in its own repository with an independent release cycle.

- **Website:** https://areal.finance
- **Admin panel:** https://panel.areal.finance
- **Twitter:** [@areal_finance](https://twitter.com/areal_finance)

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
| `native-dex` | 12 | StandardCurve + concentrated-liquidity AMM |
| `yield-distribution` | 10 | Merkle-proof claims, USDC → RWT conversion |

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
| Revenue crank, convert-and-fund crank, yield-claim crank, Nexus manager | 🚧 planned |

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
