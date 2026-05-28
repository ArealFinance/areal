#!/usr/bin/env tsx
/*
 * create-token-metadata-sprk.ts — One-off devnet op.
 *
 * Calls ownership-token::create_ot_metadata (devnet-only ix) to attach
 * Metaplex Token Metadata to the SPRK OT mint. The OtConfig PDA signs
 * the Metaplex CPI as mint_authority; we sign as the OtGovernance.authority.
 *
 * Usage:
 *   NODE_PATH=bots/node_modules bots/node_modules/.bin/tsx \
 *     scripts/lib/create-token-metadata-sprk.ts
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

const NAME = 'Areal Sparkles OT (Devnet)';
const SYMBOL = 'SPRK';
const URI = 'https://areal.finance/tokens/sprk.json';

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

function deriveOtPda(seed: string, mint: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed), mint.toBuffer()],
    programId,
  );
}

async function main(): Promise<void> {
  const addresses = JSON.parse(readFileSync(ADDR_PATH, 'utf8'));

  const rpcUrl: string = addresses.rpc.http;
  const deployerKeyPath = resolve(REPO_ROOT, addresses.deployer.keypair_path);
  const deployerSecret = JSON.parse(readFileSync(deployerKeyPath, 'utf8'));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  const otProgram = new PublicKey(addresses.programs.ownership_token.pubkey);
  const sprkMint = new PublicKey(addresses.mints.sprk_ot);

  const [otGovernance] = deriveOtPda('ot_governance', sprkMint, otProgram);
  const [otConfig] = deriveOtPda('ot_config', sprkMint, otProgram);
  const [metadataPda, metadataBump] = deriveMetadataPda(sprkMint);

  console.log(`[sprk-metadata] cluster=devnet`);
  console.log(`[sprk-metadata] ot_program=${otProgram.toBase58()}`);
  console.log(`[sprk-metadata] sprk_mint=${sprkMint.toBase58()}`);
  console.log(`[sprk-metadata] ot_governance=${otGovernance.toBase58()}`);
  console.log(`[sprk-metadata] ot_config=${otConfig.toBase58()}`);
  console.log(`[sprk-metadata] metadata_pda=${metadataPda.toBase58()} bump=${metadataBump}`);
  console.log(`[sprk-metadata] authority/payer=${deployer.publicKey.toBase58()}`);

  const conn = new Connection(rpcUrl, 'confirmed');

  // Idempotency
  const existing = await conn.getAccountInfo(metadataPda);
  if (existing) {
    console.log(`[sprk-metadata] metadata account already exists, skipping. size=${existing.data.length}`);
    if (!addresses.metadata) addresses.metadata = {};
    addresses.metadata.sprk_ot_metadata_pda = metadataPda.toBase58();
    writeFileSync(ADDR_PATH, JSON.stringify(addresses, null, 2) + '\n', 'utf8');
    return;
  }

  // Verify OtGovernance.authority matches deployer (early failure clarity)
  const govAcct = await conn.getAccountInfo(otGovernance);
  if (!govAcct) {
    throw new Error(`OtGovernance account not found at ${otGovernance.toBase58()}`);
  }
  // OtGovernance layout: 8 disc + 32 ot_mint + 32 authority + ...
  const govAuthority = new PublicKey(govAcct.data.subarray(40, 72));
  console.log(`[sprk-metadata] on-chain ot_governance.authority=${govAuthority.toBase58()}`);
  if (!govAuthority.equals(deployer.publicKey)) {
    throw new Error(`deployer ${deployer.publicKey.toBase58()} is not OtGovernance authority (${govAuthority.toBase58()})`);
  }

  // --- Build instruction data ---
  const disc = anchorDiscriminator('create_ot_metadata');
  const { buf: nameBuf, len: nameLen } = padBytes(NAME, 32);
  const { buf: symbolBuf, len: symbolLen } = padBytes(SYMBOL, 10);
  const { buf: uriBuf, len: uriLen } = padBytes(URI, 200);

  const data = Buffer.concat([
    disc,
    nameBuf,
    Buffer.from([nameLen]),
    symbolBuf,
    Buffer.from([symbolLen]),
    uriBuf,
    Buffer.from([uriLen]),
  ]);
  console.log(`[sprk-metadata] ix_data_len=${data.length} disc=${disc.toString('hex')}`);
  console.log(`[sprk-metadata] name_len=${nameLen} symbol_len=${symbolLen} uri_len=${uriLen}`);

  // CreateOtMetadata accounts:
  //   0. authority (signer)
  //   1. ot_governance (has_one validates authority)
  //   2. ot_config
  //   3. ot_mint
  //   4. metadata_account (mut)
  //   5. payer (mut, signer)
  //   6. mpl_token_metadata_program
  //   7. system_program
  //   8. rent
  const keys = [
    { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
    { pubkey: otGovernance, isSigner: false, isWritable: false },
    { pubkey: otConfig, isSigner: false, isWritable: false },
    { pubkey: sprkMint, isSigner: false, isWritable: false },
    { pubkey: metadataPda, isSigner: false, isWritable: true },
    { pubkey: deployer.publicKey, isSigner: true, isWritable: true },
    { pubkey: TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    programId: otProgram,
    keys,
    data,
  });

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
  console.log(`[sprk-metadata] tx=${sig}`);
  const conf = await conn.confirmTransaction(sig, 'confirmed');
  if (conf.value.err) {
    throw new Error(`tx err: ${JSON.stringify(conf.value.err)}`);
  }
  console.log(`[sprk-metadata] confirmed`);

  const after = await conn.getAccountInfo(metadataPda);
  if (!after) throw new Error('metadata account not created');
  console.log(`[sprk-metadata] account_size=${after.data.length} owner=${after.owner.toBase58()}`);

  if (!addresses.metadata) addresses.metadata = {};
  addresses.metadata.sprk_ot_metadata_pda = metadataPda.toBase58();
  writeFileSync(ADDR_PATH, JSON.stringify(addresses, null, 2) + '\n', 'utf8');
  console.log(`[sprk-metadata] updated ${ADDR_PATH}`);
}

main().catch((e) => {
  console.error('[sprk-metadata] FAILED:', e?.message || e);
  if (e?.logs) console.error('logs:', e.logs);
  process.exit(1);
});
