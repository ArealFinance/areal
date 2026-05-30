#!/usr/bin/env tsx
/*
 * e2e-earn.ts — full-lifecycle end-to-end test for the `earn` + `staking`
 * programs against live devnet.
 *
 * The earn (HMBZu87F9zTt4JGbQwaL5V6tFXdLBUyLtgeYTsVh1Rzu) and staking
 * (3WFdgqHFUnqtZoKQLpj8pQPd3ecitBGG9M2eBmaup8JL) programs are deployed AND
 * initialized on devnet (see bootstrap-earn.ts + data/devnet-addresses.json
 * `.earn`). This script exercises the whole user lifecycle and asserts the
 * documented invariants at each step.
 *
 * Lifecycle (in order):
 *   0. Setup     — fresh ephemeral test-user keypair; fund SOL; mint test USDC
 *                  to the user (deployer = devnet-USDC mint authority); ensure
 *                  deployer has its own RWT (for deposit_rewards) and USDC (for
 *                  add_to_basket) by running mint_rwt for the deployer.
 *   1. mint_rwt        (user)     — deposit 100 USDC, receive earn-RWT @ NAV.
 *   2. stake           (user)     — stake 50 RWT, receive stRWT @ rate.
 *   3. deposit_rewards (deployer) — add 10 RWT to the pool, rate rises.
 *   4. add_to_basket   (deployer) — add 10 USDC to the basket, NAV rises.
 *   5. initiate_unstake(user)     — burn all stRWT (cooldown set to 0 first
 *                                   via staking.update_config by deployer).
 *   6. complete_unstake(user)     — claim the ticket; vault invariant holds.
 *   7. restore         (deployer) — cooldown back to 21 days.
 *
 * Safety: DEFAULTS TO DRY-RUN. With --dry-run (or no flag) the script derives
 * everything, prints the plan, and simulates each tx it can (read-only). It
 * only sends transactions and asserts on real post-state when --execute is
 * passed. Cross-tx-dependent steps cannot be fully simulated standalone in
 * dry-run (same caveat as bootstrap-earn.ts) and are reported as DEFERRED.
 *
 * Idempotency: a FRESH test-user keypair is generated each run (new wallet,
 * new ATAs, new unstake-ticket nonces), so re-running --execute is always safe.
 *
 * All on-chain amounts / NAV / rate use BigInt — no floating point anywhere.
 *
 * Usage (from repo root; deps resolve from bots/node_modules):
 *   NODE_PATH=bots/node_modules npx tsx scripts/lib/e2e-earn.ts --dry-run
 *   NODE_PATH=bots/node_modules npx tsx scripts/lib/e2e-earn.ts --execute
 */

import { readFileSync } from 'node:fs';
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
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

// --------------------------------------------------------------------------
// Paths & constants
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const ADDRESSES_PATH = join(REPO_ROOT, 'data', 'devnet-addresses.json');

const SYSTEM_PROGRAM_ID = SystemProgram.programId;

// On-chain seeds (contracts/<prog>/src/constants.rs).
const EARN_CONFIG_SEED = Buffer.from('earn_config');
const STAKING_CONFIG_SEED = Buffer.from('staking_config');
const UNSTAKE_SEED = Buffer.from('unstake');

// ===== earn pricing constants (contracts/earn/src/constants.rs) =====
const NAV_SCALE = 1_000_000n; // 6-dec fixed point (== INITIAL_NAV at supply 0)
const INITIAL_NAV = NAV_SCALE;
const BPS_DENOMINATOR = 10_000n;
const DEFAULT_MINT_FEE_BPS = 100n; // 1%

// ===== staking rate constants (contracts/staking/src/constants.rs) =====
const RATE_SCALE = 1_000_000n;
const VIRTUAL_SHARES = 1_000_000n; // 1 stRWT
const VIRTUAL_ASSETS = 10_000_000n; // 10 RWT → bootstrap rate 10
const COOLDOWN_SECONDS_PROD = 1_814_400n; // 21 days

// ===== Instruction discriminators (8-byte sha256, from SDK generated bindings)
// earn:
const MINT_RWT_DISCRIMINATOR = Buffer.from([0x62, 0x20, 0x73, 0xde, 0x44, 0x0c, 0xa1, 0xa2]);
const ADD_TO_BASKET_DISCRIMINATOR = Buffer.from([0x82, 0x9b, 0xd0, 0x92, 0xfe, 0x14, 0x87, 0x38]);
// staking:
const STAKE_DISCRIMINATOR = Buffer.from([0xce, 0xb0, 0xca, 0x12, 0xc8, 0xd1, 0xb3, 0x6c]);
const DEPOSIT_REWARDS_DISCRIMINATOR = Buffer.from([0x34, 0xf9, 0x70, 0x48, 0xce, 0xa1, 0xc4, 0x01]);
const INITIATE_UNSTAKE_DISCRIMINATOR = Buffer.from([0xe5, 0x4f, 0x13, 0x9f, 0xe8, 0xce, 0x60, 0xd2]);
const COMPLETE_UNSTAKE_DISCRIMINATOR = Buffer.from([0x4f, 0x62, 0x28, 0xf1, 0x64, 0x1e, 0x19, 0xea]);
const STAKING_UPDATE_CONFIG_DISCRIMINATOR = Buffer.from([0x1d, 0x9e, 0xfc, 0xbf, 0x0a, 0x53, 0xdb, 0x63]);

