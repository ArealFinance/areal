# Areal earn + staking — Mainnet Deploy Runbook

> Proven end-to-end on devnet (v4 rehearsal, 2026-06-12). This is the exact
> sequence that was executed and verified on-chain; mainnet differs only in the
> config VALUES below. Programs are **upgradeable**; authority + upgrade
> authority are handed to the Squads multisig at the end.

## Fixed mainnet values

| Role | Address |
|------|---------|
| Multisig (authority + upgrade authority) — Squads vault | `ApDQBVjwy47EAffSehF8k18orUbJaLSURVEdx95bV8oA` |
| `basket_vault` (USDC treasury, owned by the multisig) | `Ew8GFA29zsUXzf8dmDmesbHVCSfXVAVnPWYtr9nF3sqo` |
| USDC mint (mainnet) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Genesis RWT amount ($25k car @ NAV $1) | `25000000000` (25,000 RWT, 6dp) |
| earn-RWT mint (vanity, `keys/mainnet/rwt-mint.json`) — created at bootstrap, authority = earn config PDA | `RWTeFt9M635Tf6w6yveAoXQR2ZwfXs7MfA7W3grDuGT` |
| stRWT mint (vanity, `keys/mainnet/strwt-mint.json`) — created at staking bootstrap | `sRWTy1bkqvRegb31RETanhbAtJ7eXN6XsTvaqBRh6kA` |
| → `EARN_RWT_MINT` (staking pin) = the earn-RWT mint above (chicken-egg resolved: vanity mint known upfront) | `RWTeFt9…` |

## Values to fill before building

