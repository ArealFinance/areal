# `msig` — Areal Finance Squads v4 multisig CLI

A self-contained TypeScript CLI for creating, reviewing, approving and executing
**Areal Finance protocol operations** (earn / staking authority actions, program
upgrades) through a **Squads v4 multisig**.

The Squads web UI is inconvenient for *creating* transactions. This tool lets a
local "proposer" key (a Squads member with **Initiate-only** permission) build
fully-formed proposals programmatically. Members then approve them either with
this CLI (file keypair) or the Squads web app — they are the same on-chain
proposals, so the two are fully interoperable. Anyone can execute once the
threshold is met.

It is **self-contained**: its own `package.json` / `tsconfig.json` / lockfile,
no dependency on the repo's `sdk/`. Protocol instructions are encoded directly
(Borsh, fixed layouts) from the Rust source ground truth.

---

## Why this exists / threat model

The team's on-chain roles (earn authority, staking authority, program upgrade
authority) are held by a Squads v4 **vault PDA**. To change anything you must go
through a multisig proposal. This CLI:

- builds the **exact** protocol instruction with the **vault PDA mapped as the
  `authority` signer** (the vault signs via CPI when the proposal executes);
- **decodes** any pending proposal into human-readable form so reviewers see
  precisely what they are signing;
- **verifies account identities**: every labeled account (the vault authority,
  the earn/staking config PDAs) is checked against the configured pubkey. A
  proposal that decodes as a known instruction but targets a *look-alike*
  account is flagged `DOES NOT MATCH CONFIGURED …` and treated like an unknown
  instruction for confirmation purposes;
- **resolves upgrade targets**: a BPF-loader `Upgrade` proposal has its
  `program` account resolved by name (earn / staking / ⚠ unknown), its
  `programData` verified against the derived PDA, and always carries an explicit
  caution that the **buffer bytecode is unverifiable on-chain** — every upgrade
  forces the index-echo confirmation regardless of cluster;
- **refuses** to present an undecodable instruction as safe — it prints a loud
  `UNKNOWN INSTRUCTION` warning, the raw hex, and the program id, and forces an
  extra confirmation step. Proposals that use **Address Lookup Tables** (e.g.
  created in the Squads web app) are likewise treated as UNKNOWN, since this CLI
  does not resolve the looked-up accounts offline.

### Security model (hard rules)

1. **Secret keys come only from keypair JSON files** passed by `--keypair <path>`.
   Never from CLI args, env vars, or the config file. Secret bytes are never
   printed or logged — only the derived public key is ever shown.
2. **`approve` renders the full decoded proposal first**, then requires explicit
   interactive confirmation before signing. The confirmation escalates to an
   **index-echo** step (you must type the proposal index to proceed) whenever
   any inner instruction is undecodable, **decoded-but-unverified** (an account
   identity mismatch, a programData mismatch, an Address-Lookup-Table proposal,
   or *any* program upgrade), OR the cluster is mainnet. `execute` applies the
   same index-echo friction on mainnet or for any unknown/unverified proposal.
3. **Every pubkey input is validated** as base58. Before `propose` / `approve` /
   `reject` / `execute`, the tool verifies the multisig account exists and the
   provided keypair is a member with the required permission.
4. **The cluster is printed prominently** in every command. **Mainnet is shown
   in red + bold** so it can never be missed. On every networked command the
   tool also cross-checks the configured cluster label against the RPC's
   **genesis hash** and aborts on a contradiction (e.g. a "devnet"-labeled
   config pointing at mainnet).
5. **Keypair files are permission-checked**: loading a group/world-accessible
   keypair prints a `chmod 600` warning (advisory, non-blocking).
6. **No telemetry. No network calls except the configured RPC.**

---

## Setup

```bash
cd tools/multisig
npm install          # (pnpm also works inside this dir)
```

Run via `tsx` (no build step needed):

