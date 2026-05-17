#!/usr/bin/env tsx
/*
 * smoke-swap.ts — Phase 1 NativeDEX-Concentrated-Redesign smoke test.
 *
 * Executes 4 REAL swap transactions against the live programs on the local
 * test-validator. Runs after `scripts/verify-fresh-deploy.sh` deploys + boots
 * the bots (or as step 9 inside that script).
 *
 * Closes the gap left by the §8 E2E scenarios which assert chain state only —
 * no TX submission. Now that the Monotonic Ladder rewrite (CP-1..CP-12.5) is
 * green at the state level, this script confirms the swap path is wired
 * end-to-end:
 *
 *   Smoke 1: StandardCurve OT→RWT swap   (ARL/RWT pool, a→b or b→a)
 *   Smoke 2: StandardCurve RWT→OT swap   (reverse direction, fees from RWT)
 *   Smoke 3: Master pool USDC→RWT swap   (expect route=mintRoute, NO DEX fee)
 *   Smoke 4: Master pool RWT→USDC swap   (expect route=binWalk, requires
 *                                         Nexus-seeded bid wall via Substep 1
 *                                         grow_liquidity — best-effort skip
 *                                         when bid wall is empty)
 *
 * Artifact sources (REQUIRED to be present from a recent fresh deploy):
 *   data/e2e-bootstrap.json          — pool PDAs, vaults, mints, fee ATAs
 *   data/e2e-bootstrap.secrets.json  — mint authority + deployer keypair path
 *
 * Usage:
 *   tsx scripts/smoke-swap.ts [--rpc URL] [--keep-going]
 *
 * Exit code:
 *   0 = all smokes GREEN (or all GREEN/skipped if some preconditions missing
 *       but no submitted tx failed)
 *   1 = at least one submitted tx failed
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

// SDK surface — typed wrappers for the on-chain swap path. SDK is installed
// as a workspace package in bots/* and resolvable from cwd=bots/. The
// top-level @areal/sdk barrel exposes only PDA helpers; the tx-builders,
// quote engine, and parsers live behind sub-path exports.
//   tx        → buildSwapIx + SwapAccountContext
//   native-dex → quoteSwap + parsePoolState + parseDexConfig + parseBinArray
//   rwt-engine → parseRwtVault
import { buildSwapIx } from '@areal/sdk/tx';
import {
  quoteSwap,
  parsePoolState,
  parseDexConfig,
  parseBinArray,
} from '@areal/sdk/native-dex';
import { parseRwtVault } from '@areal/sdk/rwt-engine';
import type { SwapAccountContext } from '@areal/sdk/tx';
import type {
  MasterPoolQuoteContext,
  QuoteOutcome,
} from '@areal/sdk/native-dex';

// --------------------------------------------------------------------------
// Constants — mirror contract source
// --------------------------------------------------------------------------

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

/** Default slippage tolerance (1%). */
const DEFAULT_SLIPPAGE_BPS = 100;

// Smoke input sizes (post-decimals, raw lamports — 6-decimal scale).
// Keep small relative to pool seed (10 USDC / 10 RWT) so price impact stays
// bounded and the LP-shares math doesn't dip into dust territory.
const SC_OT_TO_RWT_AMOUNT = 1_000_000n;    // 1.0 OT
const SC_RWT_TO_OT_AMOUNT = 1_000_000n;    // 1.0 RWT
const MP_USDC_TO_RWT_AMOUNT = 10_000_000n; // 10.0 USDC
const MP_RWT_TO_USDC_AMOUNT = 5_000_000n;  //  5.0 RWT

// --------------------------------------------------------------------------
// Path & env wiring
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const ARTIFACT_PATH = join(REPO_ROOT, 'data', 'e2e-bootstrap.json');
const SECRETS_PATH = join(REPO_ROOT, 'data', 'e2e-bootstrap.secrets.json');

// --------------------------------------------------------------------------
// Artifact shape — only the fields we read.
// --------------------------------------------------------------------------

interface Artifact {
  schema_version: number;
  rpc_url: string;
  deployer_pubkey: string;
  programs: {
    native_dex: string;
    rwt_engine: string;
    ownership_token: string;
  };
  mints: {
    rwt_mint: string;
    usdc_test_mint: string;
    arl_ot_mint: string;
  };
  pdas: {
    dex_config: string;
    master_pool?: string;
    master_pool_vault_a?: string;
    master_pool_vault_b?: string;
    master_pool_bin_array?: string;
    arl_rwt_pool?: string;
    arl_rwt_pool_vault_a?: string;
    arl_rwt_pool_vault_b?: string;
    rwt_vault: string;
    rwt_capital_accumulator_ata: string;
    areal_fee_ata: string;
  };
  ots?: Array<{ ot_mint: string; ot_treasury_pda?: string }>;
}