// ===== Account decode offsets (8-byte discriminator + repr(C,packed)) =====
// EarnConfig (contracts/earn/src/state.rs):
//   8   total_invested_capital u128 (16)
//   122 mint_fee_bps           u16  (2)
//   156 dao_fee_destination    [u8;32]
//   252 min_mint_amount        u64  (8)
const EARN_TOTAL_CAPITAL_OFFSET = 8;
// StakingConfig (contracts/staking/src/state.rs):
//   170 reward_depositor   [u8;32]
//   234 total_rwt_active   u64 (8)
//   242 total_rwt_reserved u64 (8)
//   250 cooldown_seconds   i64 (8)
//   258 min_stake_amount   u64 (8)
const STK_REWARD_DEPOSITOR_OFFSET = 170;
const STK_TOTAL_ACTIVE_OFFSET = 234;
const STK_TOTAL_RESERVED_OFFSET = 242;
const STK_COOLDOWN_OFFSET = 250;
const STK_MIN_STAKE_OFFSET = 258;

// SPL token-account / mint layout offsets.
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64; // u64
const MINT_SUPPLY_OFFSET = 36; // u64

// ===== Test parameters =====
const FUND_SOL_LAMPORTS = 100_000_000n; // 0.1 SOL to the test-user
const USER_USDC_FAUCET = 1_000_000_000n; // 1000 USDC to the user
const DEPLOYER_USDC_FAUCET = 1_000_000_000n; // 1000 USDC to the deployer (for mint + basket)
const USER_DEPOSIT_USDC = 100_000_000n; // step 1: 100 USDC
const DEPLOYER_DEPOSIT_USDC = 200_000_000n; // setup: 200 USDC → ~200 RWT for deployer
const STAKE_RWT = 50_000_000n; // step 2: 50 RWT
const DEPOSIT_REWARDS_RWT = 10_000_000n; // step 3: 10 RWT
const ADD_TO_BASKET_USDC = 10_000_000n; // step 4: 10 USDC

// --------------------------------------------------------------------------
// Logging + assertion harness
// --------------------------------------------------------------------------

let stepNum = -1; // first logStep() call (SETUP) becomes STEP 0
const results: { step: string; pass: boolean; detail: string }[] = [];

function banner(title: string): void {
  console.log(`\n================ ${title} ================`);
}

function logStep(name: string): void {
  stepNum += 1;
  console.log(`\n--- STEP ${stepNum}: ${name} ---`);
}

function logInfo(msg: string, extra?: Record<string, unknown>): void {
  if (extra) console.log(`  ${msg}`, JSON.stringify(stringifyBigInts(extra)));
  else console.log(`  ${msg}`);
}