```bash
npx tsx src/index.ts <command> ...
# or, after `npm run build`:
node dist/index.js <command> ...
```

Requirements: Node 20+.

### Creating the Squads multisig (one time, web app)

Create the multisig in the Squads v4 web app (https://app.squads.so):

- **Members**: add each signer's wallet. Give the local automation key
  **Initiate only** (it can create proposals but cannot vote or execute) — this
  is the "proposer" key this CLI uses for `propose`. Give the human signers
  **Vote** (and optionally **Execute**).
- **Threshold**: set the approval threshold (e.g. 2-of-3).
- **Vault**: note the **vault index** (usually `0`). The vault PDA at that index
  is the address you transfer the earn/staking authority and program upgrade
  authority to.

Then transfer the protocol authorities to the vault PDA (two-step authority
transfer on earn/staking; `set-upgrade-authority` for the programs). The
`earn-authority-accept` / `staking-authority-accept` proposals here perform the
on-chain **accept** half, signed by the vault.

---

## Configuration

`msig init` writes `msig.config.json` (public data only — never secrets):

```bash
npx tsx src/index.ts init        # interactive prompts
# or fully flagged (non-interactive, CI-safe):
npx tsx src/index.ts init \
  --cluster devnet \
  --rpc https://devnet.helius-rpc.com/?api-key=... \
  --multisig <MULTISIG_ADDRESS> \
  --earn HGh7TcuqUbTRrFTYBUtsTctAEEmsANWnDxeWcbgqMg8b \
  --staking CmKXHk3u6pDUC6Q11Le6gmhCgENQSFvduisXb7guUGoL \
  --earn-config H4DBeFKwZsVrhMmMFG7HSMEQckeCYdewuri28kQ3wT4p \
  --staking-config BWb75dNXbJbteLsmKy58sfHj8nYVa6CqaDzJrWo1mP1R \
  --earn-rwt-mint 8hJPUC4UNsiyBh5cosTA8RqY9TbBSmnxqkBb2sHJ5qzM \
  --earn-programdata <EARN_PROGRAMDATA> \
  --staking-programdata <STAKING_PROGRAMDATA>
```

Resulting file:

```json
{
  "cluster": "devnet",
  "rpcUrl": "https://...",
  "multisig": "<MULTISIG_ADDRESS>",
  "vaultIndex": 0,
  "programs": { "earn": "...", "staking": "..." },
  "configPdas": { "earnConfig": "...", "stakingConfig": "..." },
  "programData": { "earn": "...", "staking": "..." },
  "earnRwtMint": "..."
}
```

- `earnRwtMint` is **required for `earn-writedown`** (the instruction reads the
  mint supply for the NAV snapshot).
- `programData` is optional for `upgrade` — if omitted, the canonical
  programData PDA is derived from the program id under the BPF loader.
- The cluster label is cross-checked against the RPC url in two directions: a
  `mainnet-beta` label on an obviously-devnet RPC, **and** a non-mainnet label on
  a mainnet RPC, are both rejected as ambiguous targets.
- On every networked command the label is additionally verified against the
  RPC's **genesis hash** (the cryptographic chain identity), which a relabeled
  RPC cannot spoof. A proven contradiction aborts the command; an unreachable
  RPC is non-fatal (the label is trusted, with a warning).

> **Residual risk (offline commands).** `init` and any purely-offline parsing
> trust the `cluster` label as written — only commands that open an RPC
> connection (`propose`, `list`, `show`, `approve`, `reject`, `execute`) perform
> the genesis-hash check. Always run a networked command (e.g. `list`) after
> editing the config to confirm the resolved cluster identity printed in the
> banner before you sign anything.

Use `--config <path>` on any command to point at a non-default config file.

---

## Command reference

```
msig init [flags]                                  write msig.config.json

msig propose earn-update-config   --keypair <p> --fee-bps <n> --min-mint <n> --fee-destination <pk>
msig propose staking-update-config --keypair <p> --reward-depositor <pk> --min-stake <n> --cooldown <secs>
msig propose earn-unpause         --keypair <p>
msig propose staking-unpause      --keypair <p>
msig propose earn-writedown       --keypair <p> --amount <n> --reason <code>
msig propose earn-authority-accept    --keypair <p>
msig propose staking-authority-accept --keypair <p>
msig propose upgrade  --keypair <p> --program <earn|staking|pubkey> --buffer <pk> [--programdata <pk>] [--spill <pk>]

msig list  [--limit <n>]                           pending proposals: status + vote counts
msig show  <index>                                 decode: program, instruction, args, accounts (roles)
msig approve <index> --keypair <p> [--yes]         show, confirm, then approve
msig reject  <index> --keypair <p>                 show, confirm, then reject
msig execute <index> --keypair <p>                 execute an approved proposal
```

Notes:

- `--keypair <path>` is always a **Solana CLI keypair JSON file** (64-byte array).
- `--yes` on `approve` skips the prompt **only** for a fully-decoded,
  non-mainnet proposal. It is ignored when any inner instruction is unknown or
  when the cluster is mainnet (the index-echo step still applies).
- All `propose` commands map the protocol `authority` signer to the **vault PDA**
  at the configured `vaultIndex`.

### Supported protocol instructions (ground truth: `contracts/` HEAD)

| Command | On-chain instruction | Args | Accounts (vault = `authority`) |
|---|---|---|---|
| `earn-update-config` | `earn.update_config` | `mint_fee_bps:u16, min_mint_amount:u64, dao_fee_destination:[u8;32]` | `authority(signer)`, `earn_config(w)` |
| `earn-unpause` | `earn.unpause` | — | `authority(signer)`, `earn_config(w)` |
| `earn-writedown` | `earn.writedown_capital` | `amount:u64, reason_code:u8` | `authority(signer)`, `earn_config(w)`, `rwt_mint(r)` |
| `earn-authority-accept` | `earn.accept_authority_transfer` | — | `new_authority(signer)`, `earn_config(w)` |
| `staking-update-config` | `staking.update_config` | `reward_depositor:[u8;32], min_stake_amount:u64, cooldown_seconds:i64` | `authority(signer)`, `staking_config(w)` |
| `staking-unpause` | `staking.unpause` | — | `authority(signer)`, `staking_config(w)` |
| `staking-authority-accept` | `staking.accept_authority_transfer` | — | `new_authority(signer)`, `staking_config(w)` |
| `upgrade` | BPF Upgradeable Loader `Upgrade` | — (u32 `3`) | `programdata(w)`, `program(w)`, `buffer(w)`, `spill(w)`, `rent`, `clock`, `authority(signer)` |

---

## The approve flow (why it is safe)

```
$ msig approve 7 --keypair ~/keys/signer.json
  CLUSTER: DEVNET ...
PROPOSAL #7
  [0] earn :: update_config
      program:  HGh7Tcuq...
      args:
        mint_fee_bps = 100 (1.00%)
        min_mint_amount = 1000000
        dao_fee_destination = DYw8jCTf...
      accounts:
        authority (vault)   <vaultPDA>   [signer,readonly]
        earn_config         H4DBeFKw...   [writable]

Sign this proposal? [y/N]:
```

The decoded view is rendered **before** any signing. If instruction `[0]` were
undecodable you would instead see:

```
  [0] ⚠  UNKNOWN INSTRUCTION — DO NOT APPROVE BLINDLY  ⚠
      program:  <programId>
      raw data: <hex>
...
Extra confirmation required (undecodable/unknown content).
Type the proposal index (7) to confirm signing, anything else to abort:
```

This makes it structurally impossible to approve an unknown payload with a
reflexive `y`.

---

## Devnet walkthrough

```bash
# 0. Configure (devnet program ids from data/devnet-addresses.json)
npx tsx src/index.ts init --cluster devnet --rpc <DEVNET_RPC> \
  --multisig <YOUR_MULTISIG> \
  --earn HGh7TcuqUbTRrFTYBUtsTctAEEmsANWnDxeWcbgqMg8b \
  --staking CmKXHk3u6pDUC6Q11Le6gmhCgENQSFvduisXb7guUGoL \
  --earn-config H4DBeFKwZsVrhMmMFG7HSMEQckeCYdewuri28kQ3wT4p \
  --staking-config BWb75dNXbJbteLsmKy58sfHj8nYVa6CqaDzJrWo1mP1R \
  --earn-rwt-mint 8hJPUC4UNsiyBh5cosTA8RqY9TbBSmnxqkBb2sHJ5qzM

# 1. Proposer (Initiate-only key) creates a proposal
npx tsx src/index.ts propose earn-update-config \
  --keypair ./keys/proposer.json \
  --fee-bps 100 --min-mint 1000000 \
  --fee-destination <USDC_FEE_DEST>
#   -> Proposal created. index: 1

# 2. Anyone reviews it
npx tsx src/index.ts show 1
npx tsx src/index.ts list

# 3. Members approve (CLI or Squads web app — same proposal)
npx tsx src/index.ts approve 1 --keypair ./keys/signer-a.json
npx tsx src/index.ts approve 1 --keypair ./keys/signer-b.json

# 4. Execute once threshold is met
npx tsx src/index.ts execute 1 --keypair ./keys/signer-a.json
```

---

## How discriminators are derived

Arlex (the Pinocchio framework the contracts use) is **Anchor-compatible**:

```
instruction discriminator = sha256("global:<snake_case_ix_name>")[0..8]
```

This is confirmed in `arlex-framework/client/src/discriminator.ts` and matches
the `initialize` value already baked into `scripts/lib/bootstrap-earn.ts`
(`af af 6d 1f 0d 98 9b ed`). Derived values used here:

| instruction | discriminator (hex) |
|---|---|
| `update_config` | `1d 9e fc bf 0a 53 db 63` |
| `unpause` | `a9 90 04 26 0a 8d bc ff` |
| `writedown_capital` | `de 0b bd 7c a7 46 4e 8f` |
| `accept_authority_transfer` | `ef f8 b1 02 ce 61 2e ff` |
| (`initialize`, baseline) | `af af 6d 1f 0d 98 9b ed` |

The discriminators are computed at runtime (`instructionDiscriminator()`); the
table above is asserted byte-for-byte in `test/protocol.test.ts`.

The BPF Upgradeable Loader `Upgrade` instruction is **not** Anchor-style — it is
a bincode enum where `Upgrade` is variant index `3`, encoded as a bare
little-endian `u32` with no payload.

---

## Testing

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest run
```

Tests cover: encoder byte-layouts (against discriminators + Borsh arg layouts
derived from the Rust source), the decoder used by `show` (encode → decode
round-trips + UNKNOWN handling), the v0-message account-role reconstruction,
pubkey/config validation, and the file-only keypair loader. **No test touches a
live RPC.**

---

## v1 limitations / deviations

- **Hardware wallets (Ledger) are deferred.** This CLI signs with file keypairs
  only. Members who want to sign with a Ledger can approve the **same on-chain
  proposal** in the Squads web app with their Ledger — the proposals are fully
  interoperable.
- **`list`** scans transaction indices from the multisig's top index downward
  (bounded by `--limit`). For very large histories, raise `--limit` or query a
  specific index with `show`.
- **`upgrade`** assumes the standard BPF Upgradeable Loader. The buffer account
  must already be written and its buffer authority set to the vault PDA (do that
  with the Solana CLI before proposing).
- The supported instruction set is the v1 scope (config/pause/writedown/
  authority-accept/upgrade). Mint/stake/unstake/deposit-rewards flows are
  intentionally out of scope for a multisig governance tool.
