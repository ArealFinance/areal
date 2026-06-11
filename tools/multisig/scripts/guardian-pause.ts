/**
 * DEVNET Stage 3c helper: raw earn pause / unpause instructions for the guardian
 * + negative-path checks. The multisig CLI deliberately has no guardian-pause or
 * guardian-unpause path (pause is a guardian emergency brake, unpause is
 * authority-only), so these are built raw here.
 *
 * Ground truth: contracts/earn/src/instructions/pause.rs
 *   PauseEarn   accounts: 0 pause_authority signer, 1 earn_config mut
 *   UnpauseEarn accounts: 0 authority       signer, 1 earn_config mut
 *   discriminators: sha256("global:pause")[0..8], sha256("global:unpause")[0..8]
 *
 * Usage: npx tsx scripts/guardian-pause.ts <pause|unpause> <signer-keypair-path>
 *
 * DEVNET ONLY. Prints tx sig on success, or the decoded custom error on revert.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const RPC = 'https://api.devnet.solana.com';
const EARN_PROGRAM = new PublicKey('EXW5JYFX32Xzd2QByvVxDxa9nRGNHbrhccboNqNHhwtm');
const EARN_CONFIG = new PublicKey('719YWEeDNWMFbfpY5fkoFMZKQcbyKqf1TGNG1JvWCXGy');

function disc(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}
function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

async function main() {
  const action = process.argv[2];
  const keypairPath = process.argv[3];
  if (action !== 'pause' && action !== 'unpause') {
    throw new Error('usage: guardian-pause.ts <pause|unpause> <signer-keypair-path>');
  }
  if (!keypairPath) throw new Error('signer keypair path required');

  const conn = new Connection(RPC, 'confirmed');
  const signer = loadKeypair(keypairPath);
  console.log(`action: ${action}`);
  console.log(`signer: ${signer.publicKey.toBase58()}`);
  console.log(`discriminator: ${disc(action).toString('hex')}`);

  const ix = new TransactionInstruction({
    programId: EARN_PROGRAM,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      { pubkey: EARN_CONFIG, isSigner: false, isWritable: true },
    ],
    data: disc(action),
  });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([signer]);

  try {
    const sig = await conn.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    console.log(`RESULT: SUCCESS  sig=${sig}`);
  } catch (e: any) {
    console.log('RESULT: REVERTED (expected for negative checks)');
    const logs = e?.logs ?? e?.transactionLogs;
    if (logs) {
      console.log('--- program logs ---');
      for (const l of logs) console.log(l);
    }
    const m = String(e?.message ?? e);
    console.log('error message:', m);
    // Extract custom error code if present (0x.... hex).
    const hex = m.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (hex) {
      const code = parseInt(hex[1], 16);
      console.log(`custom error code: ${hex[1]} (${code} dec, Anchor code ${code})`);
    }
    process.exitCode = 0; // expected for negative checks; don't fail the run
  }
}

main().catch((e) => {
  console.error('UNEXPECTED:', e);
  process.exit(1);
});
