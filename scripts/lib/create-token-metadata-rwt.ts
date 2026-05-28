#!/usr/bin/env tsx
/*
 * create-token-metadata-rwt.ts — One-off devnet op.
 *
 * Calls rwt-engine::create_rwt_metadata (devnet-only ix) to attach Metaplex
 * Token Metadata to the RWT mint. The vault PDA signs the Metaplex CPI as
 * mint_authority; we sign as the configured RwtVault.authority.
 *
 * Usage:
 *   NODE_PATH=bots/node_modules bots/node_modules/.bin/tsx \
 *     scripts/lib/create-token-metadata-rwt.ts
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
} from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const ADDR_PATH = join(REPO_ROOT, 'data', 'devnet-addresses.json');

const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

const NAME = 'Areal RWT (Devnet)';
const SYMBOL = 'RWT';
const URI = 'https://areal.finance/tokens/rwt.json';

function anchorDiscriminator(name: string): Buffer {
  const h = createHash('sha256');
  h.update(`global:${name}`);
  return h.digest().subarray(0, 8);
}

function padBytes(s: string, n: number): { buf: Buffer; len: number } {
  const utf8 = Buffer.from(s, 'utf8');
  if (utf8.length > n) {
    throw new Error(`"${s}" exceeds ${n} bytes (${utf8.length})`);
  }
  const buf = Buffer.alloc(n);
  utf8.copy(buf);
  return { buf, len: utf8.length };
}

function deriveMetadataPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID,
  );
}

function deriveRwtVault(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('rwt_vault')],
    programId,
  );
}

async function main(): Promise<void> {
  const addresses = JSON.parse(readFileSync(ADDR_PATH, 'utf8'));

  const rpcUrl: string = addresses.rpc.http;
  const deployerKeyPath = resolve(REPO_ROOT, addresses.deployer.keypair_path);
  const deployerSecret = JSON.parse(readFileSync(deployerKeyPath, 'utf8'));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  const rwtEngineProgram = new PublicKey(addresses.programs.rwt_engine.pubkey);
  const rwtMint = new PublicKey(addresses.mints.rwt);

  const [rwtVault] = deriveRwtVault(rwtEngineProgram);
  const [metadataPda, metadataBump] = deriveMetadataPda(rwtMint);

  console.log(`[rwt-metadata] cluster=devnet`);
  console.log(`[rwt-metadata] rwt_engine_program=${rwtEngineProgram.toBase58()}`);
  console.log(`[rwt-metadata] rwt_vault=${rwtVault.toBase58()}`);
  console.log(`[rwt-metadata] rwt_mint=${rwtMint.toBase58()}`);
  console.log(`[rwt-metadata] metadata_pda=${metadataPda.toBase58()} bump=${metadataBump}`);
  console.log(`[rwt-metadata] authority/payer=${deployer.publicKey.toBase58()}`);

  const conn = new Connection(rpcUrl, 'confirmed');

  // Idempotency: skip if metadata already exists
  const existing = await conn.getAccountInfo(metadataPda);
  if (existing) {
    console.log(`[rwt-metadata] metadata account already exists, skipping. size=${existing.data.length}`);
    if (!addresses.metadata) addresses.metadata = {};
    addresses.metadata.rwt_metadata_pda = metadataPda.toBase58();
    writeFileSync(ADDR_PATH, JSON.stringify(addresses, null, 2) + '\n', 'utf8');
    return;
  }

  // --- Build instruction data ---
  const disc = anchorDiscriminator('create_rwt_metadata');
  const { buf: nameBuf, len: nameLen } = padBytes(NAME, 32);
  const { buf: symbolBuf, len: symbolLen } = padBytes(SYMBOL, 10);
  const { buf: uriBuf, len: uriLen } = padBytes(URI, 200);

  const data = Buffer.concat([
    disc,                         // 8
    nameBuf,                      // 32
    Buffer.from([nameLen]),       // 1
    symbolBuf,                    // 10
    Buffer.from([symbolLen]),     // 1
    uriBuf,                       // 200
    Buffer.from([uriLen]),        // 1
  ]);
  console.log(`[rwt-metadata] ix_data_len=${data.length} disc=${disc.toString('hex')}`);
  console.log(`[rwt-metadata] name_len=${nameLen} symbol_len=${symbolLen} uri_len=${uriLen}`);

  // --- Build accounts in declared struct order ---
  // CreateRwtMetadata:
  //   0. authority (signer)
  //   1. rwt_vault (PDA, seeds=[b"rwt_vault"])
  //   2. rwt_mint
  //   3. metadata_account (mut)
  //   4. payer (mut, signer)
  //   5. mpl_token_metadata_program
  //   6. system_program
  //   7. rent
  const keys = [
    { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
    { pubkey: rwtVault, isSigner: false, isWritable: false },
    { pubkey: rwtMint, isSigner: false, isWritable: false },
    { pubkey: metadataPda, isSigner: false, isWritable: true },
    { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
    { pubkey: TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId: rwtEngineProgram,
    keys,
    data,
  });

  // CU bump (CPI to Metaplex is heavy)
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const tx = new Transaction().add(cuIx, ix);
  tx.feePayer = deployer.publicKey;
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(deployer);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  console.log(`[rwt-metadata] tx=${sig}`);
  const conf = await conn.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) {
    throw new Error(`tx err: ${JSON.stringify(conf.value.err)}`);
  }
  console.log(`[rwt-metadata] confirmed`);

  const after = await conn.getAccountInfo(metadataPda);
  if (!after) throw new Error('metadata account not created');
  console.log(`[rwt-metadata] account_size=${after.data.length} owner=${after.owner.toBase58()}`);

  if (!addresses.metadata) addresses.metadata = {};
  addresses.metadata.rwt_metadata_pda = metadataPda.toBase58();
  writeFileSync(ADDR_PATH, JSON.stringify(addresses, null, 2) + '\n', 'utf8');
  console.log(`[rwt-metadata] updated ${ADDR_PATH}`);
}

main().catch((e) => {
  console.error('[rwt-metadata] FAILED:', e?.message || e);
  if (e?.logs) console.error('logs:', e.logs);
  process.exit(1);
});
