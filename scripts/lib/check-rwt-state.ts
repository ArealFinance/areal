#!/usr/bin/env tsx
/*
 * check-rwt-state.ts — Read-only devnet state probe for RWT faucet pre/post checks.
 *
 * Reads (no transactions):
 *   - RwtVault state (total_invested_capital, total_rwt_supply, nav, mint_paused,
 *     areal_fee_destination)
 *   - RWT mint supply + authority
 *   - USDC test mint supply + authority
 *   - Deployer USDC + RWT balances
 *   - Capital accumulator USDC balance
 *   - Areal fee USDC ATA balance
 *   - NAV invariant: capital / supply ≈ nav_book_value
 *
 * Usage: NODE_PATH=bots/node_modules bots/node_modules/.bin/tsx scripts/lib/check-rwt-state.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey } from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const ARTIFACT_PATH = join(REPO_ROOT, 'data', 'e2e-bootstrap.devnet.json');

const TOKEN_PROG = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROG = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROG.toBuffer(), mint.toBuffer()],
    ATA_PROG,
  )[0];
}

async function readU64(c: Connection, ata: PublicKey, offset = 64): Promise<bigint> {
  const i = await c.getAccountInfo(ata, 'confirmed');
  if (!i || i.data.length < offset + 8) return 0n;
  return i.data.readBigUInt64LE(offset);
}

function readU128LE(buf: Buffer, off: number): bigint {
  let lo = 0n;
  for (let i = 7; i >= 0; i--) lo = (lo << 8n) | BigInt(buf[off + i]!);
  let hi = 0n;
  for (let i = 7; i >= 0; i--) hi = (hi << 8n) | BigInt(buf[off + 8 + i]!);
  return (hi << 64n) | lo;
}

async function main() {
  const art = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as any;
  const RPC = art.rpc_url;
  const VAULT = new PublicKey(art.pdas.rwt_vault);
  const RWT_MINT = new PublicKey(art.mints.rwt_mint);
  const USDC_MINT = new PublicKey(art.mints.usdc_test_mint);
  const DEPLOYER = new PublicKey(art.deployer_pubkey);
  const CAPITAL = new PublicKey(art.pdas.rwt_capital_accumulator_ata);
  const FEE_USDC = new PublicKey(art.pdas.areal_fee_ata);

  const c = new Connection(RPC, 'confirmed');

  // RwtVault layout (8-byte discriminator + 259 bytes data):
  //   off 8:   total_invested_capital u128
  //   off 24:  total_rwt_supply u64
  //   off 32:  nav_book_value u64
  //   off 40:  capital_accumulator_ata [32]
  //   off 72:  rwt_mint [32]
  //   off 104: authority [32]
  //   off 136: pending_authority [32]
  //   off 168: has_pending bool
  //   off 169: manager [32]
  //   off 201: pause_authority [32]
  //   off 233: mint_paused bool
  //   off 234: areal_fee_destination [32]
  //   off 266: bump u8
  const vinfo = await c.getAccountInfo(VAULT);
  if (!vinfo) throw new Error('vault not found');
  const d = vinfo.data;
  const totalCapital = readU128LE(d, 8);
  const totalSupply = d.readBigUInt64LE(24);
  const nav = d.readBigUInt64LE(32);
  const capitalAtaFromVault = new PublicKey(d.subarray(40, 72));
  const rwtMintFromVault = new PublicKey(d.subarray(72, 104));
  const mintPaused = d[233] !== 0;
  const arealFeeDest = new PublicKey(d.subarray(234, 266));

  console.log('=== RWT Vault state ===');
  console.log(`  total_invested_capital: ${totalCapital} (USDC raw, 6 dec)`);
  console.log(`  total_rwt_supply:       ${totalSupply}`);
  console.log(`  nav_book_value:         ${nav}`);
  console.log(`  mint_paused:            ${mintPaused}`);
  console.log(`  rwt_mint:               ${rwtMintFromVault.toBase58()}`);
  console.log(`  capital_accumulator:    ${capitalAtaFromVault.toBase58()}`);
  console.log(`  areal_fee_destination:  ${arealFeeDest.toBase58()}`);

  // NAV invariant: capital / supply ≈ nav (scaled by NAV_SCALE = 1_000_000)
  if (totalSupply > 0n) {
    const navCalc = (totalCapital * 1_000_000n) / BigInt(totalSupply);
    console.log(`  NAV invariant check:    capital*1e6/supply = ${navCalc} (book = ${nav}, diff = ${navCalc - BigInt(nav)})`);
  }

  // RWT mint
  const rwtMintInfo = await c.getAccountInfo(RWT_MINT);
  if (!rwtMintInfo) throw new Error('rwt mint not found');
  const rwtAuthTag = rwtMintInfo.data.readUInt32LE(0);
  const rwtAuth = new PublicKey(rwtMintInfo.data.subarray(4, 36));
  const rwtMintSupply = rwtMintInfo.data.readBigUInt64LE(36);
  console.log(`\n=== RWT mint (${RWT_MINT.toBase58()}) ===`);
  console.log(`  supply:         ${rwtMintSupply}`);
  console.log(`  mint_authority: ${rwtAuthTag === 1 ? rwtAuth.toBase58() : 'NONE'}`);

  // USDC test mint
  const usdcInfo = await c.getAccountInfo(USDC_MINT);
  if (!usdcInfo) throw new Error('usdc mint not found');
  const usdcAuthTag = usdcInfo.data.readUInt32LE(0);
  const usdcAuth = new PublicKey(usdcInfo.data.subarray(4, 36));
  const usdcSupply = usdcInfo.data.readBigUInt64LE(36);
  console.log(`\n=== USDC test mint (${USDC_MINT.toBase58()}) ===`);
  console.log(`  supply:         ${usdcSupply}`);
  console.log(`  mint_authority: ${usdcAuthTag === 1 ? usdcAuth.toBase58() : 'NONE'}`);
  console.log(`  deployer match: ${usdcAuthTag === 1 && usdcAuth.equals(DEPLOYER)}`);

  // ATAs
  const deployerUsdcAta = findAta(DEPLOYER, USDC_MINT);
  const deployerRwtAta = findAta(DEPLOYER, RWT_MINT);
  const deployerUsdc = await readU64(c, deployerUsdcAta);
  const deployerRwt = await readU64(c, deployerRwtAta);
  const capitalUsdc = await readU64(c, CAPITAL);
  const feeUsdc = await readU64(c, FEE_USDC);
  const sol = await c.getBalance(DEPLOYER, 'confirmed');

  console.log(`\n=== Balances ===`);
  console.log(`  deployer USDC ATA (${deployerUsdcAta.toBase58()}): ${deployerUsdc}`);
  console.log(`  deployer RWT ATA  (${deployerRwtAta.toBase58()}): ${deployerRwt}`);
  console.log(`  capital_accumulator USDC: ${capitalUsdc}`);
  console.log(`  areal_fee_destination USDC ATA: ${feeUsdc}`);
  console.log(`  deployer SOL: ${sol / 1e9}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  process.exit(1);
});