/** Record an assertion. Logs PASS/FAIL with actual vs expected. */
function assert(label: string, pass: boolean, actual: unknown, expected: unknown): void {
  const a = stringifyBigInts(actual);
  const e = stringifyBigInts(expected);
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${label}`);
  if (!pass) {
    console.log(`         actual:   ${JSON.stringify(a)}`);
    console.log(`         expected: ${JSON.stringify(e)}`);
  }
  results.push({ step: `S${stepNum}`, pass, detail: label });
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
// Pure on-chain math mirrors (BigInt)
// --------------------------------------------------------------------------

/** earn NAV: supply 0 → INITIAL_NAV; else capital × NAV_SCALE / supply, min 1. */
function calcNav(capital: bigint, supply: bigint): bigint {
  if (supply === 0n) return INITIAL_NAV;
  const nav = (capital * NAV_SCALE) / supply;
  return nav > 0n ? nav : 1n;
}

/** mint_rwt RWT out: (usdc_amount × NAV_SCALE) / nav (u128 mul, floor). */
function calcRwtOut(usdcAmount: bigint, nav: bigint): bigint {
  return (usdcAmount * NAV_SCALE) / nav;
}

/** mint_rwt fee: usdc_amount × fee_bps / 10_000 (floor). */
function calcMintFee(usdcAmount: bigint, feeBps: bigint): bigint {
  return (usdcAmount * feeBps) / BPS_DENOMINATOR;
}

/** stake stRWT out: rwt_in × (supply + V_SHARES) / (active + V_ASSETS) [floor]. */
function calcStrwtOut(rwtIn: bigint, strwtSupply: bigint, active: bigint): bigint {
  return (rwtIn * (strwtSupply + VIRTUAL_SHARES)) / (active + VIRTUAL_ASSETS);
}

/** unstake RWT out: strwt × (active + V_ASSETS) / (supply + V_SHARES) [floor]. */
function calcRwtOutForUnstake(strwtAmount: bigint, strwtSupply: bigint, active: bigint): bigint {
  return (strwtAmount * (active + VIRTUAL_ASSETS)) / (strwtSupply + VIRTUAL_SHARES);
}

/** rate snapshot: (active + V_ASSETS) × RATE_SCALE / (supply + V_SHARES). */
function calcRate(active: bigint, strwtSupply: bigint): bigint {
  return ((active + VIRTUAL_ASSETS) * RATE_SCALE) / (strwtSupply + VIRTUAL_SHARES);
}

// --------------------------------------------------------------------------
// Addresses / keypairs
// --------------------------------------------------------------------------

interface EarnSection {
  earn_rwt_mint: string;
  strwt_mint: string;
  basket_vault: string;
  dao_fee_destination: string;
  pool_vault: string;
  earn_config_pda: string;
  staking_config_pda: string;
}

interface DevnetAddresses {
  cluster: string;
  rpc: { http: string };
  deployer: { keypair_path: string; pubkey: string };
  programs: Record<string, { pubkey: string }>;
  mints: { usdc: string; [k: string]: string | undefined };
  earn?: EarnSection;
}

function loadAddresses(): DevnetAddresses {
  return JSON.parse(readFileSync(ADDRESSES_PATH, 'utf8')) as DevnetAddresses;
}

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(readFileSync(p, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({
  pubkey,
  isSigner,
  isWritable,
});

function findAta(owner: PublicKey, mint: PublicKey, allowOwnerOffCurve = false): PublicKey {
  return getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

// --------------------------------------------------------------------------
// On-chain reads
// --------------------------------------------------------------------------

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

interface EarnState {
  totalInvestedCapital: bigint;
}

async function readEarnConfig(conn: Connection, pda: PublicKey): Promise<EarnState> {
  const info = await conn.getAccountInfo(pda, 'confirmed');
  if (!info) throw new Error(`EarnConfig PDA ${pda.toBase58()} not found`);
  return {
    // u128 little-endian: low 64 + (high 64 << 64).
    totalInvestedCapital:
      info.data.readBigUInt64LE(EARN_TOTAL_CAPITAL_OFFSET) +
      (info.data.readBigUInt64LE(EARN_TOTAL_CAPITAL_OFFSET + 8) << 64n),
  };
}

interface StakingState {
  rewardDepositor: PublicKey;
  totalRwtActive: bigint;
  totalRwtReserved: bigint;
  cooldownSeconds: bigint;
  minStakeAmount: bigint;
}

async function readStakingConfig(conn: Connection, pda: PublicKey): Promise<StakingState> {
  const info = await conn.getAccountInfo(pda, 'confirmed');
  if (!info) throw new Error(`StakingConfig PDA ${pda.toBase58()} not found`);
  return {
    rewardDepositor: new PublicKey(info.data.subarray(STK_REWARD_DEPOSITOR_OFFSET, STK_REWARD_DEPOSITOR_OFFSET + 32)),
    totalRwtActive: info.data.readBigUInt64LE(STK_TOTAL_ACTIVE_OFFSET),
    totalRwtReserved: info.data.readBigUInt64LE(STK_TOTAL_RESERVED_OFFSET),
    cooldownSeconds: info.data.readBigInt64LE(STK_COOLDOWN_OFFSET),
    minStakeAmount: info.data.readBigUInt64LE(STK_MIN_STAKE_OFFSET),
  };
}

async function accountExists(conn: Connection, addr: PublicKey): Promise<boolean> {
  return (await conn.getAccountInfo(addr, 'confirmed')) !== null;
}

// --------------------------------------------------------------------------
// Instruction encoders (BigInt args → LE buffers)
// --------------------------------------------------------------------------

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
function i64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v);
  return b;
}

function encMintRwt(usdcAmount: bigint, minRwtOut: bigint): Buffer {
  return Buffer.concat([MINT_RWT_DISCRIMINATOR, u64le(usdcAmount), u64le(minRwtOut)]);
}
function encStake(rwtAmount: bigint, minStrwtOut: bigint): Buffer {
  return Buffer.concat([STAKE_DISCRIMINATOR, u64le(rwtAmount), u64le(minStrwtOut)]);
}
function encDepositRewards(rwtAmount: bigint): Buffer {
  return Buffer.concat([DEPOSIT_REWARDS_DISCRIMINATOR, u64le(rwtAmount)]);
}
function encAddToBasket(amount: bigint): Buffer {
  return Buffer.concat([ADD_TO_BASKET_DISCRIMINATOR, u64le(amount)]);
}
function encInitiateUnstake(strwtAmount: bigint, nonce: bigint): Buffer {
  return Buffer.concat([INITIATE_UNSTAKE_DISCRIMINATOR, u64le(strwtAmount), u64le(nonce)]);
}
function encCompleteUnstake(nonce: bigint): Buffer {
  return Buffer.concat([COMPLETE_UNSTAKE_DISCRIMINATOR, u64le(nonce)]);
}
function encStakingUpdateConfig(
  rewardDepositor: PublicKey,
  minStakeAmount: bigint,
  cooldownSeconds: bigint,
): Buffer {
  return Buffer.concat([
    STAKING_UPDATE_CONFIG_DISCRIMINATOR,
    Buffer.from(rewardDepositor.toBytes()),
    u64le(minStakeAmount),
    i64le(cooldownSeconds),
  ]);
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
): Promise<void> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);

  if (!execute) {
    const sim = await conn.simulateTransaction(tx);
    const err = sim.value.err;
    logInfo(`simulate ${label}: ${err ? 'ERR' : 'OK'}`, {
      err: err ?? null,
      unitsConsumed: sim.value.unitsConsumed ?? null,
    });
    if (err && sim.value.logs) {
      for (const l of sim.value.logs) console.log(`      | ${l}`);
    }
    if (err) throw new Error(`simulation failed for ${label}: ${JSON.stringify(err)}`);
    return;
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
      logInfo(`sent ${label} OK`, { sig });
      console.log(`      explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      return;
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

  const art = loadAddresses();
  if (art.cluster !== 'devnet' || !art.rpc.http.includes('devnet')) {
    throw new Error(`refusing to run on non-devnet target (cluster=${art.cluster})`);
  }
  if (!art.earn) {
    throw new Error('data/devnet-addresses.json has no .earn section — run bootstrap-earn first');
  }

  const conn = new Connection(art.rpc.http, 'confirmed');
  const deployer = loadKeypair(join(REPO_ROOT, art.deployer.keypair_path));
  if (deployer.publicKey.toBase58() !== art.deployer.pubkey) {
    throw new Error(`deployer keypair != addresses.json (${deployer.publicKey.toBase58()})`);
  }

  const earnProgramId = new PublicKey(art.programs.earn!.pubkey);
  const stakingProgramId = new PublicKey(art.programs.staking!.pubkey);
  const usdcMint = new PublicKey(art.mints.usdc);

  const earnRwtMint = new PublicKey(art.earn.earn_rwt_mint);
  const strwtMint = new PublicKey(art.earn.strwt_mint);
  const basketVault = new PublicKey(art.earn.basket_vault);
  const daoFeeDestination = new PublicKey(art.earn.dao_fee_destination);
  const poolVault = new PublicKey(art.earn.pool_vault);
  const earnConfigPda = new PublicKey(art.earn.earn_config_pda);
  const stakingConfigPda = new PublicKey(art.earn.staking_config_pda);

  // Fresh ephemeral test-user.
  const user = Keypair.generate();

  // User ATAs.
  const userUsdc = findAta(user.publicKey, usdcMint);
  const userRwt = findAta(user.publicKey, earnRwtMint);
  const userStrwt = findAta(user.publicKey, strwtMint);

  // Deployer ATAs (deployer obtains RWT via its own mint_rwt for deposit_rewards;
  // and USDC for add_to_basket / its own mint).
  const deployerUsdc = findAta(deployer.publicKey, usdcMint);
  const deployerRwt = findAta(deployer.publicKey, earnRwtMint);

  banner('e2e-earn PLAN');
  console.log(`mode:                 ${execute ? 'EXECUTE (will send + assert)' : 'DRY-RUN (simulate only)'}`);
  console.log(`rpc:                  ${art.rpc.http}`);
  console.log(`deployer:             ${deployer.publicKey.toBase58()}`);
  console.log(`test-user (fresh):    ${user.publicKey.toBase58()}`);
  console.log(`  secretKey (b64):    ${Buffer.from(user.secretKey).toString('base64')}`);
  console.log('--- programs / mints ---');
  console.log(`earn program:         ${earnProgramId.toBase58()}`);
  console.log(`staking program:      ${stakingProgramId.toBase58()}`);
  console.log(`usdc mint:            ${usdcMint.toBase58()}`);
  console.log(`earn-RWT mint:        ${earnRwtMint.toBase58()}`);
  console.log(`stRWT mint:           ${strwtMint.toBase58()}`);
  console.log('--- pdas / vaults ---');
  console.log(`earn_config PDA:      ${earnConfigPda.toBase58()}`);
  console.log(`staking_config PDA:   ${stakingConfigPda.toBase58()}`);
  console.log(`basket_vault:         ${basketVault.toBase58()}`);
  console.log(`dao_fee_destination:  ${daoFeeDestination.toBase58()}`);
  console.log(`pool_vault:           ${poolVault.toBase58()}`);
  console.log('--- user ATAs ---');
  console.log(`user USDC:            ${userUsdc.toBase58()}`);
  console.log(`user RWT:             ${userRwt.toBase58()}`);
  console.log(`user stRWT:           ${userStrwt.toBase58()}`);
  console.log('=====================================================');

  if (!execute) {
    console.log(
      '\n[e2e-earn] DRY-RUN NOTE: simulateTransaction runs each tx independently\n' +
        'against committed on-chain state. Steps that depend on a prior un-sent tx\n' +
        '(e.g. the user has not actually been funded with USDC/RWT yet) cannot be\n' +
        'simulated standalone and are reported as DEFERRED. The real assertions run\n' +
        'only under --execute against post-tx state. Same caveat as bootstrap-earn.ts.',
    );
  }

  // ========================================================================
  // STEP 0: Setup — fund SOL, mint USDC to user + deployer, create ATAs,
  //         give the deployer RWT (via its own mint_rwt) for deposit_rewards.
  // ========================================================================
  logStep('SETUP — fund test-user, mint USDC, seed deployer RWT');

  // Snapshot starting NAV / rate (before anything).
  const earn0 = await readEarnConfig(conn, earnConfigPda).catch(() => null);
  const rwtSupply0 = await readMintSupply(conn, earnRwtMint).catch(() => 0n);
  const stk0 = await readStakingConfig(conn, stakingConfigPda).catch(() => null);
  const strwtSupply0 = await readMintSupply(conn, strwtMint).catch(() => 0n);
  const nav0 = earn0 ? calcNav(earn0.totalInvestedCapital, rwtSupply0) : INITIAL_NAV;
  const rate0 = stk0 ? calcRate(stk0.totalRwtActive, strwtSupply0) : calcRate(0n, 0n);
  logInfo('snapshot NAV (current)', { nav: nav0, navUsd: `$${Number(nav0) / 1e6}`, rwtSupply: rwtSupply0 });
  logInfo('snapshot rate (current)', { rate: rate0, rateX: `${Number(rate0) / 1e6}`, strwtSupply: strwtSupply0 });
  if (stk0) {
    logInfo('staking config (current)', {
      totalRwtActive: stk0.totalRwtActive,
      totalRwtReserved: stk0.totalRwtReserved,
      cooldownSeconds: stk0.cooldownSeconds,
      minStakeAmount: stk0.minStakeAmount,
      rewardDepositor: stk0.rewardDepositor.toBase58(),
    });
    // The deployer MUST be the configured reward_depositor for deposit_rewards.
    assert(
      'deployer is the configured reward_depositor',
      stk0.rewardDepositor.equals(deployer.publicKey),
      stk0.rewardDepositor.toBase58(),
      deployer.publicKey.toBase58(),
    );
  }

  // 0a: fund the user with SOL (for fees + ATA rents).
  {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: user.publicKey,
        lamports: Number(FUND_SOL_LAMPORTS),
      }),
    );
    await simulateOrSend(conn, tx, [deployer], execute, 'fund user SOL');
  }

  // 0b: create all ATAs idempotently (user USDC/RWT/stRWT + deployer USDC/RWT)
  //     and mint USDC to user + deployer (deployer = devnet USDC mint authority).
  {
    const ixs: TransactionInstruction[] = [
      createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey, userUsdc, user.publicKey, usdcMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey, userRwt, user.publicKey, earnRwtMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey, userStrwt, user.publicKey, strwtMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey, deployerUsdc, deployer.publicKey, usdcMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey, deployerRwt, deployer.publicKey, earnRwtMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      // Mint test USDC: deployer = USDC mint authority on devnet.
      createMintToInstruction(usdcMint, userUsdc, deployer.publicKey, USER_USDC_FAUCET, [], TOKEN_PROGRAM_ID),
      createMintToInstruction(usdcMint, deployerUsdc, deployer.publicKey, DEPLOYER_USDC_FAUCET, [], TOKEN_PROGRAM_ID),
    ];
    const tx = new Transaction().add(...ixs);
    await simulateOrSend(conn, tx, [deployer], execute, 'create ATAs + mint USDC');
  }

  // 0c: deployer obtains RWT for deposit_rewards by running its own mint_rwt.
  //     (deployer signs; deposits DEPLOYER_DEPOSIT_USDC → receives ~RWT @ NAV.)
  {
    const navNow = execute ? calcNav((await readEarnConfig(conn, earnConfigPda)).totalInvestedCapital, await readMintSupply(conn, earnRwtMint)) : nav0;
    const expectRwt = calcRwtOut(DEPLOYER_DEPOSIT_USDC, navNow);
    logInfo('deployer mint_rwt (seed RWT for deposit_rewards)', {
      usdcIn: DEPLOYER_DEPOSIT_USDC, navUsed: navNow, expectedRwtOut: expectRwt,
    });
    const keys: AccountMeta[] = [
      meta(deployer.publicKey, true, false), // user (signer)
      meta(earnConfigPda, false, true),
      meta(earnRwtMint, false, true),
      meta(deployerUsdc, false, true),
      meta(deployerRwt, false, true),
      meta(basketVault, false, true),
      meta(daoFeeDestination, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ];
    // min_rwt_out must be > 0 (handler rejects ZeroSlippage); use 1.
    const ix = new TransactionInstruction({ programId: earnProgramId, keys, data: encMintRwt(DEPLOYER_DEPOSIT_USDC, 1n) });
    const tx = new Transaction().add(ix);
    if (!execute && !(await accountExists(conn, deployerRwt))) {
      logInfo('DEFERRED — deployer RWT ATA created by prior un-sent tx; would simulate after --execute');
    } else {
      await simulateOrSend(conn, tx, [deployer], execute, 'deployer mint_rwt (seed RWT)');
    }
  }

  // ========================================================================
  // STEP 1: mint_rwt (user) — deposit 100 USDC, receive earn-RWT @ NAV (+1% fee)
  // Account order (contracts/earn/src/instructions/mint_rwt.rs):
  //   0 user                signer
  //   1 earn_config         mut
  //   2 rwt_mint            mut
  //   3 user_usdc           mut
  //   4 user_rwt            mut
  //   5 basket_vault        mut
  //   6 dao_fee_destination mut
  //   7 token_program
  // ========================================================================
  logStep('mint_rwt (user deposits 100 USDC)');
  {
    const earnBefore = await readEarnConfig(conn, earnConfigPda).catch(() => earn0!);
    const supplyBefore = await readMintSupply(conn, earnRwtMint).catch(() => rwtSupply0);
    const navBefore = calcNav(earnBefore?.totalInvestedCapital ?? 0n, supplyBefore);
    const expectRwt = calcRwtOut(USER_DEPOSIT_USDC, navBefore);
    const expectFee = calcMintFee(USER_DEPOSIT_USDC, DEFAULT_MINT_FEE_BPS);

    const userRwtBefore = await readTokenAmount(conn, userRwt);
    const basketBefore = await readTokenAmount(conn, basketVault);
    const daoBefore = await readTokenAmount(conn, daoFeeDestination);

    logInfo('plan', {
      usdcIn: USER_DEPOSIT_USDC, navBefore, navUsd: `$${Number(navBefore) / 1e6}`,
      expectedRwtOut: expectRwt, expectedFee: expectFee,
    });

    const keys: AccountMeta[] = [
      meta(user.publicKey, true, false),
      meta(earnConfigPda, false, true),
      meta(earnRwtMint, false, true),
      meta(userUsdc, false, true),
      meta(userRwt, false, true),
      meta(basketVault, false, true),
      meta(daoFeeDestination, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ];
    const ix = new TransactionInstruction({ programId: earnProgramId, keys, data: encMintRwt(USER_DEPOSIT_USDC, 1n) });
    const tx = new Transaction().add(ix);

    if (!execute) {
      logInfo('DEFERRED — depends on user being funded with USDC by a prior un-sent tx');
    } else {
      await simulateOrSend(conn, tx, [user], execute, 'mint_rwt');
      const userRwtAfter = await readTokenAmount(conn, userRwt);
      const basketAfter = await readTokenAmount(conn, basketVault);
      const daoAfter = await readTokenAmount(conn, daoFeeDestination);
      const earnAfter = await readEarnConfig(conn, earnConfigPda);
      const supplyAfter = await readMintSupply(conn, earnRwtMint);
      const navAfter = calcNav(earnAfter.totalInvestedCapital, supplyAfter);

      assert('user earn-RWT increased by expected rwt_out', userRwtAfter - userRwtBefore === expectRwt, userRwtAfter - userRwtBefore, expectRwt);
      assert('basket_vault USDC increased by 100e6 (body)', basketAfter - basketBefore === USER_DEPOSIT_USDC, basketAfter - basketBefore, USER_DEPOSIT_USDC);
      assert('dao_fee_destination USDC increased by 1% fee', daoAfter - daoBefore === expectFee, daoAfter - daoBefore, expectFee);
      assert('NAV unchanged after mint (mint invariant, ±1)', absDiff(navAfter, navBefore) <= 1n, navAfter, navBefore);
    }
  }

  // ========================================================================
  // STEP 2: stake (user) — stake 50 RWT, receive stRWT @ rate
  // Account order (contracts/staking/src/instructions/stake.rs):
  //   0 user            signer
  //   1 staking_config  mut
  //   2 strwt_mint      mut
  //   3 user_rwt_ata    mut
  //   4 user_strwt_ata  mut
  //   5 pool_vault      mut
  //   6 token_program
  // ========================================================================
  logStep('stake (user stakes 50 RWT)');
  {
    const stkBefore = await readStakingConfig(conn, stakingConfigPda).catch(() => stk0!);
    const strwtSupplyBefore = await readMintSupply(conn, strwtMint).catch(() => strwtSupply0);
    const expectStrwt = calcStrwtOut(STAKE_RWT, strwtSupplyBefore, stkBefore?.totalRwtActive ?? 0n);
    const userStrwtBefore = await readTokenAmount(conn, userStrwt);

    logInfo('plan', { rwtIn: STAKE_RWT, expectedStrwtOut: expectStrwt, activeBefore: stkBefore?.totalRwtActive ?? 0n });

    const keys: AccountMeta[] = [
      meta(user.publicKey, true, false),
      meta(stakingConfigPda, false, true),
      meta(strwtMint, false, true),
      meta(userRwt, false, true),
      meta(userStrwt, false, true),
      meta(poolVault, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ];
    const ix = new TransactionInstruction({ programId: stakingProgramId, keys, data: encStake(STAKE_RWT, 1n) });
    const tx = new Transaction().add(ix);

    if (!execute) {
      logInfo('DEFERRED — depends on user holding RWT (from step 1, un-sent)');
    } else {
      await simulateOrSend(conn, tx, [user], execute, 'stake');
      const userStrwtAfter = await readTokenAmount(conn, userStrwt);
      const stkAfter = await readStakingConfig(conn, stakingConfigPda);
      assert('user stRWT increased by expected strwt_out', userStrwtAfter - userStrwtBefore === expectStrwt, userStrwtAfter - userStrwtBefore, expectStrwt);
      assert('total_rwt_active increased by 50e6', stkAfter.totalRwtActive - (stkBefore?.totalRwtActive ?? 0n) === STAKE_RWT, stkAfter.totalRwtActive - (stkBefore?.totalRwtActive ?? 0n), STAKE_RWT);
    }
  }

  // ========================================================================
  // STEP 3: deposit_rewards (deployer = reward_depositor) — add 10 RWT, rate ↑
  // Account order (contracts/staking/src/instructions/deposit_rewards.rs):
  //   0 depositor          signer
  //   1 staking_config     mut
  //   2 strwt_mint         (read-only)
  //   3 depositor_rwt_ata  mut
  //   4 pool_vault         mut
  //   5 token_program
  // ========================================================================
  logStep('deposit_rewards (deployer adds 10 RWT)');
  {
    const stkBefore = await readStakingConfig(conn, stakingConfigPda).catch(() => stk0!);
    const strwtSupply = await readMintSupply(conn, strwtMint).catch(() => strwtSupply0);
    const rateBefore = calcRate(stkBefore?.totalRwtActive ?? 0n, strwtSupply);
    const rateAfterExpected = calcRate((stkBefore?.totalRwtActive ?? 0n) + DEPOSIT_REWARDS_RWT, strwtSupply);

    logInfo('plan', { rwtIn: DEPOSIT_REWARDS_RWT, rateBefore, rateAfterExpected, strwtSupply });

    const keys: AccountMeta[] = [
      meta(deployer.publicKey, true, false),
      meta(stakingConfigPda, false, true),
      meta(strwtMint, false, false),
      meta(deployerRwt, false, true),
      meta(poolVault, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ];
    const ix = new TransactionInstruction({ programId: stakingProgramId, keys, data: encDepositRewards(DEPOSIT_REWARDS_RWT) });
    const tx = new Transaction().add(ix);

    if (!execute) {
      logInfo('DEFERRED — depends on deployer holding RWT (from setup mint_rwt, un-sent)');
    } else {
      await simulateOrSend(conn, tx, [deployer], execute, 'deposit_rewards');
      const stkAfter = await readStakingConfig(conn, stakingConfigPda);
      const strwtSupplyAfter = await readMintSupply(conn, strwtMint);
      const rateAfter = calcRate(stkAfter.totalRwtActive, strwtSupplyAfter);
      assert('rate increased (active grew, stRWT supply unchanged)', rateAfter > rateBefore, rateAfter, `> ${rateBefore}`);
      assert('stRWT supply unchanged across deposit_rewards', strwtSupplyAfter === strwtSupply, strwtSupplyAfter, strwtSupply);
      assert('total_rwt_active increased by 10e6', stkAfter.totalRwtActive - (stkBefore?.totalRwtActive ?? 0n) === DEPOSIT_REWARDS_RWT, stkAfter.totalRwtActive - (stkBefore?.totalRwtActive ?? 0n), DEPOSIT_REWARDS_RWT);
    }
  }

  // ========================================================================
  // STEP 4: add_to_basket (deployer = authority) — add 10 USDC, NAV ↑
  // Account order (contracts/earn/src/instructions/add_to_basket.rs):
  //   0 authority        signer
  //   1 earn_config      mut (has_one authority)
  //   2 rwt_mint         (read-only)
  //   3 authority_source mut (deployer USDC)
  //   4 basket_vault     mut
  //   5 token_program
  // ========================================================================
  logStep('add_to_basket (deployer adds 10 USDC)');
  {
    const earnBefore = await readEarnConfig(conn, earnConfigPda).catch(() => earn0!);
    const supply = await readMintSupply(conn, earnRwtMint).catch(() => rwtSupply0);
    const navBefore = calcNav(earnBefore?.totalInvestedCapital ?? 0n, supply);
    const navAfterExpected = calcNav((earnBefore?.totalInvestedCapital ?? 0n) + ADD_TO_BASKET_USDC, supply);
    const userRwtBalance = await readTokenAmount(conn, userRwt);

    logInfo('plan', { usdcIn: ADD_TO_BASKET_USDC, navBefore, navAfterExpected, userRwtBalance });

    const keys: AccountMeta[] = [
      meta(deployer.publicKey, true, false),
      meta(earnConfigPda, false, true),
      meta(earnRwtMint, false, false),
      meta(deployerUsdc, false, true),
      meta(basketVault, false, true),
      meta(TOKEN_PROGRAM_ID, false, false),
    ];
    const ix = new TransactionInstruction({ programId: earnProgramId, keys, data: encAddToBasket(ADD_TO_BASKET_USDC) });
    const tx = new Transaction().add(ix);

    if (!execute && !(await accountExists(conn, deployerUsdc))) {
      logInfo('DEFERRED — depends on deployer USDC ATA from setup (un-sent)');
    } else {
      await simulateOrSend(conn, tx, [deployer], execute, 'add_to_basket');
      if (execute) {
        const earnAfter = await readEarnConfig(conn, earnConfigPda);
        const supplyAfter = await readMintSupply(conn, earnRwtMint);
        const navAfter = calcNav(earnAfter.totalInvestedCapital, supplyAfter);
        assert('NAV increased after add_to_basket (capital grew, supply same)', navAfter > navBefore, navAfter, `> ${navBefore}`);
        assert('earn-RWT supply unchanged across add_to_basket', supplyAfter === supply, supplyAfter, supply);
        // user's RWT worth more USD now.
        const valBefore = userRwtBalance * navBefore;
        const valAfter = userRwtBalance * navAfter;
        assert("user's RWT is worth more USD (rwt × NAV grew)", valAfter > valBefore, valAfter, `> ${valBefore}`);
      }
    }
  }

  // ========================================================================
  // STEP 5: initiate_unstake (user) — burn all stRWT, set cooldown 0 first.
  //
  // 5a (deployer): staking.update_config(reward_depositor, min_stake_amount,
  //                cooldown_seconds=0) — keep depositor + min_stake at current
  //                values so only cooldown changes.
  // Account order (contracts/staking/src/instructions/update_config.rs):
  //   0 authority      signer
  //   1 staking_config mut
  //
  // 5b (user): initiate_unstake(strwt_amount, nonce)
  // Account order (contracts/staking/src/instructions/initiate_unstake.rs):
  //   0 user           mut, signer
  //   1 staking_config mut
  //   2 strwt_mint     mut
  //   3 user_strwt_ata mut
  //   4 ticket         mut (PDA ["unstake", user, nonce_le])
  //   5 token_program
  //   6 system_program
  // ========================================================================
  logStep('initiate_unstake (set cooldown=0, then unstake all stRWT)');
  const nonce = BigInt(Date.now()); // client-supplied; unique per run
  const nonceLe = Buffer.alloc(8);
  nonceLe.writeBigUInt64LE(nonce);
  const [ticketPda] = PublicKey.findProgramAddressSync(
    [UNSTAKE_SEED, user.publicKey.toBuffer(), nonceLe],
    stakingProgramId,
  );
  logInfo('derived unstake ticket', { nonce, ticketPda: ticketPda.toBase58() });
  {
    // 5a: cooldown -> 0 (preserve depositor + min_stake_amount).
    const stkCur = await readStakingConfig(conn, stakingConfigPda).catch(() => stk0!);
    const keepDepositor = stkCur?.rewardDepositor ?? deployer.publicKey;
    const keepMinStake = stkCur?.minStakeAmount ?? 1_000_000n;
    logInfo('update_config -> cooldown=0', {
      rewardDepositor: keepDepositor.toBase58(), minStakeAmount: keepMinStake, cooldownSeconds: 0n,
    });
    const ucKeys: AccountMeta[] = [
      meta(deployer.publicKey, true, false),
      meta(stakingConfigPda, false, true),
    ];
    const ucIx = new TransactionInstruction({
      programId: stakingProgramId,
      keys: ucKeys,
      data: encStakingUpdateConfig(keepDepositor, keepMinStake, 0n),
    });
    await simulateOrSend(conn, new Transaction().add(ucIx), [deployer], execute, 'staking.update_config (cooldown=0)');

    // 5b: initiate_unstake all stRWT.
    if (!execute) {
      logInfo('DEFERRED — initiate_unstake depends on user holding stRWT (step 2, un-sent)');
    } else {
      const userStrwtBal = await readTokenAmount(conn, userStrwt);
      const strwtSupply = await readMintSupply(conn, strwtMint);
      const stkBefore = await readStakingConfig(conn, stakingConfigPda);
      const expectRwtOut = calcRwtOutForUnstake(userStrwtBal, strwtSupply, stkBefore.totalRwtActive);
      logInfo('plan', { strwtBurn: userStrwtBal, expectedRwtOut: expectRwtOut, activeBefore: stkBefore.totalRwtActive, reservedBefore: stkBefore.totalRwtReserved });

      const keys: AccountMeta[] = [
        meta(user.publicKey, true, true),
        meta(stakingConfigPda, false, true),
        meta(strwtMint, false, true),
        meta(userStrwt, false, true),
        meta(ticketPda, false, true),
        meta(TOKEN_PROGRAM_ID, false, false),
        meta(SYSTEM_PROGRAM_ID, false, false),
      ];
      const ix = new TransactionInstruction({ programId: stakingProgramId, keys, data: encInitiateUnstake(userStrwtBal, nonce) });
      await simulateOrSend(conn, new Transaction().add(ix), [user], execute, 'initiate_unstake');

      const userStrwtAfter = await readTokenAmount(conn, userStrwt);
      const stkAfter = await readStakingConfig(conn, stakingConfigPda);
      const ticketAmount = await readTicketAmount(conn, ticketPda);
      assert('stRWT burned (user balance -> 0)', userStrwtAfter === 0n, userStrwtAfter, 0n);
      assert('ticket.amount_rwt == expected rwt_out', ticketAmount === expectRwtOut, ticketAmount, expectRwtOut);
      assert('total_rwt_active decreased by rwt_out', stkBefore.totalRwtActive - stkAfter.totalRwtActive === expectRwtOut, stkBefore.totalRwtActive - stkAfter.totalRwtActive, expectRwtOut);
      assert('total_rwt_reserved increased by rwt_out', stkAfter.totalRwtReserved - stkBefore.totalRwtReserved === expectRwtOut, stkAfter.totalRwtReserved - stkBefore.totalRwtReserved, expectRwtOut);
      assert('active+reserved conserved across initiate_unstake', stkAfter.totalRwtActive + stkAfter.totalRwtReserved === stkBefore.totalRwtActive + stkBefore.totalRwtReserved, stkAfter.totalRwtActive + stkAfter.totalRwtReserved, stkBefore.totalRwtActive + stkBefore.totalRwtReserved);
    }
  }

  // ========================================================================
  // STEP 6: complete_unstake (user) — claim the ticket
  // Account order (contracts/staking/src/instructions/complete_unstake.rs):
  //   0 user           mut, signer
  //   1 staking_config mut
  //   2 ticket         mut (closed; rent -> user)
  //   3 pool_vault     mut
  //   4 user_rwt_ata   mut
  //   5 token_program
  // ========================================================================
  logStep('complete_unstake (user claims the ticket)');
  {
    if (!execute) {
      logInfo('DEFERRED — depends on ticket from step 5 (un-sent)');
    } else {
      const userRwtBefore = await readTokenAmount(conn, userRwt);
      const stkBefore = await readStakingConfig(conn, stakingConfigPda);
      const ticketAmount = await readTicketAmount(conn, ticketPda);
      logInfo('plan', { ticketAmount, reservedBefore: stkBefore.totalRwtReserved });

      const keys: AccountMeta[] = [
        meta(user.publicKey, true, true),
        meta(stakingConfigPda, false, true),
        meta(ticketPda, false, true),
        meta(poolVault, false, true),
        meta(userRwt, false, true),
        meta(TOKEN_PROGRAM_ID, false, false),
      ];
      const ix = new TransactionInstruction({ programId: stakingProgramId, keys, data: encCompleteUnstake(nonce) });
      await simulateOrSend(conn, new Transaction().add(ix), [user], execute, 'complete_unstake');

      const userRwtAfter = await readTokenAmount(conn, userRwt);
      const stkAfter = await readStakingConfig(conn, stakingConfigPda);
      const ticketStillThere = await accountExists(conn, ticketPda);
      const poolVaultBal = await readTokenAmount(conn, poolVault);

      assert('user RWT increased by ticket.amount_rwt', userRwtAfter - userRwtBefore === ticketAmount, userRwtAfter - userRwtBefore, ticketAmount);
      assert('total_rwt_reserved decreased by ticket.amount_rwt', stkBefore.totalRwtReserved - stkAfter.totalRwtReserved === ticketAmount, stkBefore.totalRwtReserved - stkAfter.totalRwtReserved, ticketAmount);
      assert('ticket account closed (rent returned)', !ticketStillThere, ticketStillThere, false);
      assert('INVARIANT: pool_vault.balance == active + reserved', poolVaultBal === stkAfter.totalRwtActive + stkAfter.totalRwtReserved, poolVaultBal, stkAfter.totalRwtActive + stkAfter.totalRwtReserved);
    }
  }

  // ========================================================================
  // STEP 7: restore — cooldown back to 21 days (production-like).
  // ========================================================================
  logStep('restore — cooldown back to 21 days');
  {
    const stkCur = await readStakingConfig(conn, stakingConfigPda).catch(() => stk0!);
    const keepDepositor = stkCur?.rewardDepositor ?? deployer.publicKey;
    const keepMinStake = stkCur?.minStakeAmount ?? 1_000_000n;
    logInfo('update_config -> cooldown=1_814_400 (21d)', {
      rewardDepositor: keepDepositor.toBase58(), minStakeAmount: keepMinStake, cooldownSeconds: COOLDOWN_SECONDS_PROD,
    });
    const keys: AccountMeta[] = [
      meta(deployer.publicKey, true, false),
      meta(stakingConfigPda, false, true),
    ];
    const ix = new TransactionInstruction({
      programId: stakingProgramId,
      keys,
      data: encStakingUpdateConfig(keepDepositor, keepMinStake, COOLDOWN_SECONDS_PROD),
    });
    await simulateOrSend(conn, new Transaction().add(ix), [deployer], execute, 'staking.update_config (restore cooldown)');
    if (execute) {
      const stkAfter = await readStakingConfig(conn, stakingConfigPda);
      assert('cooldown restored to 21 days', stkAfter.cooldownSeconds === COOLDOWN_SECONDS_PROD, stkAfter.cooldownSeconds, COOLDOWN_SECONDS_PROD);
    }
  }

  // ========================================================================
  // Summary
  // ========================================================================
  banner('e2e-earn SUMMARY');
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  for (const r of results) console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.step} ${r.detail}`);
  console.log(`\n  ${passed} PASS / ${failed} FAIL (${results.length} assertions)`);
  if (!execute) {
    console.log(
      '\n  DRY-RUN: most lifecycle assertions are DEFERRED (require committed\n' +
        '  post-tx state). Run with --execute to send the txs and run the real\n' +
        '  assertions. The plan, account orders, and arg encodings above are\n' +
        '  validated regardless.',
    );
  }
  console.log(`\n[e2e-earn] DONE (${execute ? 'executed' : 'dry-run / simulate only'}).`);

  if (failed > 0) process.exit(1);
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

// UnstakeTicket layout (8-byte disc + repr(C,packed)): owner[32] @8,
// amount_rwt u64 @40.
const TICKET_AMOUNT_OFFSET = 40;
async function readTicketAmount(conn: Connection, ticket: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ticket, 'confirmed');
  if (!info || info.data.length < TICKET_AMOUNT_OFFSET + 8) return 0n;
  return info.data.readBigUInt64LE(TICKET_AMOUNT_OFFSET);
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  process.exit(1);
});
