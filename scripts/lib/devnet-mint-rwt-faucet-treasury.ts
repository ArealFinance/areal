#!/usr/bin/env tsx
/*
 * devnet-mint-rwt-faucet-treasury.ts — One-off devnet op.
 *
 * Pre-mints ~50,000 USDC + calls rwt-engine::mint_rwt to convert it into
 * ~49,500 RWT (1% mint fee per MINT_FEE_BPS) for the deployer faucet
 * treasury. The deployer's RWT ATA is the source for test-user faucet
 * top-ups and for downstream e2e flows (fund_distributor, etc.).
 *
 * NAV/fee math (mirrors contracts/rwt-engine/src/instructions/mint_rwt.rs):
 *   fee_total  = amount * MINT_FEE_BPS / BPS_DENOMINATOR  (1% of deposit)
 *   dao_fee    = fee_total / 2                            (0.5% to areal_fee_destination)
 *   vault_fee  = fee_total - dao_fee                      (0.5% retained as capital)
 *   net_deposit = amount - fee_total                       (98.99% counted as net principal)
 *   rwt_out    = net_deposit * NAV_SCALE / nav             (RWT received)
 *
 * Notes for devnet:
 *   - deployer is the USDC mint authority and also the areal_fee_destination
 *     owner (USDC fee ATA == deployer USDC ATA on devnet), so the 0.5% DAO
 *     fee stays in deployer's USDC ATA.
 *   - There is NO on-chain RWT max-supply cap (no MAX_RWT_SUPPLY constant
 *     in contracts/rwt-engine/src/constants.rs nor max_supply_lamports in
 *     RwtDistributionConfig).
 *   - At NAV != 1.0 exactly the RWT received will be slightly less than
 *     amount (in USDC units). Slippage min_rwt_out is hardened to
 *     97% × amount (post-fee + small NAV drift cushion).
 *
 * Usage (from repo root):
 *   NODE_PATH=bots/node_modules bots/node_modules/.bin/tsx \
 *     scripts/lib/devnet-mint-rwt-faucet-treasury.ts \
 *     [--amount 50_000_000_000]            # USDC raw (6 dec), default 50_000 USDC
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  createMintToInstruction,
} from '@solana/spl-token';
import { ArlexClient } from '@arlex/client';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const ARTIFACT_PATH = join(REPO_ROOT, 'data', 'e2e-bootstrap.devnet.json');

const DEFAULT_AMOUNT = 50_000_000_000n; // 50,000 USDC (6 decimals)
// On-chain constants (mirror contracts/rwt-engine/src/constants.rs)
const MINT_FEE_BPS = 100n;
const BPS_DENOMINATOR = 10_000n;
const NAV_SCALE = 1_000_000n;

interface Artifact {
  rpc_url: string;
  deployer_keypair_path: string;
  deployer_pubkey: string;
  programs: { rwt_engine: string };
  mints: { rwt_mint: string; usdc_test_mint: string };
  pdas: {
    rwt_vault: string;
    rwt_capital_accumulator_ata: string;
    areal_fee_ata: string;
  };
}

function parseArgs(argv: string[]): { amount: bigint } {
  let amount = DEFAULT_AMOUNT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--amount' && i + 1 < argv.length) {
      amount = BigInt(argv[++i]!.replace(/_/g, ''));
    }
  }
  return { amount };
}

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(readFileSync(p, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  )[0];
}

async function getTokenBalance(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata, 'confirmed');
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

async function getMintSupply(conn: Connection, mint: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(mint, 'confirmed');
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  return info.data.readBigUInt64LE(36);
}

function readU128LE(buf: Buffer, off: number): bigint {
  let lo = 0n;
  for (let i = 7; i >= 0; i--) lo = (lo << 8n) | BigInt(buf[off + i]!);
  let hi = 0n;
  for (let i = 7; i >= 0; i--) hi = (hi << 8n) | BigInt(buf[off + 8 + i]!);
  return (hi << 64n) | lo;
}

async function readVault(conn: Connection, vault: PublicKey) {
  const info = await conn.getAccountInfo(vault, 'confirmed');
  if (!info) throw new Error('vault not found');
  const d = info.data;
  return {
    totalInvestedCapital: readU128LE(d, 8),
    totalRwtSupply: d.readBigUInt64LE(24),
    navBookValue: d.readBigUInt64LE(32),
    mintPaused: d[233] !== 0,
  };
}

async function sendAndConfirm(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const s = value?.[0];
    if (s?.err) throw new Error(`tx failed: ${JSON.stringify(s.err)} (sig=${sig})`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
      return sig;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`confirmation timeout: sig=${sig} lvb=${lastValidBlockHeight}`);
}

function loadIdl(name: string): unknown {
  const path = join(REPO_ROOT, 'sdk', 'idl', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// mint_rwt IDL already has correct writable/signer flags for every account.
// No INIT_WRITABLE overrides needed.
function normalizeIdl(idl: any): unknown {
  const out = JSON.parse(JSON.stringify(idl));
  for (const ix of out.instructions ?? []) {
    for (const acc of ix.accounts ?? []) {
      acc.isMut = acc.writable ?? acc.isMut ?? false;
      acc.isSigner = acc.signer ?? acc.isSigner ?? false;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const amount = args.amount;

  const art = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as Artifact;
  const rpcUrl = art.rpc_url;
  if (!rpcUrl.includes('devnet')) {
    throw new Error(`refusing to run on non-devnet RPC: ${rpcUrl}`);
  }

  const deployer = loadKeypair(join(REPO_ROOT, art.deployer_keypair_path));
  if (deployer.publicKey.toBase58() !== art.deployer_pubkey) {
    throw new Error(
      `keypair pubkey ${deployer.publicKey.toBase58()} mismatches artifact ${art.deployer_pubkey}`,
    );
  }

  const conn = new Connection(rpcUrl, 'confirmed');

  const rwtProgramId = new PublicKey(art.programs.rwt_engine);
  const rwtVault = new PublicKey(art.pdas.rwt_vault);
  const rwtMint = new PublicKey(art.mints.rwt_mint);
  const usdcMint = new PublicKey(art.mints.usdc_test_mint);
  const capitalAcc = new PublicKey(art.pdas.rwt_capital_accumulator_ata);
  const daoFeeAccount = new PublicKey(art.pdas.areal_fee_ata);
  const deployerUsdcAta = findAta(deployer.publicKey, usdcMint);
  const deployerRwtAta = findAta(deployer.publicKey, rwtMint);

  console.log('=== devnet-mint-rwt-faucet-treasury ===');
  console.log(`RPC:          ${rpcUrl}`);
  console.log(`Deployer:     ${deployer.publicKey.toBase58()}`);
  console.log(`Amount USDC:  ${amount} raw (${Number(amount) / 1e6} USDC)`);
  console.log(`RWT mint:     ${rwtMint.toBase58()}`);
  console.log(`USDC mint:    ${usdcMint.toBase58()}`);
  console.log(`Vault PDA:    ${rwtVault.toBase58()}`);
  console.log(`Capital ATA:  ${capitalAcc.toBase58()}`);
  console.log(`DAO fee ATA:  ${daoFeeAccount.toBase58()}`);
  console.log(`Deployer USDC ATA: ${deployerUsdcAta.toBase58()}`);
  console.log(`Deployer RWT ATA:  ${deployerRwtAta.toBase58()}`);
  console.log(`(deployer USDC ATA == dao_fee_account? ${deployerUsdcAta.equals(daoFeeAccount)})`);

  // ---------------------------------------------------------------
  // Pre-flight: read state, project math, verify no blockers
  // ---------------------------------------------------------------
  const vaultPre = await readVault(conn, rwtVault);
  if (vaultPre.mintPaused) {
    throw new Error('vault.mint_paused = true; refusing to call mint_rwt');
  }
  const nav = vaultPre.navBookValue;
  const fee_total = (amount * MINT_FEE_BPS) / BPS_DENOMINATOR;
  const dao_fee = fee_total / 2n;
  const vault_fee = fee_total - dao_fee;
  const net_deposit = amount - fee_total;
  const expected_rwt_out = (net_deposit * NAV_SCALE) / BigInt(nav);

  // Slippage cushion: tolerate 1% drift from projected output to absorb any
  // sub-microsecond NAV-recompute drift if another mint sneaks in between
  // pre-flight and on-chain handler. 99% of expected_rwt_out is safe.
  const min_rwt_out = (expected_rwt_out * 99n) / 100n;

  const usdcSupplyPre = await getMintSupply(conn, usdcMint);
  const rwtSupplyPre = await getMintSupply(conn, rwtMint);
  const deployerUsdcPre = await getTokenBalance(conn, deployerUsdcAta);
  const deployerRwtPre = await getTokenBalance(conn, deployerRwtAta);
  const capitalUsdcPre = await getTokenBalance(conn, capitalAcc);
  const feeUsdcPre = await getTokenBalance(conn, daoFeeAccount);
  const solPre = await conn.getBalance(deployer.publicKey, 'confirmed');

  console.log('\n=== Pre-state ===');
  console.log(`  vault.total_invested_capital: ${vaultPre.totalInvestedCapital}`);
  console.log(`  vault.total_rwt_supply:       ${vaultPre.totalRwtSupply}`);
  console.log(`  vault.nav_book_value:         ${nav}`);
  console.log(`  USDC mint supply:             ${usdcSupplyPre}`);
  console.log(`  RWT mint supply:              ${rwtSupplyPre}`);
  console.log(`  deployer USDC:                ${deployerUsdcPre}`);
  console.log(`  deployer RWT:                 ${deployerRwtPre}`);
  console.log(`  capital accumulator USDC:     ${capitalUsdcPre}`);
  console.log(`  areal_fee_destination USDC:   ${feeUsdcPre}`);
  console.log(`  deployer SOL:                 ${solPre / 1e9}`);

  console.log('\n=== Projected math (NAV = ' + (Number(nav) / 1e6).toFixed(6) + ') ===');
  console.log(`  amount:        ${amount} (${Number(amount) / 1e6} USDC)`);
  console.log(`  fee_total:     ${fee_total} (${Number(fee_total) / 1e6} USDC, 1%)`);
  console.log(`  dao_fee:       ${dao_fee} (${Number(dao_fee) / 1e6} USDC, to areal_fee_destination)`);
  console.log(`  vault_fee:     ${vault_fee} (${Number(vault_fee) / 1e6} USDC, to capital_acc)`);
  console.log(`  net_deposit:   ${net_deposit} (${Number(net_deposit) / 1e6} USDC, to capital_acc)`);
  console.log(`  expected_rwt:  ${expected_rwt_out} (${Number(expected_rwt_out) / 1e6} RWT)`);
  console.log(`  min_rwt_out:   ${min_rwt_out} (99% of expected, slippage floor)`);

  // ---------------------------------------------------------------
  // Step 1: Mint amount USDC to deployer's USDC ATA (deployer is auth)
  // ---------------------------------------------------------------
  console.log('\n=== Step 1: mintTo USDC ===');
  const mintIx = createMintToInstruction(
    usdcMint,
    deployerUsdcAta,
    deployer.publicKey, // mint authority
    amount,
    [],
    TOKEN_PROGRAM_ID,
  );
  const mintTx = new Transaction().add(mintIx);
  const mintSig = await sendAndConfirm(conn, mintTx, [deployer]);
  console.log(`  tx: ${mintSig}`);
  console.log(`  explorer: https://explorer.solana.com/tx/${mintSig}?cluster=devnet`);

  const usdcAfterMint = await getTokenBalance(conn, deployerUsdcAta);
  console.log(`  deployer USDC after mint: ${usdcAfterMint} (delta +${usdcAfterMint - deployerUsdcPre})`);
  if (usdcAfterMint - deployerUsdcPre !== amount) {
    throw new Error(
      `unexpected USDC delta: got ${usdcAfterMint - deployerUsdcPre}, expected ${amount}`,
    );
  }

  // ---------------------------------------------------------------
  // Step 2: call rwt_engine::mint_rwt
  // ---------------------------------------------------------------
  console.log('\n=== Step 2: rwt_engine::mint_rwt ===');
  const rwtClient = new ArlexClient(
    normalizeIdl(loadIdl('rwt-engine')),
    rwtProgramId,
    conn,
  );

  const mintRwtTx = rwtClient.buildTransaction('mint_rwt', {
    accounts: {
      user: deployer.publicKey,
      rwt_vault: rwtVault,
      rwt_mint: rwtMint,
      user_deposit: deployerUsdcAta,
      user_rwt: deployerRwtAta,
      capital_acc: capitalAcc,
      dao_fee_account: daoFeeAccount,
      token_program: TOKEN_PROGRAM_ID,
    },
    args: { amount, min_rwt_out },
  });

  // The handler does: 2 SPL Transfers + MintTo CPI + state mutation + emit.
  // 200K is generally enough but bump to 250K for headroom (matches the
  // pattern in scripts/fix-rwt-nav-invariant.ts).
  mintRwtTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }));

  const mintRwtSig = await sendAndConfirm(conn, mintRwtTx, [deployer]);
  console.log(`  tx: ${mintRwtSig}`);
  console.log(`  explorer: https://explorer.solana.com/tx/${mintRwtSig}?cluster=devnet`);

  // ---------------------------------------------------------------
  // Post-flight: read state, verify deltas
  // ---------------------------------------------------------------
  const vaultPost = await readVault(conn, rwtVault);
  const usdcSupplyPost = await getMintSupply(conn, usdcMint);
  const rwtSupplyPost = await getMintSupply(conn, rwtMint);
  const deployerUsdcPost = await getTokenBalance(conn, deployerUsdcAta);
  const deployerRwtPost = await getTokenBalance(conn, deployerRwtAta);
  const capitalUsdcPost = await getTokenBalance(conn, capitalAcc);
  const feeUsdcPost = await getTokenBalance(conn, daoFeeAccount);
  const solPost = await conn.getBalance(deployer.publicKey, 'confirmed');

  console.log('\n=== Post-state ===');
  console.log(`  vault.total_invested_capital: ${vaultPost.totalInvestedCapital} (delta +${vaultPost.totalInvestedCapital - vaultPre.totalInvestedCapital})`);
  console.log(`  vault.total_rwt_supply:       ${vaultPost.totalRwtSupply} (delta +${vaultPost.totalRwtSupply - vaultPre.totalRwtSupply})`);
  console.log(`  vault.nav_book_value:         ${vaultPost.navBookValue}`);
  console.log(`  USDC mint supply:             ${usdcSupplyPost} (delta +${usdcSupplyPost - usdcSupplyPre})`);
  console.log(`  RWT mint supply:              ${rwtSupplyPost} (delta +${rwtSupplyPost - rwtSupplyPre})`);
  console.log(`  deployer USDC:                ${deployerUsdcPost} (delta ${deployerUsdcPost - deployerUsdcPre})`);
  console.log(`  deployer RWT:                 ${deployerRwtPost} (delta +${deployerRwtPost - deployerRwtPre})`);
  console.log(`  capital accumulator USDC:     ${capitalUsdcPost} (delta +${capitalUsdcPost - capitalUsdcPre})`);
  console.log(`  areal_fee_destination USDC:   ${feeUsdcPost} (delta +${feeUsdcPost - feeUsdcPre})`);
  console.log(`  deployer SOL:                 ${solPost / 1e9} (delta ${(solPost - solPre) / 1e9})`);

  // NAV invariant: capital / supply * NAV_SCALE == nav_book_value (integer math)
  const navCalc =
    vaultPost.totalRwtSupply > 0n
      ? (vaultPost.totalInvestedCapital * NAV_SCALE) / vaultPost.totalRwtSupply
      : 0n;
  console.log(`\n=== NAV invariant check ===`);
  console.log(`  capital * NAV_SCALE / supply = ${navCalc}`);
  console.log(`  vault.nav_book_value         = ${vaultPost.navBookValue}`);
  console.log(`  match: ${navCalc === BigInt(vaultPost.navBookValue)}`);

  console.log('\n=== Summary ===');
  console.log(`  USDC mintTo signature:        ${mintSig}`);
  console.log(`  mint_rwt signature:           ${mintRwtSig}`);
  console.log(`  RWT received:                 ${deployerRwtPost - deployerRwtPre} (${Number(deployerRwtPost - deployerRwtPre) / 1e6} RWT)`);
  console.log(`  Total deployer RWT now:       ${deployerRwtPost} (${Number(deployerRwtPost) / 1e6} RWT)`);
  console.log(`  SOL spent on tx fees:         ${(solPre - solPost) / 1e9}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  process.exit(1);
});
