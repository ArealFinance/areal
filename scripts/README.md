# scripts/

Operational tooling for the Areal Finance meta-repo. All scripts assume the
working directory is the repo root unless noted otherwise.

| Script | Purpose |
|---|---|
| `e2e-bootstrap.sh` | Single-command bootstrap from zero — provisions `solana-test-validator`, deploys the 5 programs at vanity IDs, runs on-chain init, generates bot keypairs + airdrops, renders bots' `.env` files. Layer 9 Substep 12. |
| `verify-program-ids.sh` | Cross-checks every `*_PROGRAM_ID` constant pinned across crates against the canonical vanity base58. R12 from Layer 8 decisions. |
| `cu-profile.sh` | R24 acceptance harness — captures live `computeUnitsConsumed` per ix and writes a P50/P95/max table into the internal CU-profile doc. Sources env from `data/e2e-bootstrap.env`. R46 best-effort grep for BPF stack overflows is bundled (SD-30). |
| `e2e-runner.sh` | R-58 operator-driven Layer 9 scenario runner. Reads the bootstrap artifact, gate-checks (R20 / R57), and dispatches one full live-submit cycle per crank. |
| `deploy-dashboard.sh` | Builds + deploys the SvelteKit dashboard. Independent of the chain bootstrap. |
| `lib/bootstrap-init.ts` | On-chain init driver invoked by stage 6 of `e2e-bootstrap.sh`. Idempotent. Reads/writes `data/e2e-bootstrap.json` (+ `.secrets.json` per Substep 12 sec M-2). |
| `lib/cu-profile.ts` | R24 + R46 live profiler — invoked by `cu-profile.sh`. |
| `lib/e2e-runner.ts` | Tsx orchestrator behind `e2e-runner.sh`. |
| `lib/render-env.ts` | Renders `bots/<bot>/.env` from `.env.example` templates + the artifact map. Never modifies templates. |

### Layer 9 deferred follow-ups (Substep 14 closeout)

- **R-T2** — extend `bots/.e2e/parity-tx-builders.test.ts` with a crank-side
  builder for `withdraw_liquidity_holding` once R20 (RWT_MINT pin migration)
  lands. Today only the dashboard owns that ix; the placeholder test asserts
  intent without claiming parity.
- **R-T5** — wire dashboard-side test coverage for the Layer 9 LP-fee
  claim modal once the on-chain handler stabilises (post-R57 + post-fee-share
  shape decision in `plan/layer-09-decisions.md`).

## Vanity keypairs

The five program-ID keypairs live under `keys/vanity/` and are **not committed**
(R32 hygiene — `.gitignore` rule on `keys/`). New contributors must obtain them
from the team out-of-band before running the bootstrap.

Required files in `keys/vanity/`:

- `oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL.json`  (ownership-token)
- `DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL.json` (native-dex)
- `RWT9hgbjHQDj98xP7FYsT5QYp5X32XyK6QfMRmFtARL.json`  (rwt-engine)
- `YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF.json`  (yield-distribution)
- `FUTsbsdyJmEWa5LSYHWXMr9hQFyVsrJ1agGvRQGR1ARL.json` (futarchy)

The bootstrap refuses to run if any are missing.

## e2e-bootstrap.sh

### Quick start

```bash
BOOTSTRAP_TARGET=localhost bash scripts/e2e-bootstrap.sh
```

Cold run: ~5–8 min (most of it is `cargo build-sbf`). Warm restart with
`KEEP_LEDGER=1`: ~30 s.

### Requirements

- `solana-cli` ≥ 2.0 (test-validator + program deploy)
- `cargo-build-sbf` (Solana SDK toolchain)
- Node ≥ 20, npm
- python3 (used for in-script JSON manipulation)
- `bots/node_modules` populated (`npm install --prefix bots`)

### Env knobs

| Var | Default | Purpose |
|---|---|---|
| `BOOTSTRAP_TARGET` | (required) | `localhost` only for Substep 12; `devnet` is reserved for Substep 13/14 |
| `KEEP_LEDGER` | `0` | Reuse existing `data/test-ledger/`; skip teardown |
| `SKIP_BUILD` | `0` | Skip `cargo build-sbf` (use cached `.so` files) |
| `SBF_PARALLEL` | `0` | Build the 5 programs in parallel |
| `DEPLOYER_AIRDROP_SOL` | `100` | Airdrop target for the deployer |
| `CRANK_AIRDROP_SOL` | `5` | Per-bot airdrop |
| `OT_TEST_COUNT` | `3` | Number of test OTs to create + distributors to wire |
| `VALIDATOR_LEDGER_DIR` | `data/test-ledger` | Override ledger path |