- [x] **earn program ID** = `GTASb5UcQEkcRWuMwfoNABBBNJitdxWByobMLZZ2UCw8` (`keys/mainnet/earn-program.json`, random/non-vanity, gitignored).
- [x] **staking program ID** = `9tEKvDwkqkveBvmQfEzgPKWSNCDTGSSqYz4ZE6pP5DGY` (`keys/mainnet/staking-program.json`).
- [x] **deployer pubkey** = `BOOTSTRAP_AUTHORITY` = `CyFCB88B3kMiPJSFLSXqP1u12dULeBaPh9qqjqquA1Np` (keypair `keys/mainnet/deployer.json`, gitignored, chmod 600). One-time bootstrap key; god-mode DURING bootstrap only, inert after handover. **BACK UP THE FILE — it is NOT in git; a disk loss loses the key.**
- [x] **genesis recipient** = `GoiuMiTocoY5M3NuRrcJDJ25AjruPieRZitvnEkCFtR9` (the multisig vault's RWT ATA — treasury holds the founder allocation; created idempotently at bootstrap).
- [x] **dao_fee_destination** = `68AHfVCW4CJGCKxfUdLgj3WKe8qF8eSztmEd7VnPFYkg` (deployer's USDC ATA, ≠ basket_vault). TEMPORARY — multisig redirects post-launch via update_config.

## Phase 0 — Pins + build (mainnet, NOT --features devnet)

In `contracts/`, set the `#[cfg(not(feature = "devnet"))]` branches:
1. `earn/src/lib.rs` + `staking/src/lib.rs` — `declare_id!` → the real program IDs.
2. `earn/src/constants.rs` — `USDC_MINT` → `EPjFWdd5…` (mainnet USDC). *(Note: currently an unconditional const pinned to testnet — make it mainnet for the mainnet build.)*
3. `staking/src/constants.rs` — `EARN_RWT_MINT` (non-devnet) → the earn-RWT mint created in Phase 1 step 1 (chicken-egg: create the mint first, then pin + build staking).
4. both — `BOOTSTRAP_AUTHORITY` (non-devnet) → deployer pubkey.

Build: `cargo build-sbf --manifest-path earn/Cargo.toml` and `… staking/Cargo.toml`
(toolchain: `$HOME/.local/share/solana/install/active_release/bin`).
**Do NOT commit these mainnet pins to `main`** — keep them on a deploy branch / local.

## Phase 1 — Deploy + bootstrap (all signed by the deployer)

1. Create the earn-RWT mint (6dp), set mint authority = the **precomputed** earn config PDA
   (`find_program_address(["earn_config"], <earn program id>)`); freeze authority = none, supply 0.
   → pin its address as `EARN_RWT_MINT` in staking, then build staking (Phase 0 step 3).
2. `solana program deploy earn.so  --program-id <earn-keypair>  --keypair <deployer>  --url mainnet-beta`
3. `solana program deploy staking.so --program-id <staking-keypair> --keypair <deployer> --url mainnet-beta`
   (deployer is the upgrade authority initially.)
4. `earn.initialize(authority = <deployer>)`
5. `earn.seed_genesis(amount = 25000000000)` → recipient = the genesis wallet's
   earn-RWT ATA, derived by the script (allowOwnerOffCurve = true).
   → supply 25k, capital 25k, **NAV = $1.00**, genesis RWT minted to the treasury. *(one-time, supply==0)*
6. `earn.update_config(mint_fee_bps, min_mint_amount, dao_fee_destination, basket_vault = Ew8GFA29…)`
   → enables user minting. **basket_vault ≠ dao_fee_destination** (contract rejects equality).
7. `staking.initialize(…)`

   (`scripts/lib/bootstrap-earn.ts` performs 4–7. Env:
   ```
   EARN_GENESIS_RWT=25000000000
   EARN_GENESIS_RECIPIENT=ApDQBVjwy47EAffSehF8k18orUbJaLSURVEdx95bV8oA  # multisig VAULT WALLET (off-curve PDA); the script derives its earn-RWT ATA GoiuMiTo… — pass the WALLET, NOT the ATA
   EARN_RWT_MINT_KEYPAIR=keys/mainnet/rwt-mint.json    # vanity earn-RWT mint (v5)
   STRWT_MINT_KEYPAIR=keys/mainnet/strwt-mint.json     # vanity stRWT mint (v5)
   EARN_BASKET_VAULT=Ew8GFA29zsUXzf8dmDmesbHVCSfXVAVnPWYtr9nF3sqo
   ```
   Note: `EARN_GENESIS_RECIPIENT` is the multisig vault WALLET (an off-curve PDA).
   The script derives + idempotently creates its earn-RWT ATA `GoiuMiTo…` with
   `allowOwnerOffCurve = true`. Do NOT pass the ATA itself.)

## Phase 2 — Handover to the multisig

8. **config.authority** (two-step), for earn AND staking:
   - deployer: `propose_authority_transfer(ApDQBVjwy…)`
   - multisig: `accept_authority_transfer` via the Squads CLI
     (`tools/multisig`: `msig propose earn-authority-accept` / `staking-authority-accept` → 2 approvals → execute).
9. **upgrade authority**, for earn AND staking:
   `solana program set-upgrade-authority <program> --new-upgrade-authority ApDQBVjwy… --skip-new-upgrade-authority-signer-check --keypair <deployer> --url mainnet-beta`

## Phase 3 — Verify

- earn config (357 bytes): `authority == ApDQBVjwy…`, `total_invested_capital == 25000000000`, `basket_vault == Ew8GFA29…`, `schema_version == 1`.
- staking config (363 bytes): `authority == ApDQBVjwy…`.
- earn-RWT supply == 25000000000 → NAV $1; genesis recipient holds 25,000 RWT.
- `solana program show` earn + staking: `Authority == ApDQBVjwy…` (upgrade authority).
- Deployer is now authority/upgrade-authority of nothing.

## Notes

- No external audit (accepted, no budget). Cheap risk mitigations recommended before scaling TVL: deposit cap (fits the schema_version+reserve), timelocked upgrade authority, phased launch, bug bounty.
- Pause: deliberately none (NAV is counter-based; staking has a 21-day cooldown).
- Trust shifts accepted: external mutable `basket_vault` (authority can redirect future deposits), `seed_genesis` mints against off-chain RWA (bounded to one-time genesis at NAV $1).
- After bootstrap the deployer is inert, but keep its key (rent recovery / edge cases).
