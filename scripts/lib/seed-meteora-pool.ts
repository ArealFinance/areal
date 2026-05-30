#!/usr/bin/env tsx
/*
 * seed-meteora-pool.ts — stand up + seed a Meteora DLMM pool for the earn
 * product's Sell-side on devnet (earn-RWT / USDC).
 *
 * WHY METEORA (not native-dex): the SAME Meteora DLMM program is deployed on
 * devnet and mainnet (LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo), so this
 * exact integration is what ships to prod — devnet↔prod parity. The frontend
 * swaps against Meteora directly via @meteora-ag/dlmm (Jupiter does not route
 * devnet; that is a mainnet-only routing bonus, not our code path).
 *
 * VIABILITY (verified, 2026-05-30, @meteora-ag/dlmm@1.9.10):
 *   - The DLMM program is deployed + executable on devnet at the address above.
 *   - DLMM.createCustomizablePermissionlessLbPair() builds an
 *     `InitializeCustomizablePermissionlessLbPair` ix that SIMULATES CLEANLY on
 *     devnet (sim err: null). This path takes bin step / base fee / active bin
 *     DIRECTLY and needs NO preset-parameter PDA — which matters because devnet
 *     generally lacks the curated preset accounts mainnet has. So we use the
 *     customizable-permissionless path, not createLbPair/createLbPair2.
 *
 * CANONICAL TOKEN ORDER: Meteora sorts the pair by mint-pubkey bytes.
 *   Buffer.compare(earn-RWT, USDC) == 1  =>  tokenX = USDC, tokenY = earn-RWT.
 *   The DLMM "price" (pricePerToken) is tokenY-per-tokenX = RWT-per-USDC = 1/NAV
 *   (verified on-chain 2026-05-30). So the active bin is set from 1/NAV, and the
 *   resulting USDC-per-RWT price equals the earn NAV (~$1.033). Passing NAV
 *   directly here would seed the pool INVERTED (~$0.9657 USDC/RWT) — don't.
 *
 * SAFETY: DEFAULTS TO DRY-RUN. With --dry-run (or no flag) the script reads live
 * state, computes the plan, builds the pool-creation tx and runs
 * simulateTransaction (read-only), and prints the full plan + seed amounts. It
 * sends NOTHING and writes NOTHING. Only --execute creates the pool, seeds
 * liquidity, and journals the result.
 *
 * Usage (from repo root, scripts run with NODE_PATH=bots/node_modules):
 *   NODE_PATH=bots/node_modules npx tsx scripts/lib/seed-meteora-pool.ts            # dry-run (default)
 *   NODE_PATH=bots/node_modules npx tsx scripts/lib/seed-meteora-pool.ts --execute  # actually create + seed
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMintToInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import DLMM, {
  LBCLMM_PROGRAM_IDS,
  ActivationType,
  StrategyType,
  deriveCustomizablePermissionlessLbPair,
  getPriceOfBinByBinId,
} from '@meteora-ag/dlmm';

// --------------------------------------------------------------------------
// Paths & constants
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const ADDRESSES_PATH = join(REPO_ROOT, 'data', 'devnet-addresses.json');

const SYSTEM_PROGRAM_ID = SystemProgram.programId;

// Meteora DLMM program ID (devnet == mainnet). Read from the SDK so it can't
// drift; assert it matches the documented constant as a tamper check.
const DLMM_PROGRAM_ID = new PublicKey(LBCLMM_PROGRAM_IDS.devnet);
const DLMM_PROGRAM_ID_EXPECTED = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';

// earn pricing constants (contracts/earn/src/constants.rs).
const NAV_SCALE = 1_000_000n; // 6-dec fixed point
const INITIAL_NAV = NAV_SCALE;
const BPS_DENOMINATOR = 10_000n;
const DEFAULT_MINT_FEE_BPS = 100n; // 1% — used to size the USDC deposit for mint_rwt

// earn ix discriminator (mirrors scripts/lib/e2e-earn.ts MINT_RWT_DISCRIMINATOR).
const MINT_RWT_DISCRIMINATOR = Buffer.from([0x62, 0x20, 0x73, 0xde, 0x44, 0x0c, 0xa1, 0xa2]);

// Token decimals (both 6 on devnet).
const RWT_DECIMALS = 6;
const USDC_DECIMALS = 6;

// SPL layout offsets.
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64; // u64
const MINT_SUPPLY_OFFSET = 36; // u64
const EARN_TOTAL_CAPITAL_OFFSET = 8; // u128 (low 64 + high 64<<64)

// ===== Pool parameters (rationale in the deliverable report) =====
// Small bin step for a near-$1 stable-ish pair: 25 bps per bin gives ~0.25%
// price granularity — tight enough for depth, coarse enough that a handful of
// bins covers a sensible band. Base fee 30 bps (0.30%) is a reasonable swap fee
// for a test pool. Spot strategy spreads the seed evenly across the band.
const BIN_STEP_BPS = 25;
const BASE_FEE_BPS = 30;
const BIN_SPREAD = 5; // bins on EACH side of the active bin (so 11 bins total)
const LIQUIDITY_SLIPPAGE_PCT = 5; // active-bin slippage tolerance for the seed tx

// ===== Seed amounts (POL) =====
// Target a balanced seed at NAV ~$1.03: ~1000 USDC + ~970 RWT. With tokenX=USDC
// and tokenY=RWT, totalXAmount=USDC, totalYAmount=RWT.
const SEED_USDC = 1_000_000_000n; // 1000 USDC (6 dec)
const SEED_RWT = 970_000_000n; //  970 RWT  (6 dec)
// Small headroom kept in the deployer's RWT ATA after the seed.
const RWT_BUFFER = 5_000_000n; // 5 RWT

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function log(stage: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[seed-meteora-pool] [${stage}] ${msg}`;
  if (extra) console.log(line, JSON.stringify(stringifyBigInts(extra)));
  else console.log(line);
}

function warn(stage: string, msg: string): void {
  console.warn(`[seed-meteora-pool] [${stage}] WARN: ${msg}`);
}

function stringifyBigInts(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(stringifyBigInts);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = stringifyBigInts(val);
    return out;
  }
  return v;
}

// --------------------------------------------------------------------------
// devnet-addresses.json I/O
// --------------------------------------------------------------------------

interface MeteoraPoolSection {
  program_id?: string;
  pool_address?: string;
  token_x?: string; // canonical X (USDC)
  token_y?: string; // canonical Y (earn-RWT)
  bin_step_bps?: number;
  base_fee_bps?: number;
  initial_active_id?: number;
  initial_price_usdc_per_rwt?: string;
  position_pubkey?: string;
  seed_usdc?: string;
  seed_rwt?: string;
  bin_spread?: number;
  created_at?: string;
}

interface EarnSection {
  earn_rwt_mint?: string;
  earn_config_pda?: string;
  basket_vault?: string;
  dao_fee_destination?: string;
  meteora_pool?: MeteoraPoolSection;
  [k: string]: unknown;
}

interface DevnetAddresses {
  cluster: string;
  rpc: { http: string; ws?: string; airdrop_http?: string };
  deployer: { keypair_path: string; pubkey: string };
  mints: { usdc: string; [k: string]: string | undefined };
  earn?: EarnSection;
  [k: string]: unknown;
}

function loadAddresses(): DevnetAddresses {
  return JSON.parse(readFileSync(ADDRESSES_PATH, 'utf8')) as DevnetAddresses;
}

/** Atomic write: tmp file in the same dir, then rename over the target. */
function saveAddresses(art: DevnetAddresses): void {
  const tmp = `${ADDRESSES_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(art, null, 2) + '\n', 'utf8');
  renameSync(tmp, ADDRESSES_PATH);
}

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(readFileSync(p, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function findAta(mint: PublicKey, owner: PublicKey, allowOwnerOffCurve = false): PublicKey {
  return getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({
  pubkey,
  isSigner,
  isWritable,
});

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

async function readTokenAmount(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata, 'confirmed');
  if (!info || info.data.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) return 0n;
  return info.data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
}

async function readMintSupply(conn: Connection, mint: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(mint, 'confirmed');
  if (!info || info.data.length < MINT_SUPPLY_OFFSET + 8) return 0n;
  return info.data.readBigUInt64LE(MINT_SUPPLY_OFFSET);
}

/** EarnConfig.total_invested_capital (u128 LE) → bigint. */
async function readEarnCapital(conn: Connection, pda: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(pda, 'confirmed');
  if (!info) throw new Error(`EarnConfig PDA ${pda.toBase58()} not found`);
  return (
    info.data.readBigUInt64LE(EARN_TOTAL_CAPITAL_OFFSET) +
    (info.data.readBigUInt64LE(EARN_TOTAL_CAPITAL_OFFSET + 8) << 64n)
  );
}

/** earn NAV (6-dec): supply 0 → INITIAL_NAV; else capital × NAV_SCALE / supply, min 1. */
function calcNav(capital: bigint, supply: bigint): bigint {
  if (supply === 0n) return INITIAL_NAV;
  const nav = (capital * NAV_SCALE) / supply;
  return nav > 0n ? nav : 1n;
}

/** mint_rwt RWT out: floor(usdc × NAV_SCALE / nav). Mirrors contracts/earn. */
function calcRwtOut(usdc: bigint, nav: bigint): bigint {
  return (usdc * NAV_SCALE) / nav;
}

async function accountExists(conn: Connection, addr: PublicKey): Promise<boolean> {
  return (await conn.getAccountInfo(addr, 'confirmed')) !== null;
}

// --------------------------------------------------------------------------
// tx send / simulate
// --------------------------------------------------------------------------

async function simulateOrSend(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  execute: boolean,
  label: string,
): Promise<string | null> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  // Some Meteora txs already carry partial signatures (position keypair). Use
  // partialSign so we don't clobber them.
  for (const s of signers) tx.partialSign(s);

  if (!execute) {
    const sim = await conn.simulateTransaction(tx);
    const err = sim.value.err;
    log('simulate', `${label}: ${err ? 'ERR' : 'OK'}`, {
      err: err ?? null,
      unitsConsumed: sim.value.unitsConsumed ?? null,
    });
    if (sim.value.logs) for (const l of sim.value.logs) console.log(`    | ${l}`);
    if (err) throw new Error(`simulation failed for ${label}: ${JSON.stringify(err)}`);
    return null;
  }

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const s = value?.[0];
    if (s?.err) throw new Error(`${label} tx failed: ${JSON.stringify(s.err)} (sig=${sig})`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
      log('send', `${label} OK`, { sig });
      console.log(`    explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      return sig;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`${label} confirmation timeout: sig=${sig}`);
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