interface Secrets {
  deployer_keypair_path: string;
  mints: {
    usdc_test_mint_keypair_b64?: string;
    arl_ot_mint_keypair_b64?: string;
    rwt_mint_keypair_b64?: string;
  };
}

// --------------------------------------------------------------------------
// CLI args
// --------------------------------------------------------------------------

interface Args {
  rpc?: string;
  keepGoing: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { keepGoing: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--rpc' && i + 1 < argv.length) {
      args.rpc = argv[++i];
    } else if (a === '--keep-going') {
      args.keepGoing = true;
    } else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: tsx scripts/smoke-swap.ts [--rpc URL] [--keep-going]\n' +
          '\n' +
          'Reads data/e2e-bootstrap.json + data/e2e-bootstrap.secrets.json\n' +
          'and submits 4 real swap transactions to the live programs.\n' +
          '\n' +
          'Options:\n' +
          '  --rpc URL       RPC endpoint (default: rpc_url from artifact)\n' +
          '  --keep-going    Continue past failed smokes; exit 1 if any fail\n' +
          '                  (default: abort on first failure)\n',
      );
      process.exit(0);
    }
  }
  return args;
}

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function info(msg: string): void {
  console.log(msg);
}

function warn(msg: string): void {
  console.warn(`[smoke-swap][warn] ${msg}`);
}

function error(msg: string): void {
  console.error(`[smoke-swap][error] ${msg}`);
}

// --------------------------------------------------------------------------
// Keypair + artifact loaders
// --------------------------------------------------------------------------

function loadKeypairFromFile(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function keypairFromB64(b64: string): Keypair {
  return Keypair.fromSecretKey(Buffer.from(b64, 'base64'));
}

function loadArtifact(): Artifact {
  if (!existsSync(ARTIFACT_PATH)) {
    throw new Error(`artifact missing at ${ARTIFACT_PATH} — run scripts/verify-fresh-deploy.sh first`);
  }
  return JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as Artifact;
}

function loadSecrets(): Secrets {
  if (!existsSync(SECRETS_PATH)) {
    throw new Error(`secrets missing at ${SECRETS_PATH} — run scripts/verify-fresh-deploy.sh first`);
  }
  return JSON.parse(readFileSync(SECRETS_PATH, 'utf8')) as Secrets;
}

// --------------------------------------------------------------------------
// PDA / ATA helpers
// --------------------------------------------------------------------------

function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function createAtaIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const ata = findAta(owner, mint);
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    // 1 = CreateIdempotent
    data: Buffer.from([1]),
  });
}

/** SPL Token Transfer (SPL ix #3). */
function transferIx(
  source: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

// --------------------------------------------------------------------------
// TX helpers
// --------------------------------------------------------------------------

async function sendAndConfirm(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  if (signers.length === 0) {
    throw new Error('sendAndConfirm: at least one signer required');
  }
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  const feePayer = signers[0]!;
  tx.feePayer = feePayer.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const status = value?.[0];
    if (status?.err) {
      throw new Error(`tx failed: ${JSON.stringify(status.err)} (sig=${sig})`);
    }
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    ) {
      return sig;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`confirmation timeout: sig=${sig}`);
}

async function getTokenBalance(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata, 'confirmed');
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

/**
 * Read the SPL Mint account and return its current `mint_authority`.
 *
 * SPL Mint layout (relevant prefix):
 *   0..4   COption tag for mint_authority (u32 LE; 1 = Some, 0 = None)
 *   4..36  mint_authority pubkey (32 bytes)
 *  36..44  supply (u64 LE)
 *  44      decimals (u8)
 *  45      is_initialized (u8)
 *  46..50  COption tag for freeze_authority
 *  ...
 *
 * Returns `null` when the COption tag is `None` (authority disabled). Throws
 * if the account doesn't exist or is smaller than 82 bytes.
 */
async function readMintAuthority(
  conn: Connection,
  mint: PublicKey,
): Promise<PublicKey | null> {
  const info = await conn.getAccountInfo(mint, 'confirmed');
  if (!info) {
    throw new Error(`mint account not found: ${mint.toBase58()}`);
  }
  if (info.data.length < 82) {
    throw new Error(
      `mint account too small (${info.data.length} < 82 bytes): ${mint.toBase58()}`,
    );
  }
  const tag = info.data.readUInt32LE(0);
  if (tag === 0) return null;
  if (tag !== 1) {
    throw new Error(
      `unexpected COption tag (${tag}) for mint_authority on ${mint.toBase58()}`,
    );
  }
  return new PublicKey(info.data.subarray(4, 36));
}

async function fetchAndParsePool(conn: Connection, pool: PublicKey) {
  const info = await conn.getAccountInfo(pool, 'confirmed');
  if (!info) throw new Error(`pool not found: ${pool.toBase58()}`);
  return parsePoolState(info.data);
}

