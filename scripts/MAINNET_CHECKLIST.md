# Areal earn + staking — Pre-Mainnet Checklist

Status legend: ☐ open · ◐ in progress · ☑ done

## A. Hard blockers (mechanical — code can't deploy without these)

- ☑ **A1** Mainnet program IDs — earn `GTASb5UcQEkcRWuMwfoNABBBNJitdxWByobMLZZ2UCw8`, staking `9tEKvDwkqkveBvmQfEzgPKWSNCDTGSSqYz4ZE6pP5DGY` (`keys/mainnet/{earn,staking}-program.json`, random). RWT mint `RWTeFt9…` + stRWT `sRWTy1…` (vanity, provided).
- ☑ **A2** Mainnet deployer = `CyFCB88B3kMiPJSFLSXqP1u12dULeBaPh9qqjqquA1Np` (`keys/mainnet/deployer.json`, gitignored, 600). = BOOTSTRAP_AUTHORITY. dao_fee ATA = `68AHfVCW4CJGCKxfUdLgj3WKe8qF8eSztmEd7VnPFYkg`. **MUST back up the keypair file (not in git).**
- ☑ **A3** Pin batch DONE + committed (contracts `1861487`). declare_id, USDC feature-gated (devnet/mainnet), EARN_RWT_MINT, BOOTSTRAP_AUTHORITY all pinned in non-devnet; devnet branches intact. Security: every byte independently verified, RELEASE-READY. Bootstrap made vanity-mint-configurable.
- ☑ **A4** `basket_vault` = `Ew8GFA29…` (multisig USDC ATA, = invested capital). `dao_fee_destination` = the DEPLOYER's USDC ATA (created at bootstrap), TEMPORARY — collects fees until the multisig redirects it via `update_config` post-launch. Contract-compliant (≠ basket_vault, USDC, non-zero). OP-NOTE: keep the deployer key until dao_fee is redirected + accumulated fees swept (deployer owns that account).
- ☑ **A5** Genesis recipient = `GoiuMiTocoY5M3NuRrcJDJ25AjruPieRZitvnEkCFtR9` (multisig vault RWT ATA; created at bootstrap). 25k RWT → treasury, NAV $1.

## B. Verification & audit (my work)

- ☑ **B1** FINAL composite audit of the frozen version — DONE. earn RELEASE-READY (0 crit/high/med), staking RELEASE-READY-WITH-NOTES (0 crit/high/med). Interaction analysis clean; assert_account_size full coverage; earn-RWT burn-path confirmed absent (genesis guard airtight). Only LOW/INFO accepted notes.
- ◐ **B2** Build + tests green on the FROZEN (unpinned) version: earn 34, staking 19/20. Re-run after mainnet pins applied (A3).

## C. Launch dependencies (outside the contracts, but launch-blocking)

- ☐ **C1** Mainnet Meteora earn-RWT/USDC pool — earn has NO on-chain redeem; exit = DEX. Mint doesn't exist until bootstrap → pool is created + seeded AFTER the RWT mint. Must be in the launch sequence (create mint → seed pool → enable minting via update_config).
- ☑ **C2** VERIFIED on-chain. Squads multisig account `C3mC9bMpSnu3eKqX7MBB1GcxNVgTvbDSZG7iQc91sW2B` = **2-of-3**, all 3 members full perms, timeLock=0. vault[0] derives to `ApDQBVjwy…` = our authority/treasury (MATCH). NOT a single key. (Multisig acct = CLI/settings only; vault = assets/authority, per Squads.) timeLock=0 → relevant to D2.
- ☑ **C3** DONE. Backend cluster-aware (SOLANA_CLUSTER=mainnet + program-id env; gate accepts mainnet IDs; keeper never signs off devnet). app-earn network-driven (VITE_NETWORK=mainnet). Meteora pool env-driven placeholder (set at C1). Committed: backend `8b41875`, app-earn `bbb8257`.

## D. Risk mitigations (no external audit — recommended substitutes)

- ✗ **D1** Deposit cap — DECLINED by user (accepted risk: no code-level blast-radius bound; early-phase exposure = full TVL). Compensate operationally via D3 (phased launch).
- ☐ **D2** Timelock on upgrade authority (or staged) — lets users exit a malicious upgrade.
- ☐ **D3** Phased launch (start small / team funds as majority early TVL).
- ☐ **D4** Public bug bounty (Immunefi) — crowdsourced review.

## E. Execution

- ☑ **E1** DONE. v5 proved the flow + vanity-mint-from-file, found the off-curve-genesis bug (fixed, meta `9035977`). **v6 CLEAN re-run of the EXACT committed code PASSED end-to-end** — genesis 25k minted to the OFF-CURVE vault ATA (owner=GkDVox, no error), vanity mint at exact addr, authority+upgrade→vault, NAV $1. No workarounds, no open blockers. Final gate cleared.
- ☐ **E2** Mainnet deploy per `scripts/MAINNET_RUNBOOK.md`, with one pre-flight config confirmation before irreversible steps.

---
### Order
B1/C1/C2 can start now (no pending inputs). A1/A2/A4 need user values. A3/B2/E1 follow the pins. E2 last.
