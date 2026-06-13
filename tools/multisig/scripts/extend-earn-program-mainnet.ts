/**
 * MAINNET: extend the earn programData account via the PERMISSIONLESS
 * `ExtendProgram` (UpgradeableLoaderInstruction variant 6).
 *
 * Why not `solana program extend`? On Agave 3.x the CLI builds the *checked*
 * variant and refuses unless the signer == upgrade authority. Our upgrade
 * authority is the multisig vault, so the deployer cannot use the CLI. The
 * unchecked `ExtendProgram` (variant 6) is permissionless by design — anyone
 * may pay to grow an upgradeable program — so the deployer can fund it directly,
 * no multisig round-trip.
 *
 * Account order (bpf_loader_upgradeable::extend_program with payer):
 *   0. programData            writable
 *   1. program                writable
 *   2. system program         readonly
 *   3. payer                  signer, writable
 * Data (bincode enum): u32 LE variant(6) | u32 LE additional_bytes
 *
 * SAFETY: simulates by default. Set SEND=1 to broadcast.
 * Env: RPC (mainnet), DEPLOYER_PATH, optional ADD_BYTES (default 16384).
 */
import { readFileSync as rf } from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const RPC = process.env.RPC!;
const DEPLOYER_PATH = process.env.DEPLOYER_PATH!;
const SEND = process.env.SEND === '1';
const ADD_BYTES = Number(process.env.ADD_BYTES ?? '16384');

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
// Default to earn; override via env PROGRAM_ID / PROGRAMDATA for staking etc.
const PROGRAM = new PublicKey(process.env.PROGRAM_ID ?? 'GTASb5UcQEkcRWuMwfoNABBBNJitdxWByobMLZZ2UCw8');
const PROGRAMDATA = new PublicKey(process.env.PROGRAMDATA ?? 'HpEC19mXQN3aSRxL4rU7ubUwCcKYyQsQEgjoFwk4Nn7G');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rf(path, 'utf8')) as number[]));
}

function buildData(additionalBytes: number): Buffer {
  const d = Buffer.alloc(8);
  d.writeUInt32LE(6, 0); // ExtendProgram variant
  d.writeUInt32LE(additionalBytes, 4);
  return d;
}

async function main() {
  if (!RPC || !RPC.includes('mainnet')) throw new Error('RPC must be a mainnet URL');
  if (!DEPLOYER_PATH) throw new Error('DEPLOYER_PATH is required');
  if (!Number.isInteger(ADD_BYTES) || ADD_BYTES <= 0) throw new Error('ADD_BYTES must be a positive integer');

  const conn = new Connection(RPC, 'confirmed');
  const deployer = loadKeypair(DEPLOYER_PATH);

  console.log('=== earn ExtendProgram (MAINNET, permissionless) ===');
  console.log('payer (deployer):', deployer.publicKey.toBase58());
  console.log('program:         ', PROGRAM.toBase58());
  console.log('programData:     ', PROGRAMDATA.toBase58());
  console.log('additional bytes:', ADD_BYTES);

  // Derive + sanity-check the canonical programData PDA.
  const [derivedPda] = PublicKey.findProgramAddressSync([PROGRAM.toBytes()], LOADER);
  if (!derivedPda.equals(PROGRAMDATA)) {
    throw new Error(`programData mismatch: derived ${derivedPda.toBase58()} != ${PROGRAMDATA.toBase58()}`);
  }

  const before = await conn.getAccountInfo(PROGRAMDATA, 'confirmed');
  if (!before) throw new Error('programData account not found');
  console.log('current programData account size:', before.data.length, 'bytes');

  const ix = new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: PROGRAMDATA, isSigner: false, isWritable: true },
      { pubkey: PROGRAM, isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
    ],
    data: buildData(ADD_BYTES),
  });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: deployer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([deployer]);

  const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' });
  console.log('\n--- simulation ---');
  console.log('err:', JSON.stringify(sim.value.err));
  for (const l of sim.value.logs ?? []) console.log(' ', l);
  if (sim.value.err) throw new Error('simulation failed — not sending (fall back to multisig ExtendProgramChecked)');

  if (!SEND) {
    console.log('\nSimulation OK. Re-run with SEND=1 to broadcast.');
    return;
  }

  const sig = await conn.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  const after = await conn.getAccountInfo(PROGRAMDATA, 'confirmed');
  console.log('\n✅ extended. signature:', sig);
  console.log('new programData account size:', after?.data.length, 'bytes');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