async function fetchAndParseDexConfig(conn: Connection, dexConfig: PublicKey) {
  const info = await conn.getAccountInfo(dexConfig, 'confirmed');
  if (!info) throw new Error(`dex_config not found: ${dexConfig.toBase58()}`);
  return parseDexConfig(info.data);
}

async function fetchAndParseRwtVault(conn: Connection, rwtVault: PublicKey) {
  const info = await conn.getAccountInfo(rwtVault, 'confirmed');
  if (!info) throw new Error(`rwt_vault not found: ${rwtVault.toBase58()}`);
  return parseRwtVault(info.data);
}

/**
 * Scan the BinArray for any bin ABOVE `activeBinId` carrying liquidityA > 0.
 *
 * The on-chain `concentrated::bin_walk_has_liquidity_above` mirrors this exact
 * predicate. Bin IDs are computed as `lowerBinId + index` (the BinArray is a
 * flat `bins: Bin[]` where `Bin = { liquidityA, liquidityB }`).
 */
async function hasOrganicAsk(
  conn: Connection,
  binArrayPda: PublicKey,
  activeBinId: number,
): Promise<boolean> {
  const info = await conn.getAccountInfo(binArrayPda, 'confirmed');
  if (!info) return false;
  let arr;
  try {
    arr = parseBinArray(info.data);
  } catch {
    return false;
  }
  const lowerBinId = arr.lowerBinId;
  for (let i = 0; i < arr.bins.length; i++) {
    const bin = arr.bins[i]!;
    const binId = lowerBinId + i;
    if (binId > activeBinId && bin.liquidityA > 0n) return true;
  }
  return false;
}

/**
 * Scan the BinArray for any bin AT or BELOW `activeBinId` carrying
 * liquidityB > 0. Mirrors the bid-side precondition needed before submitting
 * a RWT→USDC swap on a master pool.
 */