interface Cli {
  execute: boolean;
}

function parseArgs(argv: string[]): Cli {
  let execute = false;
  for (const a of argv) {
    if (a === '--execute') execute = true;
    else if (a === '--dry-run') execute = false;
    else throw new Error(`unknown flag: ${a} (valid: --dry-run | --execute)`);
  }
  return { execute };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const { execute } = parseArgs(process.argv.slice(2));

  // --- Load + guard -------------------------------------------------------
  const art = loadAddresses();
  if (art.cluster !== 'devnet' || !art.rpc.http.includes('devnet')) {
    throw new Error(`refusing to run on non-devnet target (cluster=${art.cluster})`);
  }
  if (DLMM_PROGRAM_ID.toBase58() !== DLMM_PROGRAM_ID_EXPECTED) {
    throw new Error(
      `SDK devnet DLMM program id ${DLMM_PROGRAM_ID.toBase58()} != expected ${DLMM_PROGRAM_ID_EXPECTED}`,
    );
  }
  if (!art.earn?.earn_rwt_mint || !art.earn?.earn_config_pda) {
    throw new Error('earn section incomplete (need earn_rwt_mint + earn_config_pda) — run bootstrap-earn first');
  }

  const conn = new Connection(art.rpc.http, 'confirmed');
  const deployer = loadKeypair(join(REPO_ROOT, art.deployer.keypair_path));
  if (deployer.publicKey.toBase58() !== art.deployer.pubkey) {
    throw new Error(`deployer keypair ${deployer.publicKey.toBase58()} != addresses.json ${art.deployer.pubkey}`);
  }

  const rwtMint = new PublicKey(art.earn.earn_rwt_mint);
  const usdcMint = new PublicKey(art.mints.usdc);
  const earnConfigPda = new PublicKey(art.earn.earn_config_pda);
  const earnProgramId = new PublicKey((art.programs as Record<string, { pubkey: string }>).earn.pubkey);
  const basketVault = new PublicKey(art.earn.basket_vault!);
  const daoFeeDestination = new PublicKey(art.earn.dao_fee_destination!);

  // --- Verify DLMM program is live on devnet ------------------------------
  {
    const info = await conn.getAccountInfo(DLMM_PROGRAM_ID);
    if (!info || !info.executable) {
      throw new Error(`Meteora DLMM program ${DLMM_PROGRAM_ID.toBase58()} not deployed/executable on devnet`);
    }
    log('preflight', 'Meteora DLMM program present + executable on devnet', {
      programId: DLMM_PROGRAM_ID.toBase58(),
    });
  }

  // --- Canonical token sort (Meteora orders by mint-pubkey bytes) ---------
  const rwtFirst = Buffer.compare(rwtMint.toBuffer(), usdcMint.toBuffer()) < 0;
  const tokenX = rwtFirst ? rwtMint : usdcMint;
  const tokenY = rwtFirst ? usdcMint : rwtMint;
  // Sanity: on devnet USDC sorts before earn-RWT, so X=USDC, Y=RWT. Guard it so
  // a future mint swap doesn't silently flip the price interpretation below.
  if (tokenX.equals(rwtMint)) {
    throw new Error(
      'unexpected token sort: earn-RWT sorts before USDC — the price/seed mapping ' +
        'below assumes tokenX=USDC, tokenY=RWT. Re-derive before proceeding.',
    );
  }
  // ORIENTATION (verified on-chain 2026-05-30): for tokenX=USDC, tokenY=RWT,
  // Meteora's price (getActiveBin().pricePerToken, and the value the SDK
  // helpers below consume) is **tokenY-per-tokenX = RWT-per-USDC = 1 / (USDC
  // per RWT) = 1 / NAV**. A previous version passed NAV directly here, which
  // seeded the pool at the INVERTED price (~$0.9657 USDC/RWT instead of NAV).
  // We pass 1/NAV so the resulting USDC-per-RWT price equals NAV.

  // --- Live NAV → initial price + active bin ------------------------------
  const capital = await readEarnCapital(conn, earnConfigPda);
  const rwtSupply = await readMintSupply(conn, rwtMint);
  const navMicro = calcNav(capital, rwtSupply); // 6-dec USDC per RWT
  const navUsd = Number(navMicro) / 1e6; // USDC per RWT (display orientation)
  const sdkPrice = 1 / navUsd; // RWT per USDC — the SDK/pricePerToken orientation

  // pricePerLamport accounts for both mints' decimals; getBinIdFromPrice maps
  // that to the active bin. min=false rounds to the bin whose price floor is
  // <= the target (the standard "active bin at this price" choice).
  const pricePerLamport = (DLMM as unknown as {
    getPricePerLamport(dx: number, dy: number, p: number): string;
  }).getPricePerLamport(USDC_DECIMALS, RWT_DECIMALS, sdkPrice);
  const activeId = (DLMM as unknown as {
    getBinIdFromPrice(p: string | number, binStep: number, min: boolean): number;
  }).getBinIdFromPrice(pricePerLamport, BIN_STEP_BPS, false);
  // getPriceOfBinByBinId returns the pricePerToken orientation (RWT-per-USDC).
  // The product-facing USDC-per-RWT price is its inverse.
  const activeBinPriceRwtPerUsdc = getPriceOfBinByBinId(activeId, BIN_STEP_BPS);
  const usdcPerRwt = (1 / Number(activeBinPriceRwtPerUsdc)).toFixed(10);

  // --- Derived addresses --------------------------------------------------
  const [poolPda, poolBump] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, DLMM_PROGRAM_ID);
  const deployerUsdc = findAta(usdcMint, deployer.publicKey, false);
  const deployerRwt = findAta(rwtMint, deployer.publicKey, false);

  // --- Current balances ---------------------------------------------------
  const usdcBal = await readTokenAmount(conn, deployerUsdc);
  const rwtBal = await readTokenAmount(conn, deployerRwt);

  // RWT needed = seed + small buffer. USDC needed = seed + (any mint_rwt cost).
  const rwtNeeded = SEED_RWT + RWT_BUFFER;
  const rwtShort = rwtNeeded > rwtBal ? rwtNeeded - rwtBal : 0n;

  // To cover an RWT shortfall via earn.mint_rwt: deposit USDC body sized so that
  // floor(usdc × NAV_SCALE / nav) >= rwtShort, then +1% fee on top (the fee is
  // skimmed to dao_fee_destination, it does NOT count toward RWT minted).
  // usdc_body = ceil(rwtShort × nav / NAV_SCALE) + slack(1 RWT worth) for floor.
  let mintUsdcBody = 0n;
  let mintFee = 0n;
  let expectedRwtFromMint = 0n;
  if (rwtShort > 0n) {
    mintUsdcBody = (rwtShort * navMicro + (NAV_SCALE - 1n)) / NAV_SCALE; // ceil
    mintUsdcBody += navMicro; // +~1 RWT worth of slack to absorb floor rounding
    mintFee = (mintUsdcBody * DEFAULT_MINT_FEE_BPS) / BPS_DENOMINATOR; // 1% fee
    expectedRwtFromMint = calcRwtOut(mintUsdcBody, navMicro);
  }
  const usdcNeeded = SEED_USDC + mintUsdcBody + mintFee;

  // --- Plan print ---------------------------------------------------------
  console.log('\n================ seed-meteora-pool PLAN ================');
  console.log(`mode:                 ${execute ? 'EXECUTE (will create + seed)' : 'DRY-RUN (simulate only)'}`);
  console.log(`rpc:                  ${art.rpc.http}`);
  console.log(`deployer:             ${deployer.publicKey.toBase58()}`);
  console.log('--- Meteora ---');
  console.log(`DLMM program:         ${DLMM_PROGRAM_ID.toBase58()}`);
  console.log(`pool PDA (to create): ${poolPda.toBase58()} (bump ${poolBump})`);
  console.log(`tokenX (canonical):   ${tokenX.toBase58()}  (USDC)`);
  console.log(`tokenY (canonical):   ${tokenY.toBase58()}  (earn-RWT)`);
  console.log('--- pool params ---');
  console.log(`bin step:             ${BIN_STEP_BPS} bps`);
  console.log(`base fee:             ${BASE_FEE_BPS} bps`);
  console.log(`live earn NAV:        $${navUsd}  (capital=${capital} / supply=${rwtSupply}, 6-dec=${navMicro})`);
  console.log(`active bin id:        ${activeId}  (USDC/RWT ≈ ${usdcPerRwt}, raw RWT/USDC ${activeBinPriceRwtPerUsdc})`);
  console.log(`pricePerLamport:      ${pricePerLamport}`);
  console.log('--- seed (POL) ---');
  console.log(`seed USDC (tokenX):   ${SEED_USDC}  (${Number(SEED_USDC) / 1e6} USDC)`);
  console.log(`seed RWT  (tokenY):   ${SEED_RWT}  (${Number(SEED_RWT) / 1e6} RWT)`);
  console.log(`bin spread:           ±${BIN_SPREAD} bins (Spot strategy, ${BIN_SPREAD * 2 + 1} bins total)`);
  console.log('--- deployer balances ---');
  console.log(`USDC balance:         ${usdcBal}  (${Number(usdcBal) / 1e6} USDC)`);
  console.log(`RWT  balance:         ${rwtBal}  (${Number(rwtBal) / 1e6} RWT)`);
  console.log(`USDC needed:          ${usdcNeeded}  (seed ${SEED_USDC} + mint body ${mintUsdcBody} + fee ${mintFee})`);
  console.log(`RWT  needed:          ${rwtNeeded}  (seed ${SEED_RWT} + buffer ${RWT_BUFFER})`);
  if (rwtShort > 0n) {
    console.log(`RWT SHORT by:         ${rwtShort} → will mint_rwt: deposit ${mintUsdcBody} USDC (+${mintFee} fee) → ~${expectedRwtFromMint} RWT`);
  } else {
    console.log('RWT sufficient:       no mint_rwt needed');
  }
  console.log('=======================================================\n');

  // --- Balance feasibility checks (don't proceed if clearly underfunded) --
  // Deployer is the USDC mint authority, so a USDC shortfall is auto-topped-up
  // by minting test USDC. An RWT shortfall is covered by mint_rwt (which itself
  // consumes USDC, already folded into usdcNeeded).
  let usdcMintTopUp = 0n;
  if (usdcBal < usdcNeeded) {
    usdcMintTopUp = usdcNeeded - usdcBal;
    // Round up to whole USDC for clean logs.
    usdcMintTopUp = ((usdcMintTopUp + 999_999n) / 1_000_000n) * 1_000_000n;
    log('usdc-topup', 'deployer USDC below need — will mint test USDC (deployer=USDC mint authority)', {
      shortBy: usdcNeeded - usdcBal,
      willMint: usdcMintTopUp,
    });
  }

  // ========================================================================
  // STEP 1: top up USDC (deployer = USDC mint authority) if short.
  // ========================================================================
  if (usdcMintTopUp > 0n) {
    const ix = createMintToInstruction(
      usdcMint,
      deployerUsdc,
      deployer.publicKey,
      usdcMintTopUp,
      [],
      TOKEN_PROGRAM_ID,
    );
    const tx = new Transaction().add(ix);
    if (!execute) {
      log('mint-usdc', 'DRY-RUN — would mint test USDC to deployer', { amount: usdcMintTopUp });
    } else {
      await simulateOrSend(conn, tx, [deployer], execute, `mint ${usdcMintTopUp} test USDC`);
    }
  }

  // ========================================================================
  // STEP 2: top up earn-RWT via earn.mint_rwt if short.
  // Account order (contracts/earn/src/instructions/mint_rwt.rs):
  //   0 user(=deployer)    signer
  //   1 earn_config        mut
  //   2 rwt_mint           mut
  //   3 user_usdc          mut
  //   4 user_rwt           mut
  //   5 basket_vault       mut
  //   6 dao_fee_destination mut
  //   7 token_program
  // ========================================================================
  if (rwtShort > 0n) {
    // Ensure the deployer's RWT ATA exists (mint_rwt writes into it).
    const ixs: TransactionInstruction[] = [];
    if (!(await accountExists(conn, deployerRwt))) {
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          deployer.publicKey,
          deployerRwt,
          deployer.publicKey,
          rwtMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }
    const data = Buffer.concat([MINT_RWT_DISCRIMINATOR, u64le(mintUsdcBody), u64le(1n)]);
    ixs.push(
      new TransactionInstruction({
        programId: earnProgramId,
        keys: [
          meta(deployer.publicKey, true, false),
          meta(earnConfigPda, false, true),
          meta(rwtMint, false, true),
          meta(deployerUsdc, false, true),
          meta(deployerRwt, false, true),
          meta(basketVault, false, true),
          meta(daoFeeDestination, false, true),
          meta(TOKEN_PROGRAM_ID, false, false),
        ],
        data,
      }),
    );
    const tx = new Transaction().add(...ixs);
    if (!execute) {
      // mint_rwt depends on the USDC top-up (un-sent in dry-run) being committed.
      log(
        'mint-rwt',
        'DEFERRED in dry-run — depends on USDC top-up from a prior un-sent tx; ' +
          'would simulate cleanly once that tx is committed under --execute',
        { depositUsdc: mintUsdcBody, expectedRwtOut: expectedRwtFromMint },
      );
    } else {
      await simulateOrSend(conn, tx, [deployer], execute, `mint_rwt (deposit ${mintUsdcBody} USDC → RWT)`);
      const rwtAfter = await readTokenAmount(conn, deployerRwt);
      if (rwtAfter < rwtNeeded) {
        throw new Error(`after mint_rwt deployer RWT ${rwtAfter} still < needed ${rwtNeeded}`);
      }
      log('mint-rwt', 'topped up', { rwtBalance: rwtAfter });
    }
  }

  // ========================================================================
  // STEP 3: create the Meteora DLMM pool (customizable-permissionless path).
  // No preset-parameter PDA required — bin step / fee / active bin are passed
  // directly, which is the devnet-safe creation path.
  // ========================================================================
  const poolAlreadyExists = await accountExists(conn, poolPda);
  if (poolAlreadyExists) {
    warn('create-pool', `pool ${poolPda.toBase58()} already exists — skipping creation, will only (re)seed`);
  } else {
    const createTx = await (DLMM as unknown as {
      createCustomizablePermissionlessLbPair(
        conn: Connection,
        binStep: BN,
        tokenX: PublicKey,
        tokenY: PublicKey,
        activeId: BN,
        feeBps: BN,
        activationType: ActivationType,
        hasAlphaVault: boolean,
        creatorKey: PublicKey,
        activationPoint?: BN,
        creatorPoolOnOffControl?: boolean,
        concreteFunctionType?: unknown,
        collectFeeMode?: unknown,
        opt?: { cluster?: string },
      ): Promise<Transaction>;
    }).createCustomizablePermissionlessLbPair(
      conn,
      new BN(BIN_STEP_BPS),
      tokenX,
      tokenY,
      new BN(activeId),
      new BN(BASE_FEE_BPS),
      ActivationType.Timestamp,
      false, // hasAlphaVault
      deployer.publicKey, // creatorKey
      undefined, // activationPoint (active immediately)
      false, // creatorPoolOnOffControl
      undefined, // concreteFunctionType (default)
      undefined, // collectFeeMode (default)
      { cluster: 'devnet' },
    );
    // Creation tx is built by the SDK; sign with deployer only (no extra signer).
    await simulateOrSend(conn, createTx, [deployer], execute, 'create Meteora DLMM pool');
  }

  // ========================================================================
  // STEP 4: seed liquidity (POL) — Spot strategy across ±BIN_SPREAD bins.
  // Requires a live DLMM instance, which only exists once the pool account is
  // on-chain. In dry-run we have NOT sent the create tx, so we cannot build the
  // position tx (DLMM.create would fail to fetch the pool). Defer + describe.
  // ========================================================================
  const positionKp = Keypair.generate();
  if (!execute) {
    if (poolAlreadyExists) {
      // Pool is real on-chain — we CAN build + simulate the seed tx in dry-run.
      await buildAndRunSeedTx(conn, poolPda, deployer, positionKp, activeId, execute);
    } else {
      log(
        'seed-liquidity',
        'DEFERRED in dry-run — the position tx needs the pool account on-chain ' +
          '(created by the un-sent STEP 3 tx). Plan:',
        {
          positionPubkey: positionKp.publicKey.toBase58(),
          strategy: 'Spot',
          minBinId: activeId - BIN_SPREAD,
          maxBinId: activeId + BIN_SPREAD,
          totalXUsdc: SEED_USDC,
          totalYRwt: SEED_RWT,
          slippagePct: LIQUIDITY_SLIPPAGE_PCT,
        },
      );
    }
  } else {
    await buildAndRunSeedTx(conn, poolPda, deployer, positionKp, activeId, execute);
  }

  // ========================================================================
  // STEP 5: journal pool into data/devnet-addresses.json under earn.meteora_pool
  // ========================================================================
  const poolSection: MeteoraPoolSection = {
    program_id: DLMM_PROGRAM_ID.toBase58(),
    pool_address: poolPda.toBase58(),
    token_x: tokenX.toBase58(),
    token_y: tokenY.toBase58(),
    bin_step_bps: BIN_STEP_BPS,
    base_fee_bps: BASE_FEE_BPS,
    initial_active_id: activeId,
    initial_price_usdc_per_rwt: usdcPerRwt,
    position_pubkey: positionKp.publicKey.toBase58(),
    seed_usdc: SEED_USDC.toString(),
    seed_rwt: SEED_RWT.toString(),
    bin_spread: BIN_SPREAD,
  };

  if (execute) {
    poolSection.created_at = new Date().toISOString();
    const earn: EarnSection = { ...(art.earn ?? {}) };
    earn.meteora_pool = poolSection;
    art.earn = earn;
    saveAddresses(art);
    log('journal', `wrote earn.meteora_pool to ${ADDRESSES_PATH}`, { pool: poolPda.toBase58() });
  } else {
    log('journal', 'DRY-RUN — not writing devnet-addresses.json. Would journal earn.meteora_pool:', poolSection as unknown as Record<string, unknown>);
  }

  console.log(`\n[seed-meteora-pool] DONE (${execute ? 'executed' : 'dry-run / simulate only'}).`);
}

