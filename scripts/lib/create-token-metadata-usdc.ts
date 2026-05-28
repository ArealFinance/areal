#!/usr/bin/env tsx
/*
 * create-token-metadata-usdc.ts — One-off devnet op.
 *
 * Creates a Metaplex Token Metadata account for the devnet USDC test mint
 * (E4HJu85ZmTrfBuy9kXQpehYnJdaHKY9oaEZNRCZcW35a) so that Phantom and other
 * wallets display "Areal Test USDC" instead of "Unknown Token".
 *
 * USDC test mint's mint_authority == deployer, so we sign with the deployer
 * keypair directly — no contract change required.
 *
 * Metaplex CreateMetadataAccountV3 instruction layout:
 *   tag (u8) = 33
 *   data: DataV2
 *     name: String          (u32 LE length + UTF-8 bytes)
 *     symbol: String
 *     uri: String
 *     seller_fee_basis_points: u16
 *     creators: Option<Vec<Creator>>   (we pass None = 0)
 *     collection: Option<Collection>   (None = 0)
 *     uses: Option<Uses>               (None = 0)
 *   is_mutable: bool
 *   collection_details: Option<CollectionDetails>   (None = 0)
 *
 * Usage:
 *   NODE_PATH=bots/node_modules bots/node_modules/.bin/tsx \
 *     scripts/lib/create-token-metadata-usdc.ts
 */

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
} from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const ADDR_PATH = join(REPO_ROOT, 'data', 'devnet-addresses.json');

const TOKEN_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

const NAME = 'Areal Test USDC';
const SYMBOL = 'USDC';
const URI = 'https://areal.finance/tokens/usdc.json';

function encodeString(s: string): Buffer {
  const utf8 = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(utf8.length, 0);
  return Buffer.concat([len, utf8]);
}

function buildCreateMetadataAccountV3Data(
  name: string,
  symbol: string,
  uri: string,
  sellerFeeBasisPoints: number,
  isMutable: boolean,
): Buffer {
  // Tag for CreateMetadataAccountV3 = 33
  const tag = Buffer.from([33]);

  // DataV2
  const nameBuf = encodeString(name);
  const symbolBuf = encodeString(symbol);
  const uriBuf = encodeString(uri);
  const sellerFee = Buffer.alloc(2);
  sellerFee.writeUInt16LE(sellerFeeBasisPoints, 0);
  const creators = Buffer.from([0]); // Option<Vec<Creator>> = None
  const collection = Buffer.from([0]); // Option<Collection> = None
  const uses = Buffer.from([0]); // Option<Uses> = None

  // is_mutable, collection_details (None)
  const isMutableBuf = Buffer.from([isMutable ? 1 : 0]);
  const collectionDetails = Buffer.from([0]); // Option<CollectionDetails> = None

  return Buffer.concat([
    tag,
    nameBuf,
    symbolBuf,
    uriBuf,
    sellerFee,
    creators,
    collection,
    uses,
    isMutableBuf,
    collectionDetails,
  ]);
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

async function main(): Promise<void> {
  const addressesRaw = readFileSync(ADDR_PATH, 'utf8');
  const addresses = JSON.parse(addressesRaw);

  const rpcUrl: string = addresses.rpc.http;
  const deployerKeyPath = resolve(REPO_ROOT, addresses.deployer.keypair_path);
  const deployerSecret = JSON.parse(readFileSync(deployerKeyPath, 'utf8'));
  const deployer = Keypair.fromSecretKey(Uint8Array.from(deployerSecret));

  const usdcMint = new PublicKey(addresses.mints.usdc);

  console.log(`[usdc-metadata] cluster=devnet`);
  console.log(`[usdc-metadata] deployer=${deployer.publicKey.toBase58()}`);
  console.log(`[usdc-metadata] mint=${usdcMint.toBase58()}`);
  console.log(`[usdc-metadata] name="${NAME}" symbol="${SYMBOL}" uri="${URI}"`);

  const [metadataPda, metadataBump] = deriveMetadataPda(usdcMint);
  console.log(`[usdc-metadata] metadata_pda=${metadataPda.toBase58()} bump=${metadataBump}`);

  const conn = new Connection(rpcUrl, 'confirmed');

  // Idempotency: if metadata already exists, skip
  const existing = await conn.getAccountInfo(metadataPda);
  if (existing) {
    console.log(`[usdc-metadata] metadata account already exists, skipping. size=${existing.data.length}`);
    return;
  }

  const data = buildCreateMetadataAccountV3Data(NAME, SYMBOL, URI, 0, true);

  const ix = new TransactionInstruction({
    programId: TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadataPda, isSigner: false, isWritable: true },
      { pubkey: usdcMint, isSigner: false, isWritable: false },
      { pubkey: deployer.publicKey, isSigner: true, isWritable: false }, // mint authority
      { pubkey: deployer.publicKey, isSigner: true, isWritable: true },  // payer
      { pubkey: deployer.publicKey, isSigner: false, isWritable: false }, // update authority
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = deployer.publicKey;
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.sign(deployer);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  console.log(`[usdc-metadata] tx=${sig}`);
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`[usdc-metadata] confirmed`);

  // Verify
  const after = await conn.getAccountInfo(metadataPda);
  if (!after) {
    throw new Error('metadata account not created');
  }
  console.log(`[usdc-metadata] account_size=${after.data.length} owner=${after.owner.toBase58()}`);

  // Persist to addresses file
  if (!addresses.metadata) addresses.metadata = {};
  addresses.metadata.usdc_metadata_pda = metadataPda.toBase58();
  writeFileSync(ADDR_PATH, JSON.stringify(addresses, null, 2) + '\n', 'utf8');
  console.log(`[usdc-metadata] updated ${ADDR_PATH}`);
}

main().catch((e) => {
  console.error('[usdc-metadata] FAILED:', e?.message || e);
  if (e?.logs) console.error('logs:', e.logs);
  process.exit(1);
});
