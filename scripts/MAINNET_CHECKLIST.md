# Areal earn + staking — Pre-Mainnet Checklist

Status legend: ☐ open · ◐ in progress · ☑ done

## A. Hard blockers (mechanical — code can't deploy without these)

- ☐ **A1** Mainnet program IDs (earn + staking) — vanity grind. *(needs: user provides, or generate)*
- ☑ **A2** Mainnet deployer = `CyFCB88B3kMiPJSFLSXqP1u12dULeBaPh9qqjqquA1Np` (`keys/mainnet/deployer.json`, gitignored, 600). = BOOTSTRAP_AUTHORITY. dao_fee ATA = `68AHfVCW4CJGCKxfUdLgj3WKe8qF8eSztmEd7VnPFYkg`. **MUST back up the keypair file (not in git).**
- ☐ **A3** Pin batch (non-devnet branches): `declare_id!` → real IDs; `USDC_MINT` → mainnet `EPjFWdd5…` (refactor to feature-gated devnet/mainnet); `EARN_RWT_MINT` (staking) → mint from bootstrap (chicken-egg); `BOOTSTRAP_AUTHORITY` → deployer. *(blocked by A1, A2)*
- ☑ **A4** `basket_vault` = `Ew8GFA29…` (multisig USDC ATA, = invested capital). `dao_fee_destination` = the DEPLOYER's USDC ATA (created at bootstrap), TEMPORARY — collects fees until the multisig redirects it via `update_config` post-launch. Contract-compliant (≠ basket_vault, USDC, non-zero). OP-NOTE: keep the deployer key until dao_fee is redirected + accumulated fees swept (deployer owns that account).
- ☐ **A5** Genesis recipient = treasury earn-RWT ATA. *(derived at bootstrap)*

## B. Verification & audit (my work)

- ☑ **B1** FINAL composite audit of the frozen version — DONE. earn RELEASE-READY (0 crit/high/med), staking RELEASE-READY-WITH-NOTES (0 crit/high/med). Interaction analysis clean; assert_account_size full coverage; earn-RWT burn-path confirmed absent (genesis guard airtight). Only LOW/INFO accepted notes.
- ◐ **B2** Build + tests green on the FROZEN (unpinned) version: earn 34, staking 19/20. Re-run after mainnet pins applied (A3).

## C. Launch dependencies (outside the contracts, but launch-blocking)

- ☐ **C1** Mainnet Meteora earn-RWT/USDC pool — earn has NO on-chain redeem; exit = DEX. Mint doesn't exist until bootstrap → pool is created + seeded AFTER the RWT mint. Must be in the launch sequence (create mint → seed pool → enable minting via update_config).
- ☐ **C2** Verify multisig `ApDQBVjwy47EAffSehF8k18orUbJaLSURVEdx95bV8oA` — threshold + members (2-of-N), genuinely a Squads multisig, not a single key. *(security rests entirely on this)*
- ☐ **C3** Backend + frontend repointed to mainnet program IDs + mainnet basket_vault/config (currently devnet `HGh7`).

## D. Risk mitigations (no external audit — recommended substitutes)

- ✗ **D1** Deposit cap — DECLINED by user (accepted risk: no code-level blast-radius bound; early-phase exposure = full TVL). Compensate operationally via D3 (phased launch).
- ☐ **D2** Timelock on upgrade authority (or staged) — lets users exit a malicious upgrade.
- ☐ **D3** Phased launch (start small / team funds as majority early TVL).
- ☐ **D4** Public bug bounty (Immunefi) — crowdsourced review.

## E. Execution

- ☐ **E1** Final devnet rehearsal of the EXACT frozen mainnet build (re-run the v4 flow on the pinned final version).
- ☐ **E2** Mainnet deploy per `scripts/MAINNET_RUNBOOK.md`, with one pre-flight config confirmation before irreversible steps.

---
### Order
B1/C1/C2 can start now (no pending inputs). A1/A2/A4 need user values. A3/B2/E1 follow the pins. E2 last.
