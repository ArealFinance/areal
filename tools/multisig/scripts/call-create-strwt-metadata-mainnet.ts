/**
 * MAINNET: call staking.create_strwt_metadata — attach Metaplex Token Metadata
 * to the stRWT (Staked RWT) share mint. Signed DIRECTLY by the deployer
 * (= BOOTSTRAP_AUTHORITY); bootstrap-gated, NOT a multisig operation.
 *
 * Ground truth: contracts/staking/src/instructions/create_strwt_metadata.rs
 *   #[program] fn create_strwt_metadata(ctx, name[32], name_len, symbol[10],
 *                                       symbol_len, uri[200], uri_len)
 *   discriminator = sha256("global:create_strwt_metadata")[0..8] = d169ef80cbce17ec
 *
 *   Client account order (struct CreateStrwtMetadata):
 *     0 bootstrap_authority  signer, mut   (= deployer CyFCB88B…, pays rent)
 *     1 staking_config                     (PDA EwXST2yo…, read-only)
 *     2 strwt_mint            mut          (sRWTy1bk…, == config.strwt_mint)
 *     3 metadata_account      mut          (Metaplex PDA, created by the CPI)
 *     4 update_authority                   (= config.authority = multisig vault)
 *     5 mpl_token_metadata_program         (metaqbxx…)
 *     6 system_program                     (11111…)
 *     7 rent sysvar                        (SysvarRent111…)
 *
 *   Instruction data (253 bytes):
 *     disc(8) | name[32] | name_len(1) | symbol[10] | symbol_len(1) | uri[200] | uri_len(1)
 *
 * SAFETY: simulates by default. Set SEND=1 to broadcast.
 * Env: RPC (mainnet), DEPLOYER_PATH, optional NAME / SYMBOL / URI overrides.
 */
import { readFileSync as rf } from 'node:fs';
import { createHash as sha } from 'node:crypto';
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

const NAME = process.env.NAME ?? 'Staked RWT';
const SYMBOL = process.env.SYMBOL ?? 'STRWT';
const URI = process.env.URI ?? 'https://meta.areal.finance/strwt.json';

// Mainnet pins (ground truth: msig.config.mainnet.json + staking constants).
const STAKING_PROGRAM = new PublicKey('9tEKvDwkqkveBvmQfEzgPKWSNCDTGSSqYz4ZE6pP5DGY');
const STAKING_CONFIG = new PublicKey('EwXST2yoQRBf3FEYe6fyoseatHaVypYck3ZQ5bEGzEUe');
const STRWT_MINT = new PublicKey('sRWTy1bkqvRegb31RETanhbAtJ7eXN6XsTvaqBRh6kA');
const VAULT = new PublicKey('ApDQBVjwy47EAffSehF8k18orUbJaLSURVEdx95bV8oA'); // = config.authority
const BOOTSTRAP_AUTHORITY = new PublicKey('CyFCB88B3kMiPJSFLSXqP1u12dULeBaPh9qqjqquA1Np');
const MPL = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
const RENT_SYSVAR = new PublicKey('SysvarRent111111111111111111111111111111111');

function disc(name: string): Buffer {
  return sha('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rf(path, 'utf8')) as number[]));
}

function fixedArg(s: string, cap: number): { buf: Buffer; len: number } {
  const bytes = Buffer.from(s, 'utf8');
  if (bytes.length > cap) throw new Error(`"${s}" is ${bytes.length} bytes, exceeds cap ${cap}`);
  const buf = Buffer.alloc(cap);
  bytes.copy(buf);
  return { buf, len: bytes.length };
}

function buildData(): Buffer {
  const name = fixedArg(NAME, 32);
  const symbol = fixedArg(SYMBOL, 10);
  const uri = fixedArg(URI, 200);
  const data = Buffer.concat([
    disc('create_strwt_metadata'),
    name.buf,
    Buffer.from([name.len]),
    symbol.buf,
    Buffer.from([symbol.len]),
    uri.buf,
    Buffer.from([uri.len]),
  ]);
  if (data.length !== 253) throw new Error(`unexpected data length ${data.length}, want 253`);
  return data;
}

async function main() {
  if (!RPC || !RPC.includes('mainnet')) throw new Error('RPC must be a mainnet URL');
  if (!DEPLOYER_PATH) throw new Error('DEPLOYER_PATH is required');

  const conn = new Connection(RPC, 'confirmed');
  const deployer = loadKeypair(DEPLOYER_PATH);
  if (!deployer.publicKey.equals(BOOTSTRAP_AUTHORITY)) {
    throw new Error(`deployer ${deployer.publicKey.toBase58()} != BOOTSTRAP_AUTHORITY ${BOOTSTRAP_AUTHORITY.toBase58()}`);
  }

  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), MPL.toBytes(), STRWT_MINT.toBytes()],
    MPL,
  );

  console.log('=== staking.create_strwt_metadata (MAINNET) ===');
  console.log('deployer / bootstrap:', deployer.publicKey.toBase58());
  console.log('staking program:     ', STAKING_PROGRAM.toBase58());
  console.log('strwt mint:          ', STRWT_MINT.toBase58());
  console.log('metadata PDA:        ', metadataPda.toBase58());
  console.log('update_authority:    ', VAULT.toBase58(), '(= config.authority / vault)');
  console.log('name / symbol / uri: ', JSON.stringify(NAME), JSON.stringify(SYMBOL), JSON.stringify(URI));
  console.log('disc:                ', disc('create_strwt_metadata').toString('hex'));

  const existing = await conn.getAccountInfo(metadataPda, 'confirmed');
  if (existing) {
    console.log('\nMetadata account already exists — nothing to do. Verify on Solscan.');
    return;
  }

  const ix = new TransactionInstruction({
    programId: STAKING_PROGRAM,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true }, // 0 bootstrap_authority
      { pubkey: STAKING_CONFIG, isSigner: false, isWritable: false }, //    1 staking_config
      { pubkey: STRWT_MINT, isSigner: false, isWritable: true }, //         2 strwt_mint
      { pubkey: metadataPda, isSigner: false, isWritable: true }, //        3 metadata_account
      { pubkey: VAULT, isSigner: false, isWritable: false }, //             4 update_authority
      { pubkey: MPL, isSigner: false, isWritable: false }, //               5 mpl program
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false }, //    6 system program
      { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false }, //       7 rent sysvar
    ],
    data: buildData(),
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
  if (sim.value.err) throw new Error('simulation failed — not sending');

  if (!SEND) {
    console.log('\nSimulation OK. Re-run with SEND=1 to broadcast.');
    return;
  }

  const sig = await conn.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  console.log('\n✅ sent:', sig);
  console.log('Solscan:', `https://solscan.io/tx/${sig}`);
  console.log('Token:  ', `https://solscan.io/token/${STRWT_MINT.toBase58()}`);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