/**
 * Build + simulate/send the position-initialize + add-liquidity tx. Only called
 * when the pool account is live on-chain (always under --execute; in dry-run
 * only if the pool already existed).
 */
async function buildAndRunSeedTx(
  conn: Connection,
  poolPda: PublicKey,
  deployer: Keypair,
  positionKp: Keypair,
  activeId: number,
  execute: boolean,
): Promise<void> {
  const dlmm = await (DLMM as unknown as {
    create(conn: Connection, pool: PublicKey, opt?: { cluster?: string }): Promise<unknown>;
  }).create(conn, poolPda, { cluster: 'devnet' });

  const seedTx = await (dlmm as {
    initializePositionAndAddLiquidityByStrategy(args: {
      positionPubKey: PublicKey;
      totalXAmount: BN;
      totalYAmount: BN;
      strategy: { minBinId: number; maxBinId: number; strategyType: StrategyType };
      user: PublicKey;
      slippage: number;
    }): Promise<Transaction>;
  }).initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKp.publicKey,
    totalXAmount: new BN(SEED_USDC.toString()),
    totalYAmount: new BN(SEED_RWT.toString()),
    strategy: {
      minBinId: activeId - BIN_SPREAD,
      maxBinId: activeId + BIN_SPREAD,
      strategyType: StrategyType.Spot,
    },
    user: deployer.publicKey,
    slippage: LIQUIDITY_SLIPPAGE_PCT,
  });

  // The position account is a fresh keypair the SDK expects us to co-sign.
  await simulateOrSend(conn, seedTx, [deployer, positionKp], execute, 'seed liquidity (Spot)');
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  process.exit(1);
});