async function hasOrganicBid(
  conn: Connection,
  binArrayPda: PublicKey,
  activeBinId: number,
): Promise<boolean> {
  const info = await conn.getAccountInfo(binArrayPda, 'confirmed');
  if (!info) return false;
  let arr;
  try {
    arr = parseBinArray(info.data);
  } catch {
    return false;
  }
  const lowerBinId = arr.lowerBinId;
  for (let i = 0; i < arr.bins.length; i++) {
    const bin = arr.bins[i]!;
    const binId = lowerBinId + i;
    if (binId <= activeBinId && bin.liquidityB > 0n) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Slippage floor (bigint percent-bps)
// --------------------------------------------------------------------------

function applyBpsFloor(expected: bigint, slippageBps: number): bigint {
  // floor(expected * (10_000 - slippageBps) / 10_000)
  const num = expected * BigInt(10_000 - slippageBps);
  return num / 10_000n;
}

// --------------------------------------------------------------------------
// User funding — mint OT/USDC, admin_mint_rwt for RWT
// --------------------------------------------------------------------------

/** Build a raw SPL MintTo ix (#7). */
function mintToIx(
  mint: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

// --------------------------------------------------------------------------
// Smoke runner
// --------------------------------------------------------------------------

type SmokeStatus = 'ok' | 'failed' | 'skipped';

interface SmokeResult {
  name: string;
  status: SmokeStatus;
  details: string;
  tx?: string;
}

interface SmokeContext {
  conn: Connection;
  deployer: Keypair;
  user: Keypair;
  art: Artifact;
  secrets: Secrets;
  dexProgramId: PublicKey;
  rwtEngineProgramId: PublicKey;
  results: SmokeResult[];
  keepGoing: boolean;
}

async function runSmoke(
  ctx: SmokeContext,
  name: string,
  fn: () => Promise<SmokeResult>,
): Promise<void> {
  info(`\nSmoke: ${name}`);
  let result: SmokeResult;
  try {
    result = await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result = { name, status: 'failed', details: msg };
  }
  ctx.results.push(result);
  const tag = result.status === 'ok' ? 'OK' : result.status === 'skipped' ? 'SKIP' : 'FAIL';
  info(`  [${tag}] ${result.details}`);
  if (result.tx) info(`  tx: ${result.tx}`);
  if (result.status === 'failed' && !ctx.keepGoing) {
    throw new Error(`smoke '${name}' failed (use --keep-going to continue)`);
  }
}

// --------------------------------------------------------------------------
// User setup — fresh keypair, airdrop, ATAs, fund tokens
// --------------------------------------------------------------------------

type FundMethod = 'mint' | 'transfer' | 'skipped';

interface FundResult {
  funded: bigint;
  method: FundMethod;
}

/**
 * Fund a user ATA with `amount` of `mint`, picking the strategy dynamically:
 *
 *   - If the on-chain `mint_authority` equals the deployer pubkey, emit
 *     SPL MintTo signed by the deployer.
 *   - Otherwise, the authority is a PDA (e.g. OT::OtConfig, RWT::rwt_vault)
 *     and we cannot mint with a plain keypair signer. Fall back to SPL
 *     Transfer from deployer's pre-seeded ATA. If the deployer doesn't hold
 *     enough, warn and skip (the smoke that needs this token will then skip
 *     gracefully on its own balance preflight).
 *
 * Why dynamic: post-`initialize_ot` the OT mint authority is transferred from
 * deployer to the `OtConfig` PDA, so any direct `MintTo` returns SPL error
 * 0x4 (`OwnerMismatch`). USDC test mint stays on deployer. RWT is vault-PDA.
 * Reading the authority off-chain is the robust path — it survives any future
 * change to bootstrap (e.g. transferring USDC authority too).
 */
async function fundUserToken(
  conn: Connection,
  deployer: Keypair,
  mint: PublicKey,
  userAta: PublicKey,
  amount: bigint,
  label: string,
): Promise<FundResult> {
  const authority = await readMintAuthority(conn, mint);

  if (authority !== null && authority.equals(deployer.publicKey)) {
    const tx = new Transaction().add(
      mintToIx(mint, userAta, deployer.publicKey, amount),
    );
    await sendAndConfirm(conn, tx, [deployer]);
    info(`  funded user ${label} ATA with ${amount} via MintTo (authority=deployer)`);
    return { funded: amount, method: 'mint' };
  }

  // Authority is a PDA (or None) — fall back to Transfer from deployer ATA.
  const deployerAta = findAta(deployer.publicKey, mint);
  const balance = await getTokenBalance(conn, deployerAta);
  if (balance < amount) {
    warn(
      `deployer ${label} balance (${balance}) < requested ${amount} — ` +
        `funding partial/skipped (authority=${authority?.toBase58() ?? 'NONE'})`,
    );
    if (balance === 0n) {
      return { funded: 0n, method: 'skipped' };
    }
    // Transfer whatever's available so dependent smokes can still partially run.
    const partialTx = new Transaction().add(
      transferIx(deployerAta, userAta, deployer.publicKey, balance),
    );
    await sendAndConfirm(conn, partialTx, [deployer]);
    info(
      `  funded user ${label} ATA with ${balance} (partial) via Transfer ` +
        `(authority=${authority?.toBase58() ?? 'NONE'})`,
    );
    return { funded: balance, method: 'transfer' };
  }

  const tx = new Transaction().add(
    transferIx(deployerAta, userAta, deployer.publicKey, amount),
  );
  await sendAndConfirm(conn, tx, [deployer]);
  info(
    `  funded user ${label} ATA with ${amount} via Transfer ` +
      `(authority=${authority?.toBase58() ?? 'NONE'})`,
  );
  return { funded: amount, method: 'transfer' };
}

async function setupUser(ctx: SmokeContext): Promise<void> {
  const { conn, user, deployer, art } = ctx;
  info(`\n=== User setup ===`);
  info(`User pubkey: ${user.publicKey.toBase58()}`);

  // Airdrop SOL. Localnet only — fast.
  const sig = await conn.requestAirdrop(user.publicKey, 5_000_000_000); // 5 SOL
  await conn.confirmTransaction({
    signature: sig,
    blockhash: (await conn.getLatestBlockhash('confirmed')).blockhash,
    lastValidBlockHeight: (await conn.getLatestBlockhash('confirmed')).lastValidBlockHeight,
  });
  info(`  airdropped 5 SOL: ${sig}`);

  // Create ATAs for OT, RWT, USDC.
  const otMint = new PublicKey(art.mints.arl_ot_mint);
  const rwtMint = new PublicKey(art.mints.rwt_mint);
  const usdcMint = new PublicKey(art.mints.usdc_test_mint);

  const tx = new Transaction();
  tx.add(createAtaIdempotentIx(deployer.publicKey, user.publicKey, otMint));
  tx.add(createAtaIdempotentIx(deployer.publicKey, user.publicKey, rwtMint));
  tx.add(createAtaIdempotentIx(deployer.publicKey, user.publicKey, usdcMint));
  await sendAndConfirm(conn, tx, [deployer]);
  info(`  created ATAs (OT, RWT, USDC) for user`);

  // Fund each token via the dynamic strategy. Per bootstrap (2026-05-17):
  //   - OT  : authority transferred to OtConfig PDA in initialize_ot   → Transfer
  //   - USDC: authority stays on deployer (ensureMint sets it)          → MintTo
  //   - RWT : authority is rwt_vault PDA (initialize_vault sets it)    → Transfer
  // fundUserToken() resolves this dynamically so the script stays correct
  // even if bootstrap evolves.
  const userOtAta = findAta(user.publicKey, otMint);
  await fundUserToken(conn, deployer, otMint, userOtAta, 100_000_000n, 'OT'); // 100 OT

  const userUsdcAta = findAta(user.publicKey, usdcMint);
  await fundUserToken(conn, deployer, usdcMint, userUsdcAta, 1_000_000_000n, 'USDC'); // 1000 USDC

  const userRwtAta = findAta(user.publicKey, rwtMint);
  await fundUserToken(conn, deployer, rwtMint, userRwtAta, 100_000_000n, 'RWT'); // 100 RWT
}

// --------------------------------------------------------------------------
// StandardCurve OT → RWT (Smoke 1) and RWT → OT (Smoke 2)
// --------------------------------------------------------------------------

async function smokeStandardCurve(
  ctx: SmokeContext,
  direction: 'ot_to_rwt' | 'rwt_to_ot',
): Promise<SmokeResult> {
  const name =
    direction === 'ot_to_rwt' ? 'StandardCurve OT→RWT' : 'StandardCurve RWT→OT';
  const { conn, user, art, dexProgramId } = ctx;

  if (!art.pdas.arl_rwt_pool || !art.pdas.arl_rwt_pool_vault_a || !art.pdas.arl_rwt_pool_vault_b) {
    return {
      name,
      status: 'skipped',
      details: 'arl_rwt_pool not initialized (Substep 2 phaseArlRwtPool skipped)',
    };
  }

  const pool = new PublicKey(art.pdas.arl_rwt_pool);
  const vaultA = new PublicKey(art.pdas.arl_rwt_pool_vault_a);
  const vaultB = new PublicKey(art.pdas.arl_rwt_pool_vault_b);
  const dexConfig = new PublicKey(art.pdas.dex_config);
  const arealFeeAta = new PublicKey(art.pdas.areal_fee_ata);

  const poolState = await fetchAndParsePool(conn, pool);
  const config = await fetchAndParseDexConfig(conn, dexConfig);
  const rwtMint = new PublicKey(art.mints.rwt_mint);

  // Decide a→b based on which side is the input.
  const inputMint =
    direction === 'ot_to_rwt'
      ? new PublicKey(art.mints.arl_ot_mint)
      : rwtMint;
  const outputMint =
    direction === 'ot_to_rwt'
      ? rwtMint
      : new PublicKey(art.mints.arl_ot_mint);
  const aToB = poolState.tokenAMint.equals(inputMint);

  const amountIn = direction === 'ot_to_rwt' ? SC_OT_TO_RWT_AMOUNT : SC_RWT_TO_OT_AMOUNT;

  // Quote.
  const quoteOut: QuoteOutcome = quoteSwap({
    pool: poolState,
    config,
    amountIn,
    aToB,
    rwtMint,
  });
  if (!quoteOut.ok) {
    return { name, status: 'failed', details: `quote failed: ${quoteOut.error}` };
  }
  const q = quoteOut.quote;

  // Balance preflight on input ATA.
  const userInAta = findAta(user.publicKey, inputMint);
  const userOutAta = findAta(user.publicKey, outputMint);
  const inBalBefore = await getTokenBalance(conn, userInAta);
  const outBalBefore = await getTokenBalance(conn, userOutAta);

  if (inBalBefore < q.userTotalDebit) {
    return {
      name,
      status: 'skipped',
      details: `insufficient input balance (have ${inBalBefore}, need ${q.userTotalDebit})`,
    };
  }

  info(
    `  Quote: route=${q.route} amountOut=${q.amountOut} feeTotal=${q.fees.feeTotal} feeLp=${q.fees.feeLp} feeProtocol=${q.fees.feeProtocol} feeOtTreasury=${q.fees.feeOtTreasury}`,
  );

  const minAmountOut = applyBpsFloor(q.amountOut, DEFAULT_SLIPPAGE_BPS);

  // OT-treasury fee dest — ARL/RWT pool has it.
  const otTreasuryFeeDest = poolState.hasOtTreasury
    ? poolState.otTreasuryFeeDestination
    : undefined;

  const ctxSwap: SwapAccountContext = {
    dexProgramId,
    user: user.publicKey,
    dexConfig,
    pool,
    vaultA,
    vaultB,
    arealFeeAccount: arealFeeAta,
    otTreasuryFeeDestination: otTreasuryFeeDest,
  };

  const ix = buildSwapIx({
    ctx: ctxSwap,
    userTokenIn: userInAta,
    userTokenOut: userOutAta,
    aToB,
    amountIn,
    minAmountOut,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirm(conn, tx, [user]);

  // Post-swap balance check.
  const inBalAfter = await getTokenBalance(conn, userInAta);
  const outBalAfter = await getTokenBalance(conn, userOutAta);
  const inDebited = inBalBefore - inBalAfter;
  const outReceived = outBalAfter - outBalBefore;

  if (outReceived <= 0n) {
    return {
      name,
      status: 'failed',
      details: `no output received (in=${inDebited}, out=${outReceived})`,
      tx: sig,
    };
  }
  if (outReceived < minAmountOut) {
    return {
      name,
      status: 'failed',
      details: `output below slippage floor: received=${outReceived} min=${minAmountOut}`,
      tx: sig,
    };
  }

  // Fetch logs and grep for SwapExecuted.
  const txMeta = await conn.getTransaction(sig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const logs: string[] = txMeta?.meta?.logMessages ?? [];
  const sawSwapExecuted = logs.some((l: string) => l.includes('SwapExecuted'));
  const sawRoutedToMint = logs.some((l: string) => l.includes('SwapRoutedToMint'));

  return {
    name,
    status: 'ok',
    details:
      `inDebited=${inDebited} outReceived=${outReceived} ` +
      `event=${sawRoutedToMint ? 'SwapRoutedToMint' : sawSwapExecuted ? 'SwapExecuted' : 'NONE'}`,
    tx: sig,
  };
}

// --------------------------------------------------------------------------
// Master pool USDC → RWT (Smoke 3) — expect mint-route
// --------------------------------------------------------------------------

async function smokeMasterPoolUsdcToRwt(ctx: SmokeContext): Promise<SmokeResult> {
  const name = 'Master pool USDC→RWT (mint-route)';
  const { conn, user, art, dexProgramId, rwtEngineProgramId } = ctx;

  if (!art.pdas.master_pool || !art.pdas.master_pool_bin_array) {
    return {
      name,
      status: 'skipped',
      details: 'master_pool not initialized (Substep 2 phaseMasterPool skipped)',
    };
  }

  const pool = new PublicKey(art.pdas.master_pool);
  const vaultA = new PublicKey(art.pdas.master_pool_vault_a!);
  const vaultB = new PublicKey(art.pdas.master_pool_vault_b!);
  const binArray = new PublicKey(art.pdas.master_pool_bin_array);
  const dexConfig = new PublicKey(art.pdas.dex_config);
  const arealFeeAta = new PublicKey(art.pdas.areal_fee_ata);
  const rwtVault = new PublicKey(art.pdas.rwt_vault);
  const rwtMint = new PublicKey(art.mints.rwt_mint);
  const usdcMint = new PublicKey(art.mints.usdc_test_mint);
  const capitalAcc = new PublicKey(art.pdas.rwt_capital_accumulator_ata);

  const poolState = await fetchAndParsePool(conn, pool);
  const config = await fetchAndParseDexConfig(conn, dexConfig);
  const rwtVaultState = await fetchAndParseRwtVault(conn, rwtVault);

  const inputMint = usdcMint;
  const outputMint = rwtMint;
  const aToB = poolState.tokenAMint.equals(inputMint);
  const amountIn = MP_USDC_TO_RWT_AMOUNT;

  // Resolve organic-ask flag for the off-chain quote routing decision.
  const organicAsk = await hasOrganicAsk(conn, binArray, poolState.activeBinId);
  const masterPoolContext: MasterPoolQuoteContext = {
    nav: rwtVaultState.navBookValue,
    hasOrganicAsk: organicAsk,
  };

  const quoteOut: QuoteOutcome = quoteSwap({
    pool: poolState,
    config,
    amountIn,
    aToB,
    rwtMint,
    masterPoolContext,
  });
  if (!quoteOut.ok) {
    return { name, status: 'failed', details: `quote failed: ${quoteOut.error}` };
  }
  const q = quoteOut.quote;

  info(
    `  Quote: route=${q.route} amountOut=${q.amountOut} NAV=${rwtVaultState.navBookValue} organicAsk=${organicAsk}`,
  );
  if (q.route !== 'mintRoute') {
    warn(
      `expected route=mintRoute but quote says route=${q.route} — bid wall may be misseeded`,
    );
  }

  const userInAta = findAta(user.publicKey, inputMint);
  const userOutAta = findAta(user.publicKey, outputMint);
  const inBalBefore = await getTokenBalance(conn, userInAta);
  const outBalBefore = await getTokenBalance(conn, userOutAta);
  const arealFeeBalBefore = await getTokenBalance(conn, arealFeeAta);

  if (inBalBefore < amountIn) {
    return {
      name,
      status: 'skipped',
      details: `insufficient USDC (have ${inBalBefore}, need ${amountIn})`,
    };
  }

  const minAmountOut = applyBpsFloor(q.amountOut, DEFAULT_SLIPPAGE_BPS);

  // Master pool: master pools have has_ot_treasury=false (CP-4 invariant).
  // Supply BinArray (always) + 5 mint-route slots so the on-chain gate can
  // pick the path data-driven.
  const ctxSwap: SwapAccountContext = {
    dexProgramId,
    user: user.publicKey,
    dexConfig,
    pool,
    vaultA,
    vaultB,
    arealFeeAccount: arealFeeAta,
    binArray,
    masterPoolMintRouteAccounts: {
      rwtVault,
      rwtMint,
      capitalAcc,
      daoFeeAccount: arealFeeAta,
      rwtEngineProgram: rwtEngineProgramId,
    },
  };

  const ix = buildSwapIx({
    ctx: ctxSwap,
    userTokenIn: userInAta,
    userTokenOut: userOutAta,
    aToB,
    amountIn,
    minAmountOut,
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirm(conn, tx, [user]);

  const inBalAfter = await getTokenBalance(conn, userInAta);
  const outBalAfter = await getTokenBalance(conn, userOutAta);
  const arealFeeBalAfter = await getTokenBalance(conn, arealFeeAta);
  const inDebited = inBalBefore - inBalAfter;
  const outReceived = outBalAfter - outBalBefore;
  const arealFeeDelta = arealFeeBalAfter - arealFeeBalBefore;

  const txMeta = await conn.getTransaction(sig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const logs: string[] = txMeta?.meta?.logMessages ?? [];
  const sawRoutedToMint = logs.some((l: string) => l.includes('SwapRoutedToMint'));
  const sawSwapExecuted = logs.some((l: string) => l.includes('SwapExecuted'));

  const eventTag = sawRoutedToMint
    ? 'SwapRoutedToMint'
    : sawSwapExecuted
      ? 'SwapExecuted'
      : 'NONE';

  if (!sawRoutedToMint && q.route === 'mintRoute') {
    return {
      name,
      status: 'failed',
      details: `quote predicted mintRoute but no SwapRoutedToMint event in logs (event=${eventTag})`,
      tx: sig,
    };
  }

  return {
    name,
    status: 'ok',
    details:
      `route=${q.route} usdcDebited=${inDebited} rwtReceived=${outReceived} ` +
      `arealFeeDelta=${arealFeeDelta} event=${eventTag}`,
    tx: sig,
  };
}

// --------------------------------------------------------------------------
// Master pool RWT → USDC (Smoke 4) — expect bin-walk
// --------------------------------------------------------------------------

async function smokeMasterPoolRwtToUsdc(ctx: SmokeContext): Promise<SmokeResult> {
  const name = 'Master pool RWT→USDC (bin-walk)';
  const { conn, user, art, dexProgramId } = ctx;

  if (!art.pdas.master_pool || !art.pdas.master_pool_bin_array) {
    return {
      name,
      status: 'skipped',
      details: 'master_pool not initialized (Substep 2 phaseMasterPool skipped)',
    };
  }

  const pool = new PublicKey(art.pdas.master_pool);
  const vaultA = new PublicKey(art.pdas.master_pool_vault_a!);
  const vaultB = new PublicKey(art.pdas.master_pool_vault_b!);
  const binArray = new PublicKey(art.pdas.master_pool_bin_array);
  const dexConfig = new PublicKey(art.pdas.dex_config);
  const arealFeeAta = new PublicKey(art.pdas.areal_fee_ata);

  const poolState = await fetchAndParsePool(conn, pool);
  const rwtMint = new PublicKey(art.mints.rwt_mint);
  const usdcMint = new PublicKey(art.mints.usdc_test_mint);

  // Pre-flight: bid wall must have organic USDC below the active bin.
  const bidWallReady = await hasOrganicBid(conn, binArray, poolState.activeBinId);
  if (!bidWallReady) {
    return {
      name,
      status: 'skipped',
      details:
        'bid wall empty (Nexus grow_liquidity has not seeded USDC at/below active bin); ' +
        'RWT→USDC bin-walk requires a non-empty bid side',
    };
  }

  const inputMint = rwtMint;
  const outputMint = usdcMint;
  const aToB = poolState.tokenAMint.equals(inputMint);
  const amountIn = MP_RWT_TO_USDC_AMOUNT;

  // The off-chain quote engine cannot simulate concentrated bin-walk — it
  // returns 'EmptyReserves'. Submit blind with a conservative minAmountOut
  // (0n) and verify the on-chain math succeeded via SwapExecuted + balance
  // grew. This mirrors the bin-walk parity test gap noted in quote.ts.
  info(`  Quote: skipped (concentrated bin-walk not modelled off-chain); submitting blind`);

  const userInAta = findAta(user.publicKey, inputMint);
  const userOutAta = findAta(user.publicKey, outputMint);
  const inBalBefore = await getTokenBalance(conn, userInAta);
  const outBalBefore = await getTokenBalance(conn, userOutAta);
  const arealFeeBalBefore = await getTokenBalance(conn, arealFeeAta);

  // RWT-input: user_total_debit = amountIn + fees. Need extra buffer for fees.
  // Hardcoded 5% buffer is generous (real fee is 30bps).
  const debitCeiling = (amountIn * 105n) / 100n;
  if (inBalBefore < debitCeiling) {
    return {
      name,
      status: 'skipped',
      details: `insufficient RWT for amount + fees buffer (have ${inBalBefore}, need ~${debitCeiling})`,
    };
  }

  const ctxSwap: SwapAccountContext = {
    dexProgramId,
    user: user.publicKey,
    dexConfig,
    pool,
    vaultA,
    vaultB,
    arealFeeAccount: arealFeeAta,
    binArray,
  };

  const ix = buildSwapIx({
    ctx: ctxSwap,
    userTokenIn: userInAta,
    userTokenOut: userOutAta,
    aToB,
    amountIn,
    minAmountOut: 0n, // conservative — bin-walk math is opaque off-chain
  });

  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirm(conn, tx, [user]);

  const inBalAfter = await getTokenBalance(conn, userInAta);
  const outBalAfter = await getTokenBalance(conn, userOutAta);
  const arealFeeBalAfter = await getTokenBalance(conn, arealFeeAta);
  const inDebited = inBalBefore - inBalAfter;
  const outReceived = outBalAfter - outBalBefore;
  const arealFeeDelta = arealFeeBalAfter - arealFeeBalBefore;

  if (outReceived <= 0n) {
    return {
      name,
      status: 'failed',
      details: `no USDC received (rwtDebited=${inDebited}, usdcReceived=${outReceived})`,
      tx: sig,
    };
  }

  const txMeta = await conn.getTransaction(sig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const logs: string[] = txMeta?.meta?.logMessages ?? [];
  const sawSwapExecuted = logs.some((l: string) => l.includes('SwapExecuted'));
  const sawRoutedToMint = logs.some((l: string) => l.includes('SwapRoutedToMint'));

  return {
    name,
    status: 'ok',
    details:
      `rwtDebited=${inDebited} usdcReceived=${outReceived} ` +
      `arealFeeDelta=${arealFeeDelta} event=${sawSwapExecuted ? 'SwapExecuted' : sawRoutedToMint ? 'SwapRoutedToMint' : 'NONE'}`,
    tx: sig,
  };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const art = loadArtifact();
  const secrets = loadSecrets();
  const rpcUrl = args.rpc ?? art.rpc_url;

  info(`=== Native DEX Smoke Swap (${nowIso()}) ===`);
  info(`RPC: ${rpcUrl}`);
  info(`Deployer: ${art.deployer_pubkey}`);

  const conn = new Connection(rpcUrl, 'confirmed');

  // Verify validator is reachable.
  try {
    const slot = await conn.getSlot('confirmed');
    info(`Validator reachable at slot ${slot}`);
  } catch (e) {
    error(`failed to reach validator at ${rpcUrl}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  const deployer = loadKeypairFromFile(secrets.deployer_keypair_path);
  const user = Keypair.generate();

  const dexProgramId = new PublicKey(art.programs.native_dex);
  const rwtEngineProgramId = new PublicKey(art.programs.rwt_engine);

  const ctx: SmokeContext = {
    conn,
    deployer,
    user,
    art,
    secrets,
    dexProgramId,
    rwtEngineProgramId,
    results: [],
    keepGoing: args.keepGoing,
  };

  // Setup user (airdrop, ATAs, fund tokens).
  await setupUser(ctx);

  // Run 4 smokes.
  await runSmoke(ctx, 'StandardCurve OT→RWT', () =>
    smokeStandardCurve(ctx, 'ot_to_rwt'),
  );
  await runSmoke(ctx, 'StandardCurve RWT→OT', () =>
    smokeStandardCurve(ctx, 'rwt_to_ot'),
  );
  await runSmoke(ctx, 'Master pool USDC→RWT (mint-route)', () =>
    smokeMasterPoolUsdcToRwt(ctx),
  );
  await runSmoke(ctx, 'Master pool RWT→USDC (bin-walk)', () =>
    smokeMasterPoolRwtToUsdc(ctx),
  );

  // Summary.
  const ok = ctx.results.filter((r) => r.status === 'ok').length;
  const failed = ctx.results.filter((r) => r.status === 'failed').length;
  const skipped = ctx.results.filter((r) => r.status === 'skipped').length;
  const total = ctx.results.length;

  info(`\n=== Summary: ${ok}/${total} GREEN, ${failed} FAILED, ${skipped} SKIPPED ===`);
  for (const r of ctx.results) {
    const tag = r.status === 'ok' ? 'OK' : r.status === 'skipped' ? 'SKIP' : 'FAIL';
    info(`  [${tag}] ${r.name} — ${r.details}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  error(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  process.exit(1);
});