### Stages

```
0  preflight       — tools + vanity keys present, BOOTSTRAP_TARGET valid
1  validator       — pkill old + start fresh test-validator (or reuse on KEEP_LEDGER=1)
2  deployer        — read/generate deploy keypair, airdrop 100 SOL
3  build           — cargo build-sbf for 5 programs (sequential or SBF_PARALLEL=1)
4  deploy          — solana program deploy × 5 at vanity IDs
5  verify-ids      — invoke scripts/verify-program-ids.sh
6  init            — tsx scripts/lib/bootstrap-init.ts (mints, singletons, master pool, OTs)
7  bots            — generate 4 bot keypairs + airdrop 5 SOL each (+ merkle-publisher mock)
8  render-env      — tsx scripts/lib/render-env.ts (writes bots/*/.env)
9  smoke           — solana program show × 5 + getAccountInfo on Nexus PDA
10 summary         — write data/e2e-bootstrap.env, print next-steps banner
```

### Outputs (gitignored)

```
data/e2e-bootstrap.log    — timestamped per-stage log
data/e2e-bootstrap.json   — machine-readable artifact map (programs, mints, PDAs, OTs, bots)
data/e2e-bootstrap.env    — sourced by cu-profile.sh + bots/.e2e tests
data/test-ledger/          — validator ledger
data/test-validator.pid    — validator pid for reuse
bots/<crank>/data/<crank>.json × 4 + bots/merkle-publisher/local-mock-keypair.json
bots/<bot>/.env × 5
```

### Idempotency

- `KEEP_LEDGER=1` short-circuits stages 1 (no validator restart).
- Deploy stage skips programs already at the canonical address.
- Init driver reads each PDA before init; reflects existing state into the
  artifact and skips already-initialized accounts. Test mint keypairs are
  reused from the artifact map across reruns.

### Known limitations

- `YD::initialize_liquidity_holding` requires the YD program to have
  `RWT_MINT` constant pinned to the actual on-chain mint bytes. The bootstrap
  treats this step as best-effort: failure is logged + recorded under
  `init_skipped` in the artifact, but doesn't abort. Use the R20 migration
  runbook (rebuild YD with the canonical `RWT_MINT`) before relying on
  liquidity-holding flows in E2E tests.
- `DEX::initialize_nexus` (Layer 9) requires the dashboard IDL at
  `dashboard/src/lib/idl/native-dex.json` to be regenerated to include the
  Layer 9 ix. If the IDL is stale, this step is skipped with a warning.
- The bootstrap targets localhost only. Devnet (Substep 13/14) and mainnet
  (Layer 10) are out of scope.

## verify-program-ids.sh

Re-derives each `*_PROGRAM_ID` byte array from the canonical vanity base58 and
asserts byte-equality against every shadow copy across the workspace. Drift
fails CI with a clear DRIFT line per offender.

```bash
bash scripts/verify-program-ids.sh
```

## cu-profile.sh

R24 live CU-budget acceptance harness. Submits each Layer 8 / Layer 9 ix N
times, parses `computeUnitsConsumed` from `getTransaction`, and writes a P50/
P95/max table into the internal CU-profile doc.

Requires the bootstrap to have run first:

```bash
bash scripts/e2e-bootstrap.sh
source data/e2e-bootstrap.env
bash scripts/cu-profile.sh
```

Without `E2E_BOOTSTRAP_DONE=1` it exits 0 with a "needs bootstrap" message.

## e2e-runner.sh

R-58 operator-driven Layer 9 scenario runner. Reads
`data/e2e-bootstrap.json`, gate-checks (R20 / R57) and dispatches one
full live-submit cycle per crank.

```bash
# Pick a scenario:
bash scripts/e2e-runner.sh --scenario revenue-only
bash scripts/e2e-runner.sh --scenario nexus-only   # gated on R57
bash scripts/e2e-runner.sh --scenario lh-drain     # gated on R20
bash scripts/e2e-runner.sh                         # full (default; degrades per-flow)
```

Exit codes: 0 (ok) / 1 (any flow errored) / 2 (scenario gated on unmet
contract precondition). Writes a JSON artifact at
`data/e2e-runner-<scenario>-<UTC>.json`.

Gating reads `init_skipped[]` and `init_failed[]` from the bootstrap
artifact — if `--scenario lh-drain` is requested while
`initialize_liquidity_holding` is in `init_failed`, the runner exits 2
with "gated on R20" before attempting any submit.

## deploy-dashboard.sh

Pre-existing — builds the dashboard and pushes to the static host. Independent
of the chain bootstrap.
