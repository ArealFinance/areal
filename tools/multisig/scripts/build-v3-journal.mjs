#!/usr/bin/env node
/*
 * build-v3-journal.mjs — Stage 2 isolated journal transform.
 *
 * Reads the canonical data/devnet-addresses.json (the user's v2 journal — already
 * backed up) and produces a v3 variant that:
 *   - repoints programs.earn    -> earn-v3 (EXW5...) + keys/devnet/earn-v3.json
 *   - repoints programs.staking -> staking-v3 (7QzD...) + keys/devnet/staking-v3.json
 *   - CLEARS the `earn` section so bootstrap-earn re-bootstraps fresh under the
 *     new config PDAs (deletes the section entirely; bootstrap treats a missing
 *     `art.earn` as `{}` and generates fresh earn-RWT/stRWT mints).
 *   - sets rpc.http to api.devnet.solana.com (Stage 2 mandated RPC).
 *   - keeps deployer, mints (USDC), bootstrap, bots, metadata etc. intact.
 *
 * Writes the v3 journal to a destination path given as argv[2].
 * Does NOT overwrite the canonical journal itself — caller decides where to put it.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = 'data/devnet-addresses.json';
const dst = process.argv[2];
if (!dst) {
  console.error('usage: build-v3-journal.mjs <dest-path>');
  process.exit(1);
}

const EARN_V3 = 'EXW5JYFX32Xzd2QByvVxDxa9nRGNHbrhccboNqNHhwtm';
const STAKING_V3 = '7QzDVFQcMs4N1sa3fdyuTNHS6Ej9warYnEQwuztq9ub';

const j = JSON.parse(readFileSync(SRC, 'utf8'));

// Preserve the prior v2 program records as `previous_v2` for traceability,
// mirroring how the journal already nests `previous_v1`.
const prevEarn = { ...j.programs.earn };
const prevStaking = { ...j.programs.staking };

j.programs.earn = {
  keypair_path: 'keys/devnet/earn-v3.json',
  pubkey: EARN_V3,
  note: 'earn-v3 (3-guardian pause build) — Stage 2 dry-run repoint',
  previous_v2: prevEarn,
};
j.programs.staking = {
  keypair_path: 'keys/devnet/staking-v3.json',
  pubkey: STAKING_V3,
  note: 'staking-v3 (3-guardian pause build) — Stage 2 dry-run repoint',
  previous_v2: prevStaking,
};

// Clear the earn section for a clean re-bootstrap. Keep the old v2 record nested
// for reference, but remove every top-level field bootstrap-earn keys off of
// (mint keypairs, config PDAs, basket/pool vaults) so it regenerates fresh.
const prevEarnSection = j.earn ? { ...j.earn } : undefined;
delete j.earn;
if (prevEarnSection) {
  j.earn_previous_v2 = prevEarnSection;
}

// Stage 2 mandated RPC — keep ws/airdrop consistent.
j.rpc = {
  http: 'https://api.devnet.solana.com',
  ws: 'wss://api.devnet.solana.com/',
  airdrop_http: 'https://api.devnet.solana.com',
};

j.v3_dryrun_note =
  'Stage 2 DEVNET multisig dry-run: earn/staking repointed to v3 program IDs, ' +
  'earn section cleared for clean re-bootstrap. Canonical journal restored to v2 ' +
  'after the run; this v3 record lives in data/devnet-addresses.v3-dryrun.json.';

writeFileSync(dst, JSON.stringify(j, null, 2) + '\n', 'utf8');
console.log(`wrote v3 journal -> ${dst}`);
console.log(`programs.earn.pubkey    = ${j.programs.earn.pubkey}`);
console.log(`programs.staking.pubkey = ${j.programs.staking.pubkey}`);
console.log(`earn section present    = ${j.earn !== undefined}`);
console.log(`rpc.http                = ${j.rpc.http}`);
