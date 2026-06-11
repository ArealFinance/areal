#!/usr/bin/env tsx
/*
 * setup-dryrun-squads.ts — Stage 2 of the DEVNET multisig dry-run.
 *
 * Creates a Squads v4 2-of-3 multisig on DEVNET for the earn+staking dry-run:
 *   - 3 members (keys/devnet/dryrun/member-{1,2,3}.json), each Permissions.all()
 *     (Proposer + Voter + Executor).
 *   - threshold = 2, no time lock.
 *   - createKey = a fresh random keypair (kept ephemeral; printed for the record).
 *   - configAuthority = null (controlled multisig governs itself).
 *   - fee payer + creator = the deployer (keys/devnet/deployer.json).
 *
 * Derives + prints: multisig PDA, default vault PDA (vaultIndex 0), createKey
 * pubkey, and the creation tx signature. Idempotent: if the multisig PDA already
 * exists it skips creation and just re-derives/prints the addresses (but the
 * createKey is random per-run, so a re-run after a successful create needs the
 * createKey passed back via CREATE_KEY_B64 to land on the same multisig PDA).
 *
 * DEVNET ONLY. Hardcoded to api.devnet.solana.com; refuses any other endpoint.
 *
 * Usage (from tools/multisig/):
 *   npx tsx scripts/setup-dryrun-squads.ts
 *   CREATE_KEY_B64=<base64 secret> npx tsx scripts/setup-dryrun-squads.ts  # reuse createKey
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';

const RPC_URL = 'https://api.devnet.solana.com';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

function loadKeypair(relPath: string): Keypair {
  const raw = JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main(): Promise<void> {
  const conn = new Connection(RPC_URL, 'confirmed');

  // Hard cluster guard: the genesis hash is the chain's cryptographic identity.
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    throw new Error(`refusing to run: genesis ${genesis} is not devnet (${DEVNET_GENESIS})`);
  }

  const deployer = loadKeypair('keys/devnet/deployer.json');
  const members = [
    loadKeypair('keys/devnet/dryrun/member-1.json'),
    loadKeypair('keys/devnet/dryrun/member-2.json'),
    loadKeypair('keys/devnet/dryrun/member-3.json'),
  ];

  // createKey: fresh random per run, unless reused via CREATE_KEY_B64.
  const reuse = process.env.CREATE_KEY_B64?.trim();
  const createKey = reuse
    ? Keypair.fromSecretKey(Buffer.from(reuse, 'base64'))
    : Keypair.generate();

  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

  // Squads program config: source the treasury (creation-fee recipient).
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(
    conn,
    programConfigPda,
  );
  const treasury = programConfig.treasury;

  console.log('================ setup-dryrun-squads PLAN ================');
  console.log(`rpc:              ${RPC_URL}`);
  console.log(`genesis:          ${genesis} (devnet OK)`);
  console.log(`creator/feePayer: ${deployer.publicKey.toBase58()}`);
  console.log(`createKey:        ${createKey.publicKey.toBase58()}`);
  console.log(`createKey b64:    ${Buffer.from(createKey.secretKey).toString('base64')}`);
  console.log(`multisig PDA:     ${multisigPda.toBase58()}`);
  console.log(`vault PDA (idx0): ${vaultPda.toBase58()}`);
  console.log(`programConfigPda: ${programConfigPda.toBase58()}`);
  console.log(`treasury:         ${treasury.toBase58()}`);
  console.log(`creationFee:      ${programConfig.multisigCreationFee.toString()}`);
  console.log('members (threshold 2 of 3, Permissions.all):');
  for (const m of members) console.log(`  - ${m.publicKey.toBase58()}`);
  console.log('=========================================================');

  // Idempotency: if the multisig PDA already exists, skip creation.
  const existing = await conn.getAccountInfo(multisigPda, 'confirmed');
  if (existing) {
    console.log(`\nmultisig ${multisigPda.toBase58()} already exists — skipping create.`);
    console.log(JSON.stringify({
      multisigPda: multisigPda.toBase58(),
      vaultPda: vaultPda.toBase58(),
      createKey: createKey.publicKey.toBase58(),
      createKeyB64: Buffer.from(createKey.secretKey).toString('base64'),
      signature: null,
      alreadyExisted: true,
    }, null, 2));
    return;
  }

  const signature = await multisig.rpc.multisigCreateV2({
    connection: conn,
    treasury,
    createKey,
    creator: deployer,
    multisigPda,
    configAuthority: null, // controlled multisig — governs itself
    threshold: 2,
    members: members.map((m) => ({
      key: m.publicKey,
      permissions: multisig.types.Permissions.all(),
    })),
    timeLock: 0,
    rentCollector: null,
    memo: 'areal earn+staking dry-run 2-of-3',
    sendOptions: { skipPreflight: false, preflightCommitment: 'confirmed' },
  });

  // Confirm.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

  console.log(`\nmultisig created. sig: ${signature}`);
  console.log(`explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  console.log(JSON.stringify({
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    createKey: createKey.publicKey.toBase58(),
    createKeyB64: Buffer.from(createKey.secretKey).toString('base64'),
    signature,
    alreadyExisted: false,
  }, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  process.exit(1);
});
