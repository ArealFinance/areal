#!/usr/bin/env tsx
/*
 * bootstrap-init.ts — Layer 9 Substep 12 on-chain init driver.
 *
 * Heavy on-chain initialization for the localhost E2E bootstrap. Driven by
 * scripts/e2e-bootstrap.sh (stage 6). Reads program IDs + deployer keypair
 * from data/e2e-bootstrap.json (already populated by stages 1-5) and runs
 * the seven init phases:
 *
 *   a) Test mints                : USDC test mint, SPRK OT mint
 *   b) Singleton configs         : DEX initialize_dex, YD initialize_config
 *   c) RWT vault                 : RWT::initialize_vault (mint authority -> vault PDA)
 *   d) YD liquidity holding      : YD::initialize_liquidity_holding (best-effort)
 *   e) DEX Liquidity Nexus       : DEX::initialize_nexus (best-effort, Layer 9)
 *   f) Master RWT/USDC pool      : DEX::create_pool + add_liquidity
 *   g) Per-OT (always creates SPRK at index 0 + OT_TEST_COUNT extras, default 0):
 *        OT::initialize_ot, YD::create_distributor, optional batch_update_destinations
 *   h) USDC supply mints to: deployer, publisher mock, accumulator USDC ATAs
 *
 * Idempotency: PDA presence is read first; if already initialized, the step is
 * skipped and the existing on-chain state is reflected back into the artifact
 * map (mirrors dashboard/src/lib/stores/e2e-runner.ts).
 *
 * Idempotency caveat: test mint Keypairs are RANDOM per run unless reseeded
 * from data/e2e-bootstrap.json. On warm restarts (KEEP_LEDGER=1) the previous
 * mints are reused via the artifact map.
 *
 * Output: writes data/e2e-bootstrap.json with all created addresses (mints,
 * PDAs, ATAs, distributors, bot keypair paths if generated separately).
 *
 * Usage:
 *   npx tsx scripts/lib/bootstrap-init.ts \
 *       [--artifact data/e2e-bootstrap.json] \
 *       [--ot-count 0]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
// Phase 25 (post-2068192) — dashboard's local `arlex-client` was extracted
// into the @arlex/client npm package (v0.3.x). Same constructor signature
// (`new ArlexClient(idl, programId, connection)`) and same `.buildTransaction`
// method shape — only the import path changed. Resolved via the bots/
// node_modules tree (`scripts/e2e-bootstrap.sh::stage_init` sets NODE_PATH).
import { ArlexClient } from '@arlex/client';

// --------------------------------------------------------------------------
// Constants & paths
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

const DEFAULT_ARTIFACT_PATH = join(REPO_ROOT, 'data', 'e2e-bootstrap.json');
// Extra test OTs to create on top of the canonical SPRK OT (always created at
// index 0). Default 0 means "SPRK only" — the user-facing token list is then
// USDC + RWT + SPRK. Set OT_TEST_COUNT=N to provision N additional generic
// test OTs (named "Test OT 1..N", symbols "TOT1..N") for harness scenarios.
const DEFAULT_OT_COUNT = parseInt(process.env.OT_TEST_COUNT ?? '0', 10);

/**
 * Substep 12 sec M-2 — secret-file split.
 *
 * The single artifact embeds three flavors of state:
 *   1. Public  — program IDs, PDAs, init flags, slot. Safe to share.
 *   2. Secret  — keypair bytes (`*_keypair_b64`), RPC tokens, deployer paths.
 *   3. Public-but-derivable — addresses derived from secret values.
 *
 * For a clean public-repo demo, we split the on-disk representation: the
 * primary artifact stays human-readable + safe; secrets live in a sibling
 * `<basename>.secrets.json` with the same 0o600 perms that the merged file
 * had. Loading is symmetric — `loadArtifact` re-merges so callers see the
 * pre-split shape.
 */
function secretsPathFor(artifactPath: string): string {
  const ext = artifactPath.endsWith('.json') ? '.json' : '';
  const base = ext ? artifactPath.slice(0, -ext.length) : artifactPath;
  return `${base}.secrets${ext || '.json'}`;
}

/** Top-level artifact keys that contain secret material. */
type SecretMintKey =
  | 'usdc_test_mint_keypair_b64'
  | 'sprk_ot_mint_keypair_b64'
  | 'rwt_mint_keypair_b64';
const SECRET_MINT_KEYS: ReadonlyArray<SecretMintKey> = [
  'usdc_test_mint_keypair_b64',
  'sprk_ot_mint_keypair_b64',
  'rwt_mint_keypair_b64',
];

type SecretOtKey = 'ot_mint_keypair_b64';
const SECRET_OT_KEYS: ReadonlyArray<SecretOtKey> = ['ot_mint_keypair_b64'];

interface SecretsFile {
  /** Schema version mirrors the public artifact's version. */
  schema_version: number;
  /** Optional deployer keypair path — duplicated here so secrets file is self-contained. */
  deployer_keypair_path?: string;
  /** Subset of `mints` containing only `*_keypair_b64` fields. */
  mints?: Partial<Record<SecretMintKey, string>>;
  /** Per-OT keypair bytes, keyed by OT mint pubkey (base58). */
  ots?: Record<string, { ot_mint_keypair_b64: string }>;
  /** Per-bot keypair paths (already kept here for completeness). */
  bots?: Artifact['bots'];
}

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function log(stage: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[bootstrap-init] [${stage}] ${msg}`;
  if (extra) {
    console.log(line, JSON.stringify(extra));
  } else {
    console.log(line);
  }
}

function warn(stage: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[bootstrap-init] [${stage}] WARN: ${msg}`;
  if (extra) {
    console.warn(line, JSON.stringify(extra));
  } else {
    console.warn(line);
  }
}

// --------------------------------------------------------------------------
// Artifact map I/O
// --------------------------------------------------------------------------

interface OtRecord {
  ot_mint: string;
  ot_mint_keypair_b64: string;
  ot_config_pda: string;
  revenue_account_pda: string;
  revenue_config_pda: string;
  ot_governance_pda: string;
  ot_treasury_pda: string;
  revenue_token_account: string;
  yd_distributor_pda?: string;
  yd_accumulator_pda?: string;
  reward_vault?: string;
  accumulator_usdc_ata?: string;
  // Layer 10 substep 2 — SPRK OT bootstrap extras (Phase 3 plan §63-77).
  // Populated only for the first OT (SPRK) by phaseFutarchy / phaseDestinations
  // / phaseSprkMint. Optional so non-SPRK test OTs keep the existing shape.
  futarchy_config_pda?: string;
  treasury_usdc_ata?: string;
  destinations_set?: boolean;
  initial_supply_minted?: string;
}

// Schema version for the artifact JSON. Bumped when fields are added,
// removed, or repurposed so downstream consumers (Substep 13 E2E harness,
// cu-profile.sh) can break-detect drift cleanly.
export const ARTIFACT_SCHEMA_VERSION = 1 as const;

interface Artifact {
  schema_version: number;
  bootstrap_target: 'localhost' | 'devnet';
  rpc_url: string;
  ws_url?: string;
  deployer_keypair_path: string;
  deployer_pubkey: string;
  programs: {
    ownership_token: string;
    native_dex: string;
    rwt_engine: string;
    yield_distribution: string;
    futarchy: string;
  };
  mints?: {
    usdc_test_mint: string;
    usdc_test_mint_keypair_b64: string;
    sprk_ot_mint?: string;
    sprk_ot_mint_keypair_b64?: string;
    rwt_mint?: string;
    rwt_mint_keypair_b64?: string;
  };
  pdas?: {
    dex_config: string;
    pool_creators: string;
    yd_dist_config: string;
    rwt_vault: string;
    rwt_dist_config: string;
    rwt_capital_accumulator_ata: string;
    areal_fee_ata: string;
    /**
     * RWT-denominated protocol fee ATA (deployer owner).
     *
     * The DEX `swap` / `zap_liquidity` paths validate
     * `accounts.areal_fee_account.mint == RWT_MINT` after the address-equality
     * check against `DexConfig.areal_fee_destination`. Per docs/contracts/
     * native-dex.mdx §71, all DEX fees are charged in RWT. `initialize_dex`
     * runs before `phaseRwtVault`, so the RWT mint doesn't exist yet at init
     * time — bootstrap populates `areal_fee_destination` with the USDC ATA,
     * then rotates to this RWT ATA via `update_areal_fee_destination` after
     * `phaseYdConfig` (which creates this same RWT ATA for YD's distinct
     * `areal_fee_destination_account`).
     *
     * `areal_fee_ata` (USDC) is retained because `OT::initialize_ot` stores
     * it on each `OtConfig` for `distribute_revenue` (which moves USDC
     * royalties, not RWT — different fee surface, same wallet).
     */
    areal_fee_ata_rwt?: string;
    liquidity_holding?: string;
    liquidity_holding_ata?: string;
    liquidity_nexus?: string;
    master_pool?: string;
    master_pool_vault_a?: string;
    master_pool_vault_b?: string;
    // Layer 10 substep 2 — concentrated master pool BinArray PDA + SPRK/RWT
    // governance pool. The master pool now uses POOL_TYPE_CONCENTRATED (D40 +
    // SD-4); the bin array PDA is required for any subsequent add_liquidity /
    // swap CPI on it.
    master_pool_bin_array?: string;
    // CP-7 (2026-05-18) — Nexus-owned USDC ATA seeded by `grow_liquidity` to
    // populate the master pool's initial bid wall. Recorded for off-chain
    // observability + smoke-swap assertions; the canonical derivation is
    // `findAta(liquidity_nexus, usdc_test_mint)`.
    master_pool_nexus_usdc_ata?: string;
    // CP-7 (2026-05-18) — `PoolState.last_rebalance_nav_bin` after the
    // bootstrap's first `grow_liquidity` call. Diagnostic-only; the
    // pool-rebalancer bot reads this field directly from on-chain state.
    master_pool_last_rebalance_nav_bin?: string;
    sprk_rwt_pool?: string;
    sprk_rwt_pool_vault_a?: string;
    sprk_rwt_pool_vault_b?: string;
    // Layer 10 substep 2 — Crank wallet USDC ATA used by SPRK OT destinations
    // (10% Nexus-via-Crank slot per plan §74). This is an ATA owned by the
    // deployer keypair, NOT a separate crank wallet — devnet pseudo-multisig
    // pattern (D32). Mainnet runbook overrides this with a dedicated crank
    // bot wallet.
    crank_usdc_ata?: string;
  };
  ots?: OtRecord[];
  bots?: Record<
    string,
    {
      keypair_path: string;
      pubkey: string;
      lamports?: number;
    }
  >;
  /** Phases skipped because a precondition wasn't met (IDL stale, R20 pin pending). */
  init_skipped?: string[];
  /** Phases that attempted but threw at runtime — distinct from preconditioned skips
   *  so the Substep 13 harness can gate "didn't try" vs "tried and failed" differently. */
  init_failed?: { phase: string; error: string }[];
  init_completed_at?: string;
}

function loadArtifact(path: string): Artifact {
  if (!existsSync(path)) {
    throw new Error(`artifact not found: ${path}`);
  }
  const merged = JSON.parse(readFileSync(path, 'utf8')) as Artifact;

  // Sec M-2: re-merge secrets file (if present) into the in-memory artifact.
  // Older runs that wrote a single combined file still load cleanly because
  // the public file already carries every key — the secrets file is purely
  // additive on first split, then takes over on subsequent saves.
  const secretsPath = secretsPathFor(path);
  if (existsSync(secretsPath)) {
    const secrets = JSON.parse(readFileSync(secretsPath, 'utf8')) as SecretsFile;
    if (secrets.deployer_keypair_path && !merged.deployer_keypair_path) {
      merged.deployer_keypair_path = secrets.deployer_keypair_path;
    }
    if (secrets.mints) {
      merged.mints = { ...(merged.mints ?? {}), ...secrets.mints } as Artifact['mints'];
    }
    if (secrets.bots) {
      merged.bots = { ...(merged.bots ?? {}), ...secrets.bots };
    }
    if (secrets.ots && Array.isArray(merged.ots)) {
      merged.ots = merged.ots.map((rec) => {
        const sec = secrets.ots?.[rec.ot_mint];
        return sec ? { ...rec, ...sec } : rec;
      });
    }
  }
  return merged;
}

function saveArtifact(path: string, art: Artifact): void {
  // Always re-stamp the schema version on save so partially-written artifacts
  // from older script versions get re-tagged on the next run.
  art.schema_version = ARTIFACT_SCHEMA_VERSION;
  mkdirSync(dirname(path), { recursive: true });

  // ---------------------------------------------------------------------------
  // Sec M-2: split the artifact into a public file (no secrets) and a sibling
  // `.secrets.json` that holds keypair bytes + deployer path. Both files keep
  // 0o600 perms — the secrets file because it's a secret, the public file
  // because Substep 12 still embeds session-level state we don't want random
  // local users tampering with mid-bootstrap.
  // ---------------------------------------------------------------------------
  const secrets: SecretsFile = { schema_version: ARTIFACT_SCHEMA_VERSION };

  // Deployer keypair path — referenced by every consumer; safe to keep in the
  // public file IF the file path itself isn't sensitive. Bootstrap writes it
  // to a local `keys/` directory, so we keep it in BOTH for compatibility.
  if (art.deployer_keypair_path) {
    secrets.deployer_keypair_path = art.deployer_keypair_path;
  }

  // SD-32 fix: build a public-side serialization that strips secrets WITHOUT
  // mutating `art` in-memory. Prior to this fix, saveArtifact would
  // delete `*_keypair_b64` from `art.mints` (and `art.ots`) after writing the
  // public file. Subsequent phases that read `art.mints.rwt_mint_keypair_b64`
  // (e.g. phaseRwtVault's warm-restart path) would see undefined and
  // generate a fresh keypair, breaking the chain when verify-fresh-deploy.sh
  // pre-genned a keypair via stage_pregen_keypairs and bootstrap-init was
  // expected to reuse it.

  // Mint keypair bytes — copy to secrets, strip from public-only view.
  let publicMints: Artifact['mints'] | undefined = art.mints;
  if (art.mints) {
    publicMints = { ...art.mints };
    secrets.mints = {};
    for (const k of SECRET_MINT_KEYS) {
      const v = (publicMints as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.length > 0) {
        secrets.mints[k] = v;
        delete (publicMints as Record<string, unknown>)[k];
      }
    }
  }

  // OT mint keypair bytes — same pattern.
  let publicOts: Artifact['ots'] = art.ots;
  if (Array.isArray(art.ots)) {
    secrets.ots = {};
    publicOts = art.ots.map((rec) => {
      const copy = { ...rec };
      for (const k of SECRET_OT_KEYS) {
        const v = (copy as Record<string, unknown>)[k];
        if (typeof v === 'string' && v.length > 0) {
          (secrets.ots as Record<string, { ot_mint_keypair_b64: string }>)[rec.ot_mint] = {
            ot_mint_keypair_b64: v,
          };
          delete (copy as Record<string, unknown>)[k];
        }
      }
      return copy;
    });
  }

  // Bots — keypair paths land in BOTH files. The path itself is non-sensitive;
  // the keypair file at that path is. We mirror to keep the secrets file
  // self-contained.
  if (art.bots) {
    secrets.bots = art.bots;
  }

  const publicArt = { ...art, mints: publicMints, ots: publicOts };
  writeFileSync(path, JSON.stringify(publicArt, null, 2) + '\n', 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-POSIX filesystem — best-effort.
  }

  // Skip the secrets file entirely if we have nothing secret to store (e.g.
  // pre-init artifact with only programs[]). Avoids a confusing empty file.
  const hasSecrets =
    !!secrets.deployer_keypair_path ||
    Object.keys(secrets.mints ?? {}).length > 0 ||
    Object.keys(secrets.ots ?? {}).length > 0 ||
    Object.keys(secrets.bots ?? {}).length > 0;

  const secretsPath = secretsPathFor(path);
  if (hasSecrets) {
    writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + '\n', 'utf8');
    try {
      chmodSync(secretsPath, 0o600);
    } catch {
      // Best-effort.
    }
  }
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function keypairToB64(kp: Keypair): string {
  return Buffer.from(kp.secretKey).toString('base64');
}

function keypairFromB64(b64: string): Keypair {
  return Keypair.fromSecretKey(Buffer.from(b64, 'base64'));
}

// --------------------------------------------------------------------------
// PDA derivation (mirrors dashboard/src/lib/utils/pda.ts)
// --------------------------------------------------------------------------

function findPda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return findPda(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

// --------------------------------------------------------------------------
// SPL helpers (no-deps reimplementation of dashboard/src/lib/utils/spl.ts)
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
  // Simple confirmation poll (test-validator is fast; 60s ceiling).
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

async function createMintIxs(
  conn: Connection,
  payer: Keypair,
  mintKeypair: Keypair,
  decimals: number,
  authority: PublicKey,
): Promise<Transaction> {
  const lamports = await conn.getMinimumBalanceForRentExemption(82);

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mintKeypair.publicKey,
    lamports,
    space: 82,
    programId: TOKEN_PROGRAM_ID,
  });

  // InitializeMint2: [20, decimals(1), authority(32), 0(1)]
  const data = Buffer.alloc(67);
  data.writeUInt8(20, 0);
  data.writeUInt8(decimals, 1);
  authority.toBuffer().copy(data, 2);
  data.writeUInt8(0, 34);

  const initMintIx = new TransactionInstruction({
    keys: [{ pubkey: mintKeypair.publicKey, isSigner: false, isWritable: true }],
    programId: TOKEN_PROGRAM_ID,
    data,
  });

  return new Transaction().add(createAccountIx, initMintIx);
}

async function ensureMint(
  conn: Connection,
  payer: Keypair,
  decimals: number,
  existingKeypair?: Keypair,
): Promise<{ mint: PublicKey; keypair: Keypair; created: boolean }> {
  const kp = existingKeypair ?? Keypair.generate();
  const info = await conn.getAccountInfo(kp.publicKey);
  if (info) {
    return { mint: kp.publicKey, keypair: kp, created: false };
  }
  const tx = await createMintIxs(conn, payer, kp, decimals, payer.publicKey);
  await sendAndConfirm(conn, tx, [payer, kp]);
  return { mint: kp.publicKey, keypair: kp, created: true };
}

async function ensureAta(
  conn: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const ata = findAta(owner, mint);
  const info = await conn.getAccountInfo(ata);
  if (info) return ata;
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0),
  });
  await sendAndConfirm(conn, new Transaction().add(ix), [payer]);
  return ata;
}

async function mintTo(
  conn: Connection,
  authority: Keypair,
  mint: PublicKey,
  destination: PublicKey,
  amount: bigint,
): Promise<string> {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(amount, 1);
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
  return sendAndConfirm(conn, new Transaction().add(ix), [authority]);
}

async function getTokenBalance(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata);
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

/**
 * R-72 (Layer 10 closure): client-side LP-shares-min calculator for
 * non-empty pool re-seed. Replaces the SEC-26 ALLOW_NONEMPTY_POOL_RESEED
 * operator burden with a 1%-slippage min_shares floor computed from the
 * current pool reserves + total_lp_shares.
 *
 * Math (proportional):
 *   shares_for_a = floor(deposit_a * total_lp_shares / reserve_a)
 *   shares_for_b = floor(deposit_b * total_lp_shares / reserve_b)
 *   expected     = MIN(shares_for_a, shares_for_b)   // limiting side
 *   min_shares   = floor(expected * 99 / 100)         // 1% slippage
 *
 * For Concentrated pools the on-chain math distributes across bins;
 * the proportional formula above is a safety FLOOR (never exceeds the
 * actual mint), so passing it as min_shares prevents sandwich attacks
 * without breaking legitimate re-seeds. Returns 0n on first-add
 * (total_lp_shares == 0) — caller should already gate on vault_a == 0
 * for that branch.
 *
 * PoolState layout (see contracts/native-dex/src/state.rs lines 39-65):
 *   8   pool_type
 *   ...
 *   137 reserve_a       u64 LE
 *   145 reserve_b       u64 LE
 *   153 total_lp_shares u128 LE
 */
async function computeMinSharesForReseed(
  conn: Connection,
  poolPda: PublicKey,
  depositA: bigint,
  depositB: bigint,
): Promise<bigint> {
  const RESERVE_A_OFFSET = 137;
  const RESERVE_B_OFFSET = 145;
  const TOTAL_LP_SHARES_OFFSET = 153;
  const POOL_STATE_MIN_SIZE = TOTAL_LP_SHARES_OFFSET + 16;

  const info = await conn.getAccountInfo(poolPda);
  if (!info || info.data.length < POOL_STATE_MIN_SIZE) {
    return 0n;
  }
  const reserveA = info.data.readBigUInt64LE(RESERVE_A_OFFSET);
  const reserveB = info.data.readBigUInt64LE(RESERVE_B_OFFSET);
  // u128 LE = lower 8 bytes + upper 8 bytes << 64 (Buffer lacks readBigUInt128LE).
  const tsLow = info.data.readBigUInt64LE(TOTAL_LP_SHARES_OFFSET);
  const tsHigh = info.data.readBigUInt64LE(TOTAL_LP_SHARES_OFFSET + 8);
  const totalShares = tsLow + (tsHigh << 64n);

  if (totalShares === 0n || reserveA === 0n || reserveB === 0n) {
    // First-add territory — caller's branch should have set min_shares: 0
    // already; this returns 0 as a safe no-op.
    return 0n;
  }

  const sharesForA = (depositA * totalShares) / reserveA;
  const sharesForB = (depositB * totalShares) / reserveB;
  const expected = sharesForA < sharesForB ? sharesForA : sharesForB;
  // 1% slippage tolerance — generous, but the dress-rehearsal seed
  // proportions are hand-tuned so an immediate re-seed produces near-
  // identical shares unless the pool moved significantly between
  // verify-fresh-deploy.sh runs.
  return (expected * 99n) / 100n;
}

// --------------------------------------------------------------------------
// IDL loading
// --------------------------------------------------------------------------

// Loose IDL shape — the dashboard arlex-client validates the full schema at
// runtime; we only need name + instructions[].name for branch detection. The
// returned object is passed through to ArlexClient as `any` because the
// dashboard's `Idl` type is structurally-typed but stricter than what we
// declare here.
interface MinimalIdl {
  name: string;
  instructions: Array<{ name: string }>;
}

function loadIdl(name: string): MinimalIdl {
  // Phase 25 — IDL bundle moved out of dashboard's local lib into the
  // canonical `sdk/idl/` directory (mirrors the new @arlex/client import
  // layout). Dashboard still consumes those at build time but no longer
  // owns the source-of-truth copy.
  const path = join(REPO_ROOT, 'sdk', 'idl', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as MinimalIdl;
}

/**
 * Normalize an IDL for @arlex/client v0.3.x consumption.
 *
 * Why this exists: the new IDL format from `cargo build-sbf` / `arlex-cli`
 * uses Anchor-style `writable` / `signer` keys on instruction accounts,
 * AND silently drops both flags for accounts decorated with `init` (the
 * Anchor-style `init, payer = X` constraint implies writable+signer at
 * runtime, but the IDL emitter doesn't surface those). @arlex/client v0.3.1
 * reads `isMut` / `isSigner` directly off the raw account def — so we need
 * to (a) translate the new keys to the old ones and (b) re-derive the flags
 * for `init` accounts via a name allowlist owned by this script.
 *
 * The allowlist is hand-curated against the contract source (e.g.
 * `contracts/native-dex/src/instructions/initialize_dex.rs` shows
 * `dex_config` and `pool_creators` are `init, payer = deployer`). Bumping
 * the contracts requires re-auditing this list — doing it programmatically
 * would mean reading the .rs source which is out of scope for this driver.
 *
 * NOTE: this is a temporary patch for the Phase 25 transition until either
 * the IDL emitter is fixed or arlex-client gains a normalization step.
 */
type AccountFlagOverrides = Record<string, ReadonlyArray<string>>;
// Canonical mapping derived from `contracts/<prog>/src/instructions/*.rs` —
// every `#[account(init, ...)]` and `#[account(mut, ...)]` annotation whose
// `writable` flag the IDL emitter dropped (typically when the attribute
// block spans multiple lines or includes `seeds = [...]`).
//
// admin_mint_rwt and similar `mut`-annotated PDAs that the IDL marks as
// readonly are listed too — see `data/admin-mint-rwt.ts` for the original
// audit + workaround pattern.
// Programmatic audit (Phase 25, 2026-05-15): every `#[derive(Accounts)]`
// struct in `contracts/<prog>/src/instructions/*.rs` was diffed against its
// matching `sdk/idl/<prog>.json` instruction. Any account whose source has
// `init` / `init_if_needed` / `mut` / `close` but whose IDL has
// `isMut: false` is patched below. Account names are unique per IDL even
// when the instruction name collides across contracts (e.g.
// `propose_authority_transfer` exists in all 5 contracts but uses different
// PDA names), so a merged value-set is safe — `normalizeIdlForArlexClient`
// only flips bits for names actually present in each IDL's instruction.
const INIT_WRITABLE_OVERRIDES: AccountFlagOverrides = {
  // native-dex
  initialize_dex: ['dex_config', 'pool_creators'],
  update_dex_config: ['dex_config'],
  update_areal_fee_destination: ['dex_config'],
  update_pool_creators: ['pool_creators'],
  initialize_nexus: ['liquidity_nexus'],
  update_nexus_manager: ['liquidity_nexus'],
  // CP-7 Monotonic Ladder rebalancer ix (SDK 0.12.0 / contracts f4d393e).
  // pool_state + bin_array are `mut`; grow_liquidity additionally mutates
  // the Nexus PDA + Nexus USDC ATA + pool's USDC vault for the PDA-signed
  // SPL Transfer that funds the active-zone extension. compress_liquidity
  // is capital-neutral so only the pool state + bin array carry `mut`.
  grow_liquidity: ['pool_state', 'bin_array', 'liquidity_nexus', 'nexus_usdc_ata', 'pool_vault_b'],
  compress_liquidity: ['pool_state', 'bin_array'],
  // rwt-engine
  initialize_vault: ['rwt_vault', 'dist_config'],
  admin_mint_rwt: ['rwt_vault'],
  adjust_capital: ['rwt_vault'],
  update_vault_manager: ['rwt_vault'],
  // yield-distribution
  initialize_config: ['config'],
  initialize_liquidity_holding: ['liquidity_holding'],
  create_distributor: ['distributor', 'accumulator'],
  fund_distributor: ['distributor'],
  publish_root: ['distributor'],
  claim: ['distributor', 'claim_status'],
  close_distributor: ['distributor'],
  update_config: ['config'],
  update_publish_authority: ['config'],
  // ownership-token
  initialize_ot: ['ot_config', 'revenue_account', 'revenue_config', 'ot_governance', 'ot_treasury'],
  mint_ot: ['ot_config'],
  distribute_revenue: ['revenue_account'],
  batch_update_destinations: ['revenue_config'],
  // futarchy
  initialize_futarchy: ['config'],
  create_proposal: ['config'],
  // cross-contract — `propose_authority_transfer` exists in all 5 contracts,
  // `accept_authority_transfer` only loses its `mut` bit on ownership-token's
  // ot_governance; account-name uniqueness across IDLs makes the merge safe.
  propose_authority_transfer: ['dex_config', 'rwt_vault', 'config', 'ot_governance'],
  accept_authority_transfer: ['ot_governance'],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeIdlForArlexClient(idl: any): any {
  const out = JSON.parse(JSON.stringify(idl));
  for (const ix of out.instructions ?? []) {
    const initWritable = new Set(INIT_WRITABLE_OVERRIDES[ix.name] ?? []);
    for (const acc of ix.accounts ?? []) {
      // Translate new format → old format that arlex-client v0.3.1 reads.
      const writable = acc.writable ?? acc.isMut ?? false;
      const signer = acc.signer ?? acc.isSigner ?? false;
      acc.isMut = writable || initWritable.has(acc.name);
      acc.isSigner = signer;
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadIdlForClient(name: string): any {
  const path = join(REPO_ROOT, 'sdk', 'idl', `${name}.json`);
  return normalizeIdlForArlexClient(JSON.parse(readFileSync(path, 'utf8')));
}

function ixExists(idl: MinimalIdl, ixName: string): boolean {
  return idl.instructions.some((i) => i.name === ixName);
}

// --------------------------------------------------------------------------
// String helpers (mirror dashboard/src/lib/utils/format.ts)
// --------------------------------------------------------------------------

function stringToFixedBytes(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  const buf = Buffer.from(s, 'utf8');
  out.set(buf.subarray(0, Math.min(buf.length, len)), 0);
  return out;
}

// --------------------------------------------------------------------------
// Init phases
// --------------------------------------------------------------------------

async function phaseMints(conn: Connection, deployer: Keypair, art: Artifact): Promise<void> {
  log('phase-a', 'creating test mints (USDC + SPRK OT)');
  // SPRK is the canonical Ownership Token created at index 0 by phaseOts.
  // phase-a only seeds the mint keypair so phaseOts can reuse it via the
  // artifact's `mints.sprk_ot_mint_keypair_b64` field (idempotent across
  // warm restarts).

  // Reuse existing mints if artifact already has them (KEEP_LEDGER scenario).
  let usdcKp: Keypair;
  let usdcCreated = false;
  if (art.mints?.usdc_test_mint_keypair_b64) {
    usdcKp = keypairFromB64(art.mints.usdc_test_mint_keypair_b64);
    const info = await conn.getAccountInfo(usdcKp.publicKey);
    if (!info) {
      const r = await ensureMint(conn, deployer, 6, usdcKp);
      usdcCreated = r.created;
    }
  } else {
    const r = await ensureMint(conn, deployer, 6);
    usdcKp = r.keypair;
    usdcCreated = r.created;
  }
  log('phase-a', `usdc_test_mint=${usdcKp.publicKey.toBase58()}`, { created: usdcCreated });

  let otKp: Keypair;
  let otCreated = false;
  if (art.mints?.sprk_ot_mint_keypair_b64) {
    otKp = keypairFromB64(art.mints.sprk_ot_mint_keypair_b64);
    const info = await conn.getAccountInfo(otKp.publicKey);
    if (!info) {
      const r = await ensureMint(conn, deployer, 6, otKp);
      otCreated = r.created;
    }
  } else {
    const r = await ensureMint(conn, deployer, 6);
    otKp = r.keypair;
    otCreated = r.created;
  }
  log('phase-a', `sprk_ot_mint=${otKp.publicKey.toBase58()} (Sparkles)`, { created: otCreated });

  art.mints = {
    ...(art.mints ?? {}),
    usdc_test_mint: usdcKp.publicKey.toBase58(),
    usdc_test_mint_keypair_b64: keypairToB64(usdcKp),
    sprk_ot_mint: otKp.publicKey.toBase58(),
    sprk_ot_mint_keypair_b64: keypairToB64(otKp),
  };
}

async function phaseSingletons(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-b', 'initializing DEX + YD singletons');

  const dexProgramId = new PublicKey(art.programs.native_dex);
  const ydProgramId = new PublicKey(art.programs.yield_distribution);
  const dexIdl = loadIdl('native-dex');
  const ydIdl = loadIdl('yield-distribution');

  if (!art.mints?.usdc_test_mint) {
    throw new Error('phase-a must run first');
  }
  const usdcMint = new PublicKey(art.mints.usdc_test_mint);

  // Areal-fee ATA (USDC, owned by deployer) — used by both singletons.
  const arealFeeAta = await ensureAta(conn, deployer, usdcMint, deployer.publicKey);
  log('phase-b', `areal_fee_ata=${arealFeeAta.toBase58()}`);

  const [dexConfigPda] = findPda([Buffer.from('dex_config')], dexProgramId);
  const [poolCreatorsPda] = findPda([Buffer.from('pool_creators')], dexProgramId);
  const [ydDistConfigPda] = findPda([Buffer.from('dist_config')], ydProgramId);

  const skipped: string[] = art.init_skipped ?? [];

  // --- DEX initialize_dex ---
  const dexConfigInfo = await conn.getAccountInfo(dexConfigPda);
  if (dexConfigInfo) {
    log('phase-b', 'DEX::initialize_dex skip (already initialized)');
  } else if (!ixExists(dexIdl, 'initialize_dex')) {
    warn('phase-b', 'DEX IDL missing initialize_dex; skipping (regenerate IDL after Layer 9 build)');
    skipped.push('DEX::initialize_dex');
  } else {
    const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
    const tx = dexClient.buildTransaction('initialize_dex', {
      accounts: {
        deployer: deployer.publicKey,
        dex_config: dexConfigPda,
        pool_creators: poolCreatorsPda,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: {
        areal_fee_destination: Array.from(arealFeeAta.toBytes()),
        pause_authority: Array.from(deployer.publicKey.toBytes()),
        rebalancer: Array.from(deployer.publicKey.toBytes()),
      },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-b', `DEX::initialize_dex OK (config=${dexConfigPda.toBase58()})`);
  }

  // YD initialize_config moved to phaseYdConfig (runs AFTER phaseRwtVault).
  // YD's areal_fee_destination_account MUST be RWT-denominated per Layer 7
  // design (immutable after init); RWT mint doesn't exist yet at this phase.

  art.pdas = {
    ...(art.pdas ?? {} as NonNullable<Artifact['pdas']>),
    dex_config: dexConfigPda.toBase58(),
    pool_creators: poolCreatorsPda.toBase58(),
    yd_dist_config: ydDistConfigPda.toBase58(),
    rwt_vault: art.pdas?.rwt_vault ?? '',
    rwt_dist_config: art.pdas?.rwt_dist_config ?? '',
    rwt_capital_accumulator_ata: art.pdas?.rwt_capital_accumulator_ata ?? '',
    areal_fee_ata: arealFeeAta.toBase58(),
  };
  art.init_skipped = skipped;
}

async function phaseRwtVault(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-c', 'initializing RWT vault (creates RWT mint)');

  const rwtProgramId = new PublicKey(art.programs.rwt_engine);
  const rwtIdl = loadIdl('rwt-engine');
  const usdcMint = new PublicKey(art.mints!.usdc_test_mint);
  const arealFeeAta = new PublicKey(art.pdas!.areal_fee_ata);

  const [vaultPda] = findPda([Buffer.from('rwt_vault')], rwtProgramId);
  const [distConfigPda] = findPda([Buffer.from('dist_config_rwt')], rwtProgramId);
  const skipped = art.init_skipped ?? [];

  const existing = await conn.getAccountInfo(vaultPda);
  if (existing) {
    // Read RWT mint from vault data layout (offset 72..104 per dashboard runner).
    const rwtMint = new PublicKey(existing.data.subarray(72, 104));
    const capAta = findAta(vaultPda, usdcMint);
    log('phase-c', `RWT::initialize_vault skip (rwt_mint=${rwtMint.toBase58()})`);
    art.pdas = {
      ...art.pdas!,
      rwt_vault: vaultPda.toBase58(),
      rwt_dist_config: distConfigPda.toBase58(),
      rwt_capital_accumulator_ata: capAta.toBase58(),
    };
    art.mints = {
      ...art.mints!,
      rwt_mint: rwtMint.toBase58(),
      rwt_mint_keypair_b64: art.mints?.rwt_mint_keypair_b64 ?? '',
    };
    return;
  }

  if (!ixExists(rwtIdl, 'initialize_vault')) {
    warn('phase-c', 'RWT IDL missing initialize_vault; skipping');
    skipped.push('RWT::initialize_vault');
    art.init_skipped = skipped;
    return;
  }

  // Reuse RWT mint kp from artifact if present (warm restart support). On a
  // fresh deploy, retry generation until the RWT mint sorts BEFORE the USDC
  // test mint in canonical lex order — i.e. `rwt < usdc` byte-wise. The
  // master pool's `create_concentrated_pool` orders `vault_a / vault_b` by
  // `mint_a < mint_b`, so this constraint pins USDC to side B. Pinning
  // matters for `grow_liquidity` (CP-7 Pool Rebalancer): the on-chain handler
  // hardcodes `pool_vault_b` as the Nexus-drain destination, so USDC MUST
  // live on `vault_b`. Mainnet satisfies this automatically (RWT_MINT vanity
  // bytes start with `0x5d…` < USDC mainnet `EPjF…` ≈ `0xc6…`); on
  // test-validator the random RWT mint can land either side of USDC unless
  // we constrain it here.
  let rwtMintKp: Keypair;
  if (art.mints?.rwt_mint_keypair_b64) {
    rwtMintKp = keypairFromB64(art.mints.rwt_mint_keypair_b64);
  } else {
    const usdcBytes = usdcMint.toBuffer();
    let attempts = 0;
    do {
      rwtMintKp = Keypair.generate();
      attempts++;
      if (attempts > 200) {
        // Astronomically unlikely (≈ 2^-200 probability). Defensive cap so
        // a degenerate RNG can't spin forever.
        throw new Error(
          `phase-c: failed to generate RWT mint with rwt < usdc after ${attempts} attempts`,
        );
      }
    } while (rwtMintKp.publicKey.toBuffer().compare(usdcBytes) >= 0);
    log(
      'phase-c',
      `RWT mint generated with canonical order rwt < usdc (${attempts} attempt${attempts > 1 ? 's' : ''})`,
    );
  }
  const capAta = findAta(vaultPda, usdcMint);

  const rwtClient = new ArlexClient(loadIdlForClient('rwt-engine'), rwtProgramId, conn);
  const tx = rwtClient.buildTransaction('initialize_vault', {
    accounts: {
      deployer: deployer.publicKey,
      rwt_vault: vaultPda,
      dist_config: distConfigPda,
      rwt_mint: rwtMintKp.publicKey,
      usdc_mint: usdcMint,
      capital_accumulator_ata: capAta,
      areal_fee_destination_account: arealFeeAta,
      token_program: TOKEN_PROGRAM_ID,
      system_program: SYSTEM_PROGRAM_ID,
      ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    },
    args: {
      initial_authority: Array.from(deployer.publicKey.toBytes()),
      pause_authority: Array.from(deployer.publicKey.toBytes()),
      liquidity_destination: Array.from(deployer.publicKey.toBytes()),
      protocol_revenue_destination: Array.from(deployer.publicKey.toBytes()),
    },
    computeUnits: 300_000,
  });
  await sendAndConfirm(conn, tx, [deployer, rwtMintKp]);
  log('phase-c', `RWT::initialize_vault OK (vault=${vaultPda.toBase58()}, rwt=${rwtMintKp.publicKey.toBase58()})`);

  art.pdas = {
    ...art.pdas!,
    rwt_vault: vaultPda.toBase58(),
    rwt_dist_config: distConfigPda.toBase58(),
    rwt_capital_accumulator_ata: capAta.toBase58(),
  };
  art.mints = {
    ...art.mints!,
    rwt_mint: rwtMintKp.publicKey.toBase58(),
    rwt_mint_keypair_b64: keypairToB64(rwtMintKp),
  };
}

async function phaseYdConfig(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-c2', 'initializing YD config (deferred — needs RWT mint for fee_destination)');

  const ydProgramId = new PublicKey(art.programs.yield_distribution);
  const ydIdl = loadIdl('yield-distribution');
  const skipped: string[] = art.init_skipped ?? [];

  if (!art.mints?.rwt_mint) {
    warn('phase-c2', 'rwt_mint not set; cannot init YD config');
    skipped.push('YD::initialize_config (no rwt_mint)');
    art.init_skipped = skipped;
    return;
  }
  const rwtMint = new PublicKey(art.mints.rwt_mint);
  const [ydDistConfigPda] = findPda([Buffer.from('dist_config')], ydProgramId);

  // Per Layer 7 design (and convert_to_rwt fee_account constraint), the YD
  // areal_fee_destination_account MUST be RWT-denominated and the value is
  // immutable after init. Create deployer's RWT ATA upfront — it serves
  // BOTH the YD::initialize_config call below AND the DEX
  // `areal_fee_destination` rotation at the end of this phase. Computing it
  // before the "already initialized" gate is critical: a warm validator with
  // a pre-existing YD config (e.g. VPS chain) must still drop through to
  // the DEX rotation block, otherwise every swap reverts with
  // `InvalidProtocolFeeDestination` (0x178e).
  // It will later be rotated to a multisig-owned ATA in mainnet bootstrap
  // (out of scope).
  const rwtArealFeeAta = await ensureAta(conn, deployer, rwtMint, deployer.publicKey);
  log('phase-c2', `yd_areal_fee_ata (RWT)=${rwtArealFeeAta.toBase58()}`);

  const ydConfigInfo = await conn.getAccountInfo(ydDistConfigPda);
  if (ydConfigInfo) {
    log('phase-c2', 'YD::initialize_config skip (already initialized)');
  } else if (!ixExists(ydIdl, 'initialize_config')) {
    warn('phase-c2', 'YD IDL missing initialize_config; skipping');
    skipped.push('YD::initialize_config');
  } else {
    const ydClient = new ArlexClient(loadIdlForClient('yield-distribution'), ydProgramId, conn);
    const tx = ydClient.buildTransaction('initialize_config', {
      accounts: {
        deployer: deployer.publicKey,
        config: ydDistConfigPda,
        areal_fee_destination_account: rwtArealFeeAta,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: {
        publish_authority: Array.from(deployer.publicKey.toBytes()),
        protocol_fee_bps: 25,
        min_distribution_amount: 1_000_000,
      },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-c2', `YD::initialize_config OK (config=${ydDistConfigPda.toBase58()})`);
  }

  // ---------------------------------------------------------------------
  // Rotate DexConfig.areal_fee_destination to the RWT-denominated ATA.
  //
  // Why here: `initialize_dex` runs before `phaseRwtVault`, so at init time
  // the RWT mint doesn't exist and bootstrap is forced to seed
  // `areal_fee_destination` with the USDC ATA. The DEX swap/zap_liquidity
  // paths validate `read_token_account_mint(areal_fee_account) == RWT_MINT`
  // (contracts/native-dex/src/instructions/swap.rs:198, zap_liquidity.rs:201;
  // docs/contracts/native-dex.mdx §71 — "All fees are charged on top of the
  // swap amount in RWT"). Without rotation, every swap reverts with
  // `InvalidProtocolFeeDestination` (0x178e).
  //
  // The `update_areal_fee_destination` instruction re-asserts the mint check
  // (see contracts/native-dex/src/instructions/update_areal_fee_destination.rs)
  // so the stored value is always an RWT ATA after this point. Idempotent:
  // we only call it when the current stored value differs.
  // ---------------------------------------------------------------------
  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexIdl = loadIdl('native-dex');
  const [dexConfigPda] = findPda([Buffer.from('dex_config')], dexProgramId);
  if (!ixExists(dexIdl, 'update_areal_fee_destination')) {
    warn(
      'phase-c2',
      'native-dex IDL missing update_areal_fee_destination; cannot rotate ' +
        'DexConfig.areal_fee_destination to RWT ATA (swap will revert with ' +
        'InvalidProtocolFeeDestination until the contract is rebuilt).',
    );
    skipped.push('DEX::update_areal_fee_destination (IDL missing)');
  } else {
    const dexConfigInfo = await conn.getAccountInfo(dexConfigPda);
    if (!dexConfigInfo) {
      warn('phase-c2', 'dex_config not initialized; skipping fee-destination rotation');
      skipped.push('DEX::update_areal_fee_destination (dex_config missing)');
    } else {
      // DexConfig layout offset for `areal_fee_destination`:
      //   8  (disc) + 32 (authority) + 32 (pending_authority) + 1 (has_pending)
      // + 32 (pause_authority) + 2 (base_fee_bps) + 2 (lp_fee_share_bps) = 109
      // SDK accounts.generated.ts confirms the field is at packed offset 101
      // post-discriminator → 109 absolute.
      const stored = new PublicKey(dexConfigInfo.data.subarray(109, 109 + 32));
      if (stored.equals(rwtArealFeeAta)) {
        log('phase-c2', 'DEX::update_areal_fee_destination skip (already RWT ATA)');
      } else {
        const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
        const rotateTx = dexClient.buildTransaction('update_areal_fee_destination', {
          accounts: {
            authority: deployer.publicKey,
            dex_config: dexConfigPda,
            new_areal_fee_account: rwtArealFeeAta,
          },
          args: {},
        });
        await sendAndConfirm(conn, rotateTx, [deployer]);
        log(
          'phase-c2',
          `DEX::update_areal_fee_destination OK ` +
            `(old=${stored.toBase58()} new=${rwtArealFeeAta.toBase58()})`,
        );
      }
    }
  }

  // Expose the RWT ATA on the artifact so smoke-swap, scripted swap helpers,
  // and any future LP-side helper can derive the correct DEX fee account
  // without recomputing it. `areal_fee_ata` (USDC) stays untouched because
  // OT::distribute_revenue (USDC-denominated) still depends on it.
  art.pdas = {
    ...art.pdas!,
    areal_fee_ata_rwt: rwtArealFeeAta.toBase58(),
  };

  art.init_skipped = skipped;
}

async function phaseLiquidityHolding(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-d', 'initializing YD LiquidityHolding (best-effort — pinned RWT_MINT match)');

  const ydProgramId = new PublicKey(art.programs.yield_distribution);
  const ydIdl = loadIdl('yield-distribution');
  const skipped = art.init_skipped ?? [];

  if (!ixExists(ydIdl, 'initialize_liquidity_holding')) {
    warn('phase-d', 'YD IDL missing initialize_liquidity_holding; skipping (regenerate IDL after Layer 8 build)');
    skipped.push('YD::initialize_liquidity_holding');
    art.init_skipped = skipped;
    return;
  }

  if (!art.mints?.rwt_mint) {
    warn('phase-d', 'rwt_mint not set; skipping LiquidityHolding init');
    skipped.push('YD::initialize_liquidity_holding (no rwt_mint)');
    art.init_skipped = skipped;
    return;
  }

  const rwtMint = new PublicKey(art.mints.rwt_mint);
  const [holdingPda] = findPda([Buffer.from('liq_holding')], ydProgramId);
  const holdingAta = findAta(holdingPda, rwtMint);

  const existing = await conn.getAccountInfo(holdingPda);
  if (existing) {
    log('phase-d', `YD::initialize_liquidity_holding skip (already initialized)`);
    art.pdas = {
      ...art.pdas!,
      liquidity_holding: holdingPda.toBase58(),
      liquidity_holding_ata: holdingAta.toBase58(),
    };
    return;
  }

  // Best-effort: YD pins RWT_MINT in constants.rs at compile time. If the
  // freshly created RWT mint doesn't match the pinned bytes, the program will
  // reject with InvalidTokenAccount. We try, and on failure log + skip to keep
  // bootstrap moving. Operator must run the R20 migration runbook (rebuild YD
  // with the canonical RWT mint pinned) for a clean init.
  try {
    const ydClient = new ArlexClient(loadIdlForClient('yield-distribution'), ydProgramId, conn);
    const tx = ydClient.buildTransaction('initialize_liquidity_holding', {
      accounts: {
        payer: deployer.publicKey,
        liquidity_holding: holdingPda,
        rwt_mint: rwtMint,
        liquidity_holding_ata: holdingAta,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
        ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      },
      args: {},
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-d', `YD::initialize_liquidity_holding OK (pda=${holdingPda.toBase58()})`);
    art.pdas = {
      ...art.pdas!,
      liquidity_holding: holdingPda.toBase58(),
      liquidity_holding_ata: holdingAta.toBase58(),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-d', `initialize_liquidity_holding failed (likely RWT_MINT pin mismatch — see R20 runbook): ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    // tester M-3 — runtime failure (NOT a precondition skip). Substep 13
    // E2E gating logic must distinguish "didn't try" from "tried + reverted".
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'YD::initialize_liquidity_holding', error: head });
    art.init_failed = failed;
  }
}

async function phaseNexus(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-e', 'initializing DEX LiquidityNexus (Layer 10 — required)');

  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexIdl = loadIdl('native-dex');

  // Layer 10 Substep 1 — R57 closure (2026-04-27): the dashboard IDL was
  // regenerated to include the 9 Nexus instructions, so the previous
  // best-effort `ixExists` skip is gone. If `initialize_nexus` is still
  // missing here, the IDL on disk is stale — fail LOUDLY rather than
  // silently recording a skip and letting downstream phases run against a
  // half-bootstrapped Nexus.
  if (!ixExists(dexIdl, 'initialize_nexus')) {
    throw new Error(
      'DEX IDL missing initialize_nexus — IDL regeneration (R57) is incomplete. ' +
        'Re-run `arlex-cli idl native-dex` and rebuild the dashboard before ' +
        'continuing the bootstrap.',
    );
  }

  const [nexusPda] = findPda([Buffer.from('liquidity_nexus')], dexProgramId);
  const dexConfigPda = new PublicKey(art.pdas!.dex_config);

  const existing = await conn.getAccountInfo(nexusPda);
  if (existing) {
    log('phase-e', 'DEX::initialize_nexus skip (already initialized)');
    art.pdas = { ...art.pdas!, liquidity_nexus: nexusPda.toBase58() };
    return;
  }

  try {
    const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
    const tx = dexClient.buildTransaction('initialize_nexus', {
      accounts: {
        authority: deployer.publicKey,
        dex_config: dexConfigPda,
        liquidity_nexus: nexusPda,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: {
        manager: Array.from(deployer.publicKey.toBytes()),
      },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-e', `DEX::initialize_nexus OK (nexus=${nexusPda.toBase58()})`);
    art.pdas = { ...art.pdas!, liquidity_nexus: nexusPda.toBase58() };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-e', `initialize_nexus failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    // tester M-3 — runtime failure recorded distinctly from precondition skip.
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'DEX::initialize_nexus', error: head });
    art.init_failed = failed;
  }
}

// Layer 10 substep 2 — pool seed + SPRK bootstrap constants.
//
// The plan (§Phase 4) calls for a concentrated RWT/USDC pool with balanced
// seed liquidity. We pick 10_000 USDC + 10_000 RWT (10_000_000_000 base units
// at 6 decimals) as the canonical devnet seed — matches the layer-10 plan note
// "10_000 USDC + equivalent RWT" and gives Scenario 1/4/5 enough depth to
// exercise multi-bin swaps without dust artifacts.
//
// SEC-25 — every seed amount is env-overridable for the mainnet runbook. The
// helper accepts a base-unit bigint string and rejects non-positive values or
// anything > 1e15 (sanity ceiling: 1e15 base units == 1e9 tokens at 6 dec).
function parseSeedAmount(envName: string, fallback: bigint): bigint {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  let v: bigint;
  try {
    v = BigInt(raw);
  } catch {
    throw new Error(`bootstrap-init: ${envName}="${raw}" is not a valid integer`);
  }
  if (v <= 0n || v >= 1_000_000_000_000_000n) {
    throw new Error(
      `bootstrap-init: ${envName}=${v.toString()} out of range (0 < x < 1e15)`,
    );
  }
  return v;
}

const MASTER_POOL_SEED_USDC: bigint = parseSeedAmount(
  'MASTER_POOL_SEED_USDC_BASE',
  10_000_000_000n,
);
const MASTER_POOL_SEED_RWT: bigint = parseSeedAmount(
  'MASTER_POOL_SEED_RWT_BASE',
  10_000_000_000n,
);

// Initial USDC parked in the Nexus accumulator for the master pool's first
// `grow_liquidity` call (CP-7). The on-chain handler drains the full
// accumulator into `pool_vault_b` and redistributes it across the 40-bin
// active zone using geometric weights (r = 0.85). 100 USDC (= 100_000_000
// base units at 6 decimals) is plenty for Smoke 4 (RWT→USDC bin-walk
// consumes microUSDC-scale amounts per bin).
const MASTER_POOL_NEXUS_SEED_USDC: bigint = parseSeedAmount(
  'MASTER_POOL_NEXUS_SEED_USDC_BASE',
  100_000_000n,
);

// SPRK/RWT governance pool seed: smaller than master pool (governance pair sees
// far less volume than the protocol's main RWT/USDC pair). 1_000 RWT + 1_000
// SPRK OT — balanced 50/50 split per plan §Phase 4 step 4.
const SPRK_RWT_POOL_SEED_RWT: bigint = parseSeedAmount(
  'SPRK_RWT_POOL_SEED_RWT_BASE',
  1_000_000_000n,
);
const SPRK_RWT_POOL_SEED_SPRK: bigint = parseSeedAmount(
  'SPRK_RWT_POOL_SEED_SPRK_BASE',
  1_000_000_000n,
);

// SPRK OT bootstrap constants. Hoisted above phaseOts so phaseOts can specialize
// the SPRK OT distributor with the 365-day vesting period required by plan §70
// (the rest of the test OTs use the 1-day default).
const SPRK_OT_INDEX = 0; // First test OT becomes the SPRK (Sparkles) governance token.
const SPRK_VESTING_PERIOD_SECS = 31_536_000; // 365 days per plan §70.
const DEFAULT_OT_VESTING_PERIOD_SECS = 86_400; // 1 day for extra non-SPRK test OTs.
const SPRK_INITIAL_SUPPLY: bigint = parseSeedAmount(
  'SPRK_INITIAL_SUPPLY_BASE',
  1_000_000_000_000n, // 1_000_000 SPRK @ 6 decimals.
);

// Concentrated pool parameters per layer-10 plan §86: bin_step=10 (0.1%),
// initial_active_bin=0. With MAX_BINS=70 and lower_bin = active - 35, the pool
// covers bins -35..+34 around the initial price.
const MASTER_POOL_BIN_STEP_BPS = 10;
const MASTER_POOL_INITIAL_ACTIVE_BIN = 0;
// CP-4 (contracts f4d393e) — required 3rd arg for create_concentrated_pool.
// 500 bps places `left_anchor_bin = initial_active_bin − 50` (with
// bin_step_bps=10). This leaves room for the Pool Rebalancer's first
// `grow_liquidity` call: with `new_nav_bin = initial_active_bin + 1 = 1`
// and `ACTIVE_ZONE_WIDTH = 40` the new active zone spans bins [−38..1].
// `grow_redistribute` rejects with `ActiveZoneOverlapsTail` when
// `new_zone_lower < left_anchor_bin`, so we need `left_anchor_bin ≤ −38`,
// i.e. `permanent_tail_offset_bps ≥ 390`. 500 gives 12 bins of headroom.
// Minimum floor enforced on-chain is MIN_PERMANENT_TAIL_OFFSET_BPS = 30.
const MASTER_POOL_PERMANENT_TAIL_OFFSET_BPS = 500;

async function phaseMasterPool(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-f', 'creating master RWT/USDC concentrated pool + seeding liquidity');

  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexIdl = loadIdl('native-dex');
  const skipped = art.init_skipped ?? [];

  if (!art.mints?.rwt_mint || !art.mints?.usdc_test_mint) {
    warn('phase-f', 'rwt_mint or usdc_test_mint missing; skipping master pool');
    skipped.push('DEX::create_concentrated_pool master (mints missing)');
    art.init_skipped = skipped;
    return;
  }

  const usdcMint = new PublicKey(art.mints.usdc_test_mint);
  const rwtMint = new PublicKey(art.mints.rwt_mint);

  // Canonical pool order: a < b
  const [tokenA, tokenB] = usdcMint.toBuffer().compare(rwtMint.toBuffer()) < 0
    ? [usdcMint, rwtMint]
    : [rwtMint, usdcMint];

  const [poolPda] = findPda(
    [Buffer.from('pool'), tokenA.toBuffer(), tokenB.toBuffer()],
    dexProgramId,
  );
  const [binArrayPda] = findPda(
    [Buffer.from('bins'), poolPda.toBuffer()],
    dexProgramId,
  );
  const dexConfigPda = new PublicKey(art.pdas!.dex_config);
  const poolCreatorsPda = new PublicKey(art.pdas!.pool_creators);

  // pool_creators must contain the deployer; phaseDeployerPoolCreator (called
  // before this phase) handles the whitelist update. Re-running is idempotent.
  await ensureDeployerPoolCreator(conn, deployer, art);

  const existing = await conn.getAccountInfo(poolPda);
  let vaultA: PublicKey;
  let vaultB: PublicKey;
  let isConcentrated = false;

  if (existing) {
    // PoolState layout per dashboard:
    //   8 disc + 1 pool_type + 32 mint_a + 32 mint_b + 32 vault_a + 32 vault_b + ...
    const poolType = existing.data.readUInt8(8);
    isConcentrated = poolType === 1; // POOL_TYPE_CONCENTRATED
    vaultA = new PublicKey(existing.data.subarray(73, 105));
    vaultB = new PublicKey(existing.data.subarray(105, 137));
    log(
      'phase-f',
      `master pool already exists (pool_type=${poolType}, expected concentrated=1)`,
    );
    if (!isConcentrated) {
      // Pre-Layer-10 bootstrap created a StandardCurve master pool; the same
      // PDA cannot host both types simultaneously. Operator must restart from
      // a fresh ledger to pick up the Layer 10 concentrated master pool
      // (D6 + D36 — fresh-deploy is the canonical path).
      warn(
        'phase-f',
        'master pool exists as StandardCurve but Layer 10 expects concentrated; ' +
          'restart with KEEP_LEDGER=0 to migrate (D6 + SD-4)',
      );
      skipped.push('DEX::create_concentrated_pool master (pre-existing StandardCurve)');
    }
  } else {
    if (!ixExists(dexIdl, 'create_concentrated_pool')) {
      warn('phase-f', 'DEX IDL missing create_concentrated_pool; skipping');
      skipped.push('DEX::create_concentrated_pool master');
      art.init_skipped = skipped;
      return;
    }
    const vaultAKp = Keypair.generate();
    const vaultBKp = Keypair.generate();

    const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
    const tx = dexClient.buildTransaction('create_concentrated_pool', {
      accounts: {
        creator: deployer.publicKey,
        dex_config: dexConfigPda,
        pool_creators: poolCreatorsPda,
        pool_state: poolPda,
        bin_array: binArrayPda,
        token_a_mint: tokenA,
        token_b_mint: tokenB,
        vault_a: vaultAKp.publicKey,
        vault_b: vaultBKp.publicKey,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: {
        bin_step_bps: MASTER_POOL_BIN_STEP_BPS,
        initial_active_bin: MASTER_POOL_INITIAL_ACTIVE_BIN,
        permanent_tail_offset_bps: MASTER_POOL_PERMANENT_TAIL_OFFSET_BPS,
      },
      computeUnits: 300_000,
    });
    try {
      await sendAndConfirm(conn, tx, [deployer, vaultAKp, vaultBKp]);
      vaultA = vaultAKp.publicKey;
      vaultB = vaultBKp.publicKey;
      isConcentrated = true;
      log(
        'phase-f',
        `master concentrated pool created (pool=${poolPda.toBase58()}, bin_step=${MASTER_POOL_BIN_STEP_BPS}, initial_bin=${MASTER_POOL_INITIAL_ACTIVE_BIN})`,
      );
    } catch (e: unknown) {
      // Mirrors phase-d's RWT_MINT pin handling: the on-chain DEX program
      // hardcodes the canonical RWT_MINT constant (compile-time pinning via
      // R20). If the runtime mint we just created in phase-c doesn't match
      // those embedded bytes, `create_concentrated_pool` fails the
      // "Neither token is RWT_MINT" guard. Operators bootstrapping a fresh
      // ledger against pre-built program binaries hit this; the recovery
      // is the R20 migration path. Surface a warn + skip so the rest of
      // the driver (LiquidityNexus, OT setup, etc.) still runs and the
      // backend indexer picks up the prior phases' transactions.
      const msg = e instanceof Error ? e.message : String(e);
      warn(
        'phase-f',
        `create_concentrated_pool failed (likely RWT_MINT pin mismatch — see R20 runbook): ${msg}`,
      );
      skipped.push('DEX::create_concentrated_pool master (rwt_mint pin mismatch)');
      art.init_skipped = skipped;
      // Without the master pool, vaultA/vaultB never settle — there's no
      // useful artifact to record below. Return early.
      return;
    }
  }

  art.pdas = {
    ...art.pdas!,
    master_pool: poolPda.toBase58(),
    master_pool_vault_a: vaultA.toBase58(),
    master_pool_vault_b: vaultB.toBase58(),
    master_pool_bin_array: binArrayPda.toBase58(),
  };

  // Seed liquidity only if pool is concentrated AND not yet seeded. If a
  // pre-existing StandardCurve pool blocks the upgrade, leave it alone — the
  // skip warning above is the operator's signal.
  if (!isConcentrated) {
    art.init_skipped = skipped;
    return;
  }

  // Master pool USDC vault must be `vault_b` — `grow_liquidity` hardcodes
  // `pool_vault_b` as the Nexus-drain destination (CP-7), and the canonical
  // master pool layout pins RWT to side A / USDC to side B. `phaseRwtVault`
  // enforces `rwt < usdc` byte-wise so this invariant holds on test-validator;
  // mainnet satisfies it via the pinned `RWT_MINT` vanity bytes vs
  // `EPjFW…` USDC mint. If somehow this ever flipped, surface a loud skip
  // rather than silently corrupting downstream Smoke 4 (RWT→USDC bin-walk).
  if (!tokenB.equals(usdcMint)) {
    warn(
      'phase-f',
      `USDC mint is on side A (canonical order broke); skipping bid-wall seed. ` +
        `Expected tokenB == USDC (usdc=${usdcMint.toBase58()}, rwt=${rwtMint.toBase58()})`,
    );
    skipped.push('DEX::grow_liquidity master seed (USDC on side A)');
    art.init_skipped = skipped;
    return;
  }

  // Bid wall seed via the canonical CP-7 Pool Rebalancer path:
  //   1. Top up Nexus USDC accumulator from deployer.
  //   2. Call `grow_liquidity(new_nav_bin = initial_active_bin + 1,
  //      active_zone_width = ACTIVE_ZONE_WIDTH)` so the on-chain handler
  //      drains the accumulator into `pool_vault_b` and redistributes it
  //      across the 40-bin active zone (geometric density, r = 0.85).
  //
  // The deployer signs `grow_liquidity` — at this point in the bootstrap
  // `dex_config.rebalancer == deployer.publicKey` (set in `phaseSingletons`).
  // `phaseRegisterBots` later rotates the slot to the pool-rebalancer bot
  // keypair, but that runs after `phaseMasterPool` so the deployer is still
  // the rebalancer here.
  //
  // The legacy `add_liquidity` path was blocked by the CP-5 user-LP guard
  // (`MasterPoolUserLpDisabled` — master pools forbid direct LP adds; only
  // the Nexus-mediated growth/compress flow may seed them).

  // Create deployer RWT ATA — admin_mint_rwt below funds it so
  // `smoke-swap.ts::fundUserToken` can Transfer 100 RWT to the user wallet
  // (RWT mint authority is the vault PDA, not the deployer, so user funding
  // happens via Transfer from a pre-seeded deployer ATA). Without this the
  // RWT-input smokes skip.
  const deployerRwtAta = await ensureAta(conn, deployer, rwtMint, deployer.publicKey);

  // 1a. Admin-mint RWT to deployer so downstream smokes can Transfer-fund
  // their user wallets with RWT (RWT mint authority is the vault PDA, not
  // deployer, so a direct MintTo is impossible). Best-effort — Smoke 4 only
  // depends on the bid-wall seed itself; RWT-side balance gating lives in
  // smoke-swap.
  const rwtIdl = loadIdl('rwt-engine');
  const rwtVaultPda = new PublicKey(art.pdas!.rwt_vault);
  if (ixExists(rwtIdl, 'admin_mint_rwt')) {
    const rwtBal = await getTokenBalance(conn, deployerRwtAta);
    if (rwtBal < MASTER_POOL_SEED_RWT) {
      try {
        const rwtClient = new ArlexClient(
          loadIdlForClient('rwt-engine'),
          new PublicKey(art.programs.rwt_engine),
          conn,
        );
        const need = MASTER_POOL_SEED_RWT - rwtBal;
        // INVARIANT (NAV = $1.0): `admin_mint_rwt` adds `rwt_amount` to
        // `total_rwt_supply` and `backing_capital_usd` to
        // `total_invested_capital`. NAV = capital * NAV_SCALE / supply.
        // Both args use 6-decimal raw units (USDC + RWT both have 6 decimals),
        // so passing the same value keeps NAV at the bootstrap target $1.0.
        // See docs/economics/rwt-real-world-token.mdx and
        // contracts/rwt-engine/src/nav.rs::calculate_nav.
        const adminTx = rwtClient.buildTransaction('admin_mint_rwt', {
          accounts: {
            authority: deployer.publicKey,
            rwt_vault: rwtVaultPda,
            rwt_mint: rwtMint,
            recipient_rwt: deployerRwtAta,
            token_program: TOKEN_PROGRAM_ID,
          },
          args: {
            rwt_amount: Number(need),
            backing_capital_usd: Number(need),
          },
        });
        await sendAndConfirm(conn, adminTx, [deployer]);
        log(
          'phase-f',
          `admin_mint_rwt: minted ${need.toString()} RWT + ${need.toString()} raw USDC capital (NAV=$1.0)`,
        );
      } catch (e: unknown) {
        // Non-fatal: smoke-swap will surface as RWT-funding skip downstream.
        warn(
          'phase-f',
          `admin_mint_rwt failed (RWT-side user funding will skip): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } else {
    warn('phase-f', 'RWT IDL missing admin_mint_rwt; RWT-side smokes will skip');
  }

  // 1b. Ensure Nexus PDA + USDC accumulator ATA exist + are funded. Derive
  // the Nexus PDA from program ID rather than reading the artifact field so
  // we don't depend on `phaseNexus` already having populated it (the artifact
  // value is informational; the canonical source of truth is the
  // `[b"liquidity_nexus"]` seed against the DEX program ID).
  const [nexusPda] = findPda([Buffer.from('liquidity_nexus')], dexProgramId);
  const nexusUsdcAta = findAta(nexusPda, usdcMint);
  // Create the Nexus-owned USDC ATA idempotently. `ensureAta` derives the
  // canonical ATA and skips if already present. The Nexus PDA owns the ATA
  // at the SPL Token level — exactly what `grow_liquidity`'s on-chain
  // `read_token_account_owner(nexus_usdc_ata) == nexus_addr` gate requires.
  await ensureAta(conn, deployer, usdcMint, nexusPda);

  const nexusBalance = await getTokenBalance(conn, nexusUsdcAta);
  if (nexusBalance < MASTER_POOL_NEXUS_SEED_USDC) {
    const need = MASTER_POOL_NEXUS_SEED_USDC - nexusBalance;
    // Deployer is the USDC test mint authority (`phaseMints::ensureMint`),
    // so a direct MintTo into the Nexus ATA is the cheapest path. The
    // canonical alternative — `nexus_deposit` — would bump the on-chain
    // `total_deposited_usdc` counter, but its mint-pin check (`expected_mint
    // == USDC_MINT` where `USDC_MINT = [0u8; 32]` on test-validator)
    // reverts with `InvalidNexusToken` on every devnet/local run, so it
    // can't be used here without a parallel placeholder-aware fix. MintTo
    // is safe because the counter is only load-bearing for
    // `nexus_withdraw_profits::profits-only` invariant which Smoke 4 does
    // not exercise.
    await mintTo(conn, deployer, usdcMint, nexusUsdcAta, need);
    log(
      'phase-f',
      `funded Nexus USDC accumulator with ${need.toString()} base units ` +
        `(ata=${nexusUsdcAta.toBase58()})`,
    );
  } else {
    log(
      'phase-f',
      `Nexus USDC accumulator already funded (${nexusBalance.toString()} base units)`,
    );
  }

  art.pdas = {
    ...art.pdas!,
    master_pool_nexus_usdc_ata: nexusUsdcAta.toBase58(),
  };

  // 2. Already-seeded short-circuit. After a successful `grow_liquidity` the
  // active zone bins carry `liquidity_b > 0`; we read one representative bin
  // (peak == new_nav_bin == initial_active_bin + 1) via the bin-array
  // account data layout. Re-running the bootstrap on a warm ledger is a
  // no-op once seeded.
  const ACTIVE_ZONE_WIDTH = 40;
  const newNavBin = MASTER_POOL_INITIAL_ACTIVE_BIN + 1;
  const binArrayInfo = await conn.getAccountInfo(binArrayPda);
  if (binArrayInfo) {
    // BinArray layout: 8 disc + 32 pool + bins[MAX_BINS] (16 bytes each:
    // u64 liquidity_a + u64 liquidity_b) + 4 lower_bin_id + 2 bin_step_bps +
    // 4 active_bin_id + 1 bump. We only need lower_bin_id + the peak bin's
    // liquidity_b to detect whether a previous grow already seeded.
    const BINS_OFFSET = 8 + 32;
    const BIN_SIZE = 16;
    // The lower_bin_id is u32 LE at offset (8 + 32 + MAX_BINS*16), but we
    // already know lower from the contract math: `permanent_tail_floor_bin`
    // for the canonical bootstrap params is `0 - 50 - 70 = -120`. Use the
    // contract's computation to derive the index of `newNavBin`.
    const permanentTailOffsetInBins =
      MASTER_POOL_PERMANENT_TAIL_OFFSET_BPS / MASTER_POOL_BIN_STEP_BPS;
    const PERMANENT_TAIL_BIN_COUNT = 70; // contracts/native-dex/src/constants.rs:69
    const expectedLowerBinId =
      MASTER_POOL_INITIAL_ACTIVE_BIN - permanentTailOffsetInBins - PERMANENT_TAIL_BIN_COUNT;
    const peakIndex = newNavBin - expectedLowerBinId;
    const peakLiquidityBOffset = BINS_OFFSET + peakIndex * BIN_SIZE + 8;
    if (
      binArrayInfo.data.length >= peakLiquidityBOffset + 8 &&
      binArrayInfo.data.readBigUInt64LE(peakLiquidityBOffset) > 0n
    ) {
      log(
        'phase-f',
        `master pool bid wall already seeded (peak bin ${newNavBin} liquidity_b > 0)`,
      );
      return;
    }
  }

  if (!ixExists(dexIdl, 'grow_liquidity')) {
    warn('phase-f', 'DEX IDL missing grow_liquidity; skipping bid wall seed');
    skipped.push('DEX::grow_liquidity master seed');
    art.init_skipped = skipped;
    return;
  }

  // 3. Submit grow_liquidity. Deployer == rebalancer at this phase (set in
  // initialize_dex; rotated to the pool-rebalancer bot keypair later in
  // phaseRegisterBots).
  const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
  const growTx = dexClient.buildTransaction('grow_liquidity', {
    accounts: {
      rebalancer: deployer.publicKey,
      dex_config: dexConfigPda,
      pool_state: poolPda,
      bin_array: binArrayPda,
      liquidity_nexus: nexusPda,
      nexus_usdc_ata: nexusUsdcAta,
      pool_vault_b: vaultB,
      rwt_vault: rwtVaultPda,
      token_program: TOKEN_PROGRAM_ID,
    },
    args: {
      new_nav_bin: newNavBin,
      active_zone_width: ACTIVE_ZONE_WIDTH,
    },
    computeUnits: 400_000,
  });
  try {
    await sendAndConfirm(conn, growTx, [deployer]);
    log(
      'phase-f',
      `master pool bid wall seeded via grow_liquidity ` +
        `(new_nav_bin=${newNavBin}, active_zone_width=${ACTIVE_ZONE_WIDTH}, ` +
        `nexus_usdc_drained=${MASTER_POOL_NEXUS_SEED_USDC.toString()})`,
    );
    art.pdas = {
      ...art.pdas!,
      master_pool_last_rebalance_nav_bin: String(newNavBin),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-f', `grow_liquidity bid wall seed failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'DEX::grow_liquidity master', error: head });
    art.init_failed = failed;
  }
}

// ---------------------------------------------------------------------------
// Layer 10 substep 2 — pool creator whitelist helper.
//
// `update_pool_creators` (action=ADD) is required before any create_pool /
// create_concentrated_pool call. Idempotent: re-running for an already-listed
// creator returns CreatorAlreadyExists, which we treat as success.
// ---------------------------------------------------------------------------
async function ensureDeployerPoolCreator(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexIdl = loadIdl('native-dex');
  if (!ixExists(dexIdl, 'update_pool_creators')) {
    warn('phase-f', 'DEX IDL missing update_pool_creators; skipping whitelist update');
    return;
  }
  const dexConfigPda = new PublicKey(art.pdas!.dex_config);
  const poolCreatorsPda = new PublicKey(art.pdas!.pool_creators);

  // Read current pool_creators state to check if deployer is already listed.
  // PoolCreators layout (DEX state.rs:74):
  //   8  discriminator
  //   32 authority
  //   10 * 32 = 320 creators slots
  //   1  active_count
  //   1  bump
  const CREATORS_OFFSET = 8 + 32;
  const ACTIVE_COUNT_OFFSET = CREATORS_OFFSET + 10 * 32; // 360
  const info = await conn.getAccountInfo(poolCreatorsPda);
  if (info && info.data.length >= ACTIVE_COUNT_OFFSET + 1) {
    const activeCount = info.data.readUInt8(ACTIVE_COUNT_OFFSET);
    const deployerBytes = deployer.publicKey.toBuffer();
    for (let i = 0; i < activeCount; i++) {
      const slot = info.data.subarray(
        CREATORS_OFFSET + i * 32,
        CREATORS_OFFSET + (i + 1) * 32,
      );
      if (Buffer.from(slot).equals(deployerBytes)) {
        log('phase-f', 'deployer already on pool_creators whitelist; skipping update');
        return;
      }
    }
  }

  const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
  try {
    const tx = dexClient.buildTransaction('update_pool_creators', {
      accounts: {
        authority: deployer.publicKey,
        dex_config: dexConfigPda,
        pool_creators: poolCreatorsPda,
      },
      args: {
        wallet: Array.from(deployer.publicKey.toBytes()),
        action: 0, // ACTION_ADD
      },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-f', `pool_creators: added deployer ${deployer.publicKey.toBase58()}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // CreatorAlreadyExists is benign; everything else propagates.
    if (msg.includes('CreatorAlreadyExists') || msg.includes('0x1771')) {
      log('phase-f', 'pool_creators: deployer already listed (idempotent skip)');
      return;
    }
    throw e;
  }
}

async function phaseOts(conn: Connection, deployer: Keypair, art: Artifact, count: number): Promise<void> {
  // `count` is the number of EXTRA test OTs requested via OT_TEST_COUNT.
  // SPRK (Sparkles) is always created at index 0 — it is the canonical
  // Ownership Token paired with RWT in the SPRK/RWT AMM pool. Extra test OTs
  // (when count > 0) get generic names/symbols "Test OT N" / "TOTN" for
  // harness scenarios.
  const totalCount = count + 1;
  log('phase-g', `creating ${totalCount} OT(s) (SPRK + ${count} test OT(s)) + distributors`);

  const otProgramId = new PublicKey(art.programs.ownership_token);
  const ydProgramId = new PublicKey(art.programs.yield_distribution);
  const otIdl = loadIdl('ownership-token');
  const ydIdl = loadIdl('yield-distribution');
  const skipped = art.init_skipped ?? [];

  if (!ixExists(otIdl, 'initialize_ot')) {
    warn('phase-g', 'OT IDL missing initialize_ot; skipping all OT creation');
    skipped.push('OT::initialize_ot (all)');
    art.init_skipped = skipped;
    return;
  }

  const usdcMint = new PublicKey(art.mints!.usdc_test_mint);
  const arealFeeAta = new PublicKey(art.pdas!.areal_fee_ata);

  const existing: OtRecord[] = art.ots ?? [];
  const out: OtRecord[] = [...existing];

  for (let i = 0; i < totalCount; i++) {
    let otKp: Keypair;
    const existingRec = existing[i];
    if (existingRec?.ot_mint_keypair_b64) {
      otKp = keypairFromB64(existingRec.ot_mint_keypair_b64);
    } else if (i === SPRK_OT_INDEX && art.mints?.sprk_ot_mint_keypair_b64) {
      // Reuse the SPRK OT mint keypair created in phase-a so `ots[SPRK_OT_INDEX].
      // ot_mint === mints.sprk_ot_mint`. Without this, scenario tests that
      // resolve the SPRK OT record via `ots.find(o => o.ot_mint === sprk_ot_mint)`
      // fail at lookup time (S1.2 + S1.9 — see layer-10-scenario-1-happy-path).
      otKp = keypairFromB64(art.mints.sprk_ot_mint_keypair_b64);
    } else {
      otKp = Keypair.generate();
    }
    const otMint = otKp.publicKey;

    const [otConfig] = findPda([Buffer.from('ot_config'), otMint.toBuffer()], otProgramId);
    const [revAcc] = findPda([Buffer.from('revenue'), otMint.toBuffer()], otProgramId);
    const [revCfg] = findPda([Buffer.from('revenue_config'), otMint.toBuffer()], otProgramId);
    const [otGov] = findPda([Buffer.from('ot_governance'), otMint.toBuffer()], otProgramId);
    const [otTreas] = findPda([Buffer.from('ot_treasury'), otMint.toBuffer()], otProgramId);
    const revTokAcc = findAta(revAcc, usdcMint);

    const otRec: OtRecord = {
      ot_mint: otMint.toBase58(),
      ot_mint_keypair_b64: keypairToB64(otKp),
      ot_config_pda: otConfig.toBase58(),
      revenue_account_pda: revAcc.toBase58(),
      revenue_config_pda: revCfg.toBase58(),
      ot_governance_pda: otGov.toBase58(),
      ot_treasury_pda: otTreas.toBase58(),
      revenue_token_account: revTokAcc.toBase58(),
    };

    // Step 1: ensure OT mint account exists.
    const mintInfo = await conn.getAccountInfo(otMint);
    if (!mintInfo) {
      await ensureMint(conn, deployer, 6, otKp);
      log('phase-g', `OT[${i}] mint created: ${otMint.toBase58()}`);
    }

    // Step 2: initialize_ot if not already.
    const otConfigInfo = await conn.getAccountInfo(otConfig);
    if (!otConfigInfo) {
      try {
        const otClient = new ArlexClient(loadIdlForClient('ownership-token'), otProgramId, conn);
        const tx = otClient.buildTransaction('initialize_ot', {
          accounts: {
            deployer: deployer.publicKey,
            ot_mint: otMint,
            usdc_mint: usdcMint,
            ot_config: otConfig,
            revenue_account: revAcc,
            revenue_token_account: revTokAcc,
            revenue_config: revCfg,
            ot_governance: otGov,
            ot_treasury: otTreas,
            areal_fee_destination_account: arealFeeAta,
            token_program: TOKEN_PROGRAM_ID,
            system_program: SYSTEM_PROGRAM_ID,
            ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
          },
          args: {
            // SPRK (index 0) is the canonical Ownership Token — name + symbol
            // are surfaced to the UI via SDK markets snapshot, so they must be
            // the user-facing label. Extra test OTs (index > 0) keep generic
            // names so harness scenarios don't accidentally collide with the
            // SPRK identity.
            name: Array.from(
              stringToFixedBytes(i === SPRK_OT_INDEX ? 'Sparkles' : `Test OT ${i}`, 32),
            ),
            symbol: Array.from(
              stringToFixedBytes(i === SPRK_OT_INDEX ? 'SPRK' : `TOT${i}`, 10),
            ),
            uri: Array.from(
              stringToFixedBytes(
                i === SPRK_OT_INDEX
                  ? 'https://areal.finance/sprk'
                  : `https://test.areal.finance/tot${i}`,
                200,
              ),
            ),
            initial_authority: Array.from(deployer.publicKey.toBytes()),
          },
        });
        await sendAndConfirm(conn, tx, [deployer]);
        log('phase-g', `OT[${i}]::initialize_ot OK`);
      } catch (e: unknown) {
        warn('phase-g', `OT[${i}] initialize_ot failed: ${e instanceof Error ? e.message : String(e)}`);
        skipped.push(`OT[${i}]::initialize_ot`);
        out.push(otRec);
        continue;
      }
    } else {
      log('phase-g', `OT[${i}]::initialize_ot skip (already initialized)`);
    }

    // Step 3: create_distributor (YD) — only if RWT vault is initialized + RWT mint match.
    if (
      ixExists(ydIdl, 'create_distributor') &&
      art.mints?.rwt_mint &&
      art.pdas?.rwt_vault
    ) {
      const rwtMint = new PublicKey(art.mints.rwt_mint);
      const [distributor] = findPda(
        [Buffer.from('merkle_dist'), otMint.toBuffer()],
        ydProgramId,
      );
      const [accumulator] = findPda(
        [Buffer.from('accumulator'), otMint.toBuffer()],
        ydProgramId,
      );
      const rewardVault = findAta(distributor, rwtMint);
      const accUsdcAta = findAta(accumulator, usdcMint);

      otRec.yd_distributor_pda = distributor.toBase58();
      otRec.yd_accumulator_pda = accumulator.toBase58();
      otRec.reward_vault = rewardVault.toBase58();
      otRec.accumulator_usdc_ata = accUsdcAta.toBase58();

      const distInfo = await conn.getAccountInfo(distributor);
      if (!distInfo) {
        try {
          const ydConfigPda = new PublicKey(art.pdas.yd_dist_config);
          const ydClient = new ArlexClient(loadIdlForClient('yield-distribution'), ydProgramId, conn);
          // A-14 — SPRK OT (index SPRK_OT_INDEX) gets the 365-day vesting period
          // required by plan §70. Every other test OT uses the 1-day default.
          // phaseSprkDistributor downstream verifies the on-chain vesting matches
          // plan §70 and FAILS LOUDLY on mismatch.
          const vestingSecs =
            i === SPRK_OT_INDEX ? SPRK_VESTING_PERIOD_SECS : DEFAULT_OT_VESTING_PERIOD_SECS;
          const tx = ydClient.buildTransaction('create_distributor', {
            accounts: {
              authority: deployer.publicKey,
              config: ydConfigPda,
              ot_mint: otMint,
              distributor,
              accumulator,
              rwt_mint: rwtMint,
              usdc_mint: usdcMint,
              reward_vault: rewardVault,
              accumulator_usdc_ata: accUsdcAta,
              token_program: TOKEN_PROGRAM_ID,
              system_program: SYSTEM_PROGRAM_ID,
              ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            },
            args: { vesting_period_secs: vestingSecs },
          });
          await sendAndConfirm(conn, tx, [deployer]);
          log('phase-g', `OT[${i}]::create_distributor OK`);
        } catch (e: unknown) {
          warn('phase-g', `OT[${i}] create_distributor failed: ${e instanceof Error ? e.message : String(e)}`);
          skipped.push(`YD::create_distributor[${i}]`);
        }
      } else {
        log('phase-g', `OT[${i}]::create_distributor skip (already initialized)`);
      }
    }

    out[i] = otRec;
  }

  art.ots = out;
  art.init_skipped = skipped;
}

async function phaseUsdcSupply(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-h', 'minting test USDC to deployer + accumulator ATAs');

  const usdcMint = new PublicKey(art.mints!.usdc_test_mint);

  // Deployer USDC ATA — already minted in phase-f, top-up to 10000 USDC.
  const deployerAta = await ensureAta(conn, deployer, usdcMint, deployer.publicKey);
  const balance = await getTokenBalance(conn, deployerAta);
  if (balance < 10_000_000_000n) {
    const topUp = 10_000_000_000n - balance;
    await mintTo(conn, deployer, usdcMint, deployerAta, topUp);
    log('phase-h', `deployer USDC topped up by ${topUp.toString()}`);
  }

  // Accumulator USDC ATA per OT — mint 100 USDC each so revenue-crank has
  // something to distribute on first tick.
  for (const ot of art.ots ?? []) {
    if (!ot.accumulator_usdc_ata) continue;
    const accAta = new PublicKey(ot.accumulator_usdc_ata);
    const accInfo = await conn.getAccountInfo(accAta);
    if (!accInfo) {
      log('phase-h', `accumulator ATA ${accAta.toBase58()} not yet present, skipping mint`);
      continue;
    }
    const bal = await getTokenBalance(conn, accAta);
    if (bal < 100_000_000n) {
      await mintTo(conn, deployer, usdcMint, accAta, 100_000_000n - bal);
      log('phase-h', `OT(${ot.ot_mint}) accumulator topped up to 100 USDC`);
    }
  }

  // Revenue token account per OT — mint $500 USDC each so revenue-crank's
  // distribute_revenue has a non-trivial input on first tick. Per
  // layer-10-scenario-1 step 1 ("send $500 USDC → Revenue ATA → seed").
  // Without this seed, distributor.total_funded stays at 0 and S1.3b /
  // S1.9 fail.
  const REVENUE_SEED_AMOUNT = 500_000_000n; // $500 with 6 decimals.
  for (const ot of art.ots ?? []) {
    if (!ot.revenue_token_account) continue;
    const revAta = new PublicKey(ot.revenue_token_account);
    const revInfo = await conn.getAccountInfo(revAta);
    if (!revInfo) {
      log('phase-h', `revenue token account ${revAta.toBase58()} not yet present, skipping seed`);
      continue;
    }
    const bal = await getTokenBalance(conn, revAta);
    if (bal < REVENUE_SEED_AMOUNT) {
      await mintTo(conn, deployer, usdcMint, revAta, REVENUE_SEED_AMOUNT - bal);
      log('phase-h', `OT(${ot.ot_mint}) revenue ATA seeded to $${(REVENUE_SEED_AMOUNT / 1_000_000n).toString()}`);
    }
  }

  // Accumulator RWT ATA per OT — create empty ATA owned by the accumulator
  // PDA so convert_to_rwt's `accumulator_rwt_ata` constraint resolves
  // (handler reads its owner field and reverts with "wrong owner" if the
  // ATA doesn't yet exist as an SPL Token account). Convert-and-fund-crank
  // swaps USDC → RWT into this ATA, then drains to fee_account + reward_vault.
  if (art.mints?.rwt_mint) {
    const rwtMint = new PublicKey(art.mints.rwt_mint);
    for (const ot of art.ots ?? []) {
      if (!ot.yd_accumulator_pda) continue;
      const accumulator = new PublicKey(ot.yd_accumulator_pda);
      const rwtAta = await ensureAta(conn, deployer, rwtMint, accumulator);
      ot.accumulator_rwt_ata = rwtAta.toBase58();
      log('phase-h', `OT(${ot.ot_mint}) accumulator RWT ATA ${rwtAta.toBase58()}`);
    }
  }
}

// ===========================================================================
// Layer 10 substep 2 — SPRK OT bootstrap (Phase 3 plan §63-77)
// ===========================================================================
//
// Phase 3 of the layer-10 plan calls for 6 steps after Phase 2 / Phase 5:
//   1. Create SPRK SPL Mint                 (already in phaseMints)
//   2. OT::initialize_ot                    (already in phaseOts step 2)
//   3. Futarchy::initialize_futarchy        (← phaseFutarchy below)
//   4. YD::create_distributor               (already in phaseOts step 3)
//   5. OT::batch_update_destinations 70/20/10 (← phaseDestinations below)
//   6. OT::mint_ot(initial_supply)          (← phaseSprkMint below)
//
// `phaseOts` covers steps 1, 2, 4 for every test OT. Layer 10 substep 2
// specializes ots[SPRK_OT_INDEX] inside phaseOts itself by passing the 365-day
// vesting_period_secs (constant SPRK_VESTING_PERIOD_SECS hoisted alongside the
// pool seed amounts). phaseSprkDistributor below verifies the on-chain vesting
// matches plan §70 and FAILS LOUDLY on mismatch. The remaining SPRK-specific
// phases live below: Futarchy init, destinations 70/20/10, initial supply
// mint.
//
// HARD CONSTRAINT (plan line 79 + R-B): mint_ot MUST run before Phase 7.
// After Futarchy claims OT governance, deployer cannot mint anymore. The
// orchestration in `main()` enforces this by calling phaseSprkMint before
// any authority-transfer phase (substep 3 wires that). phaseSprkMint also
// runs a defensive precheck that the deployer is still OT governance
// authority and aborts the run if not (SEC-23).

async function phaseFutarchy(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-i', 'initializing Futarchy for SPRK OT');

  if (!art.ots || art.ots.length === 0) {
    warn('phase-i', 'no OTs in artifact; skipping Futarchy init');
    return;
  }
  const sprkOt = art.ots[SPRK_OT_INDEX];
  if (!sprkOt) {
    warn('phase-i', `ots[${SPRK_OT_INDEX}] missing; skipping Futarchy init`);
    return;
  }

  const futProgramId = new PublicKey(art.programs.futarchy);
  const futIdl = loadIdl('futarchy');
  const skipped = art.init_skipped ?? [];

  if (!ixExists(futIdl, 'initialize_futarchy')) {
    warn('phase-i', 'Futarchy IDL missing initialize_futarchy; skipping');
    skipped.push('Futarchy::initialize_futarchy');
    art.init_skipped = skipped;
    return;
  }

  const sprkMint = new PublicKey(sprkOt.ot_mint);
  const otGovernancePda = new PublicKey(sprkOt.ot_governance_pda);

  const [futarchyConfigPda] = findPda(
    [Buffer.from('futarchy_config'), sprkMint.toBuffer()],
    futProgramId,
  );

  const existing = await conn.getAccountInfo(futarchyConfigPda);
  if (existing) {
    log('phase-i', `Futarchy already initialized for SPRK (config=${futarchyConfigPda.toBase58()})`);
    sprkOt.futarchy_config_pda = futarchyConfigPda.toBase58();
    return;
  }

  try {
    const futClient = new ArlexClient(loadIdlForClient('futarchy'), futProgramId, conn);
    const tx = futClient.buildTransaction('initialize_futarchy', {
      accounts: {
        deployer: deployer.publicKey,
        ot_mint: sprkMint,
        ot_governance: otGovernancePda,
        config: futarchyConfigPda,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: {},
    });
    await sendAndConfirm(conn, tx, [deployer]);
    sprkOt.futarchy_config_pda = futarchyConfigPda.toBase58();
    log('phase-i', `Futarchy::initialize_futarchy OK (config=${futarchyConfigPda.toBase58()})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-i', `initialize_futarchy failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'Futarchy::initialize_futarchy', error: head });
    art.init_failed = failed;
  }
}

async function phaseSprkDistributor(
  conn: Connection,
  _deployer: Keypair,
  art: Artifact,
): Promise<void> {
  // A-14 — verification only. phaseOts now creates the SPRK OT distributor with
  // SPRK_VESTING_PERIOD_SECS already (no recreation possible mid-run anyway —
  // close_distributor is a separate authority path). This phase reads the
  // on-chain `vesting_period_secs` field and FAILS LOUDLY if it doesn't match
  // plan §70.
  //
  // MerkleDistributor layout (yield-distribution/src/state.rs):
  //   8   discriminator
  //   8   ot_mint            [u8; 32]   offset 8
  //   40  reward_vault       [u8; 32]   offset 40
  //   72  accumulator        [u8; 32]   offset 72
  //   104 merkle_root        [u8; 32]   offset 104
  //   136 max_total_claim    u64        offset 136
  //   144 total_claimed      u64        offset 144
  //   152 total_funded       u64        offset 152
  //   160 locked_vested      u64        offset 160
  //   168 last_fund_ts       i64        offset 168
  //   176 vesting_period_secs i64       offset 176  ← read this
  //   184 epoch              u64        offset 184
  //   192 is_active          bool       offset 192
  //   193 bump               u8         offset 193
  if (!art.ots || art.ots.length === 0) return;
  const sprkOt = art.ots[SPRK_OT_INDEX];
  if (!sprkOt?.yd_distributor_pda) {
    log('phase-i', 'SPRK distributor not yet created; skipping vesting verification');
    return;
  }
  const distInfo = await conn.getAccountInfo(new PublicKey(sprkOt.yd_distributor_pda));
  if (!distInfo) {
    log('phase-i', 'SPRK distributor account missing; skipping vesting verification');
    return;
  }
  const VESTING_PERIOD_SECS_OFFSET = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8;
  if (distInfo.data.length < VESTING_PERIOD_SECS_OFFSET + 8) {
    throw new Error(
      `phase-i FATAL: SPRK distributor account too small ` +
        `(${distInfo.data.length} bytes, need >= ${VESTING_PERIOD_SECS_OFFSET + 8}) — IDL drift?`,
    );
  }
  // i64 little-endian. readBigInt64LE returns bigint.
  const onChainVesting = distInfo.data.readBigInt64LE(VESTING_PERIOD_SECS_OFFSET);
  const expected = BigInt(SPRK_VESTING_PERIOD_SECS);
  if (onChainVesting !== expected) {
    throw new Error(
      `phase-i FATAL: SPRK distributor vesting_period_secs=${onChainVesting.toString()}s ` +
        `but plan §70 requires ${expected.toString()}s (365 days). ` +
        `phaseOts must specialize SPRK OT (index ${SPRK_OT_INDEX}) — ` +
        `check the i===SPRK_OT_INDEX branch in phaseOts. ` +
        `Existing distributor cannot be patched in-place; restart with KEEP_LEDGER=0.`,
    );
  }
  log(
    'phase-i',
    `SPRK distributor vesting verified: ${onChainVesting.toString()}s (plan §70 OK)`,
  );
}

async function phaseDestinations(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-j', 'configuring SPRK OT revenue destinations (70/20/10)');

  if (!art.ots || art.ots.length === 0) {
    warn('phase-j', 'no OTs in artifact; skipping destinations');
    return;
  }
  const sprkOt = art.ots[SPRK_OT_INDEX];
  if (!sprkOt) {
    warn('phase-j', `ots[${SPRK_OT_INDEX}] missing; skipping destinations`);
    return;
  }
  if (sprkOt.destinations_set === true) {
    log('phase-j', 'SPRK destinations already configured (artifact flag); skipping');
    return;
  }
  if (!sprkOt.accumulator_usdc_ata) {
    warn(
      'phase-j',
      'SPRK accumulator_usdc_ata missing — phaseOts/create_distributor likely did not run',
    );
    return;
  }
  if (!art.mints?.usdc_test_mint) {
    warn('phase-j', 'usdc_test_mint missing; skipping destinations');
    return;
  }

  const otProgramId = new PublicKey(art.programs.ownership_token);
  const otIdl = loadIdl('ownership-token');
  const skipped = art.init_skipped ?? [];

  if (!ixExists(otIdl, 'batch_update_destinations')) {
    warn('phase-j', 'OT IDL missing batch_update_destinations; skipping');
    skipped.push('OT::batch_update_destinations');
    art.init_skipped = skipped;
    return;
  }

  const usdcMint = new PublicKey(art.mints.usdc_test_mint);
  const sprkMint = new PublicKey(sprkOt.ot_mint);
  const otGovernancePda = new PublicKey(sprkOt.ot_governance_pda);
  const revenueConfigPda = new PublicKey(sprkOt.revenue_config_pda);

  // Destination 1: YD accumulator USDC ATA (already created by phaseOts via
  // create_distributor CPI).
  const ydAccUsdcAta = new PublicKey(sprkOt.accumulator_usdc_ata);

  // Destination 2: OT treasury USDC ATA (owned by ot_treasury PDA).
  const otTreasuryPda = new PublicKey(sprkOt.ot_treasury_pda);
  const treasuryUsdcAta = await ensureAta(conn, deployer, usdcMint, otTreasuryPda);
  sprkOt.treasury_usdc_ata = treasuryUsdcAta.toBase58();

  // Destination 3: Crank wallet USDC ATA. SEC-24 — the deployer key is the
  // mainnet root and must NEVER be hot-funded with revenue, so non-localhost
  // bootstraps MUST set CRANK_USDC_OWNER_PUBKEY to the dedicated forwarder /
  // multisig wallet that owns this ATA. On localhost (devnet rehearsal) we
  // pick the convert-and-fund-crank bot keypair (the actual consumer of the
  // Nexus revenue stream) so the crank ATA is distinct from the deployer's
  // areal_fee_destination ATA — otherwise batch_update_destinations would
  // reject the destination with FeeDestinationCollision (SD-33).
  let crankOwner: PublicKey;
  const overrideOwner = process.env.CRANK_USDC_OWNER_PUBKEY;
  if (overrideOwner) {
    try {
      crankOwner = new PublicKey(overrideOwner);
    } catch {
      throw new Error(
        `phase-j FATAL: CRANK_USDC_OWNER_PUBKEY="${overrideOwner}" is not a valid base58 pubkey`,
      );
    }
    log('phase-j', `crank USDC owner override: ${crankOwner.toBase58()}`);
  } else {
    if (art.bootstrap_target !== 'localhost') {
      throw new Error(
        `phase-j FATAL: CRANK_USDC_OWNER_PUBKEY env var is required on non-localhost ` +
          `bootstrap_target="${art.bootstrap_target}". Defaulting to deployer would route ` +
          `10% of OT revenue into the mainnet root key.`,
      );
    }
    // SD-33: prefer convert-and-fund-crank bot keypair on localhost — it
    // consumes the Nexus revenue stream + its USDC ATA is distinct from
    // areal_fee_destination (which is owned by deployer per phase-b).
    const cfBot = art.bots?.['convert-and-fund-crank'];
    if (cfBot?.pubkey) {
      try {
        crankOwner = new PublicKey(cfBot.pubkey);
        log('phase-j', `crank USDC owner: convert-and-fund-crank bot ${crankOwner.toBase58()}`);
      } catch {
        throw new Error(
          `phase-j FATAL: convert-and-fund-crank pubkey "${cfBot.pubkey}" not a valid base58`,
        );
      }
    } else {
      throw new Error(
        `phase-j FATAL: convert-and-fund-crank bot keypair missing — stage_bots must run before ` +
          `stage_init. Cannot fall back to deployer because the deployer's USDC ATA collides ` +
          `with areal_fee_destination (FeeDestinationCollision in batch_update_destinations).`,
      );
    }
  }
  const crankUsdcAta = await ensureAta(conn, deployer, usdcMint, crankOwner);
  art.pdas = {
    ...art.pdas!,
    crank_usdc_ata: crankUsdcAta.toBase58(),
  };

  const destinations = [
    {
      address: Array.from(ydAccUsdcAta.toBytes()),
      allocation_bps: 7000,
      label: Array.from(stringToFixedBytes('YD Accumulator', 32)),
    },
    {
      address: Array.from(treasuryUsdcAta.toBytes()),
      allocation_bps: 2000,
      label: Array.from(stringToFixedBytes('Treasury', 32)),
    },
    {
      address: Array.from(crankUsdcAta.toBytes()),
      allocation_bps: 1000,
      label: Array.from(stringToFixedBytes('Nexus via Crank', 32)),
    },
  ];

  try {
    const otClient = new ArlexClient(loadIdlForClient('ownership-token'), otProgramId, conn);
    const tx = otClient.buildTransaction('batch_update_destinations', {
      accounts: {
        authority: deployer.publicKey,
        ot_mint: sprkMint,
        ot_governance: otGovernancePda,
        revenue_config: revenueConfigPda,
      },
      args: { destinations },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    sprkOt.destinations_set = true;
    log(
      'phase-j',
      `SPRK destinations set 70/20/10 (yd=${ydAccUsdcAta.toBase58()}, treasury=${treasuryUsdcAta.toBase58()}, crank=${crankUsdcAta.toBase58()})`,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-j', `batch_update_destinations failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'OT::batch_update_destinations', error: head });
    art.init_failed = failed;
  }
}

async function phaseSprkMint(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-k', `minting initial SPRK OT supply (${SPRK_INITIAL_SUPPLY.toString()} base units)`);

  if (!art.ots || art.ots.length === 0) {
    warn('phase-k', 'no OTs in artifact; skipping SPRK mint');
    return;
  }
  const sprkOt = art.ots[SPRK_OT_INDEX];
  if (!sprkOt) {
    warn('phase-k', `ots[${SPRK_OT_INDEX}] missing; skipping SPRK mint`);
    return;
  }

  const otProgramId = new PublicKey(art.programs.ownership_token);
  const otIdl = loadIdl('ownership-token');
  const skipped = art.init_skipped ?? [];

  if (!ixExists(otIdl, 'mint_ot')) {
    warn('phase-k', 'OT IDL missing mint_ot; skipping');
    skipped.push('OT::mint_ot');
    art.init_skipped = skipped;
    return;
  }

  const sprkMint = new PublicKey(sprkOt.ot_mint);
  const otGovernancePda = new PublicKey(sprkOt.ot_governance_pda);
  const otConfigPda = new PublicKey(sprkOt.ot_config_pda);

  // Idempotency check 1: artifact flag.
  if (sprkOt.initial_supply_minted) {
    log('phase-k', `SPRK initial supply already minted (${sprkOt.initial_supply_minted}); skipping`);
    return;
  }

  // Idempotency check 2: deployer's SPRK ATA balance. If it's already at-or-
  // above the initial supply, treat the mint as done (warm-restart safety).
  const recipientAta = await ensureAta(conn, deployer, sprkMint, deployer.publicKey);
  const balance = await getTokenBalance(conn, recipientAta);
  if (balance >= SPRK_INITIAL_SUPPLY) {
    log('phase-k', `deployer SPRK ATA balance ${balance.toString()} >= initial supply; skipping mint`);
    sprkOt.initial_supply_minted = SPRK_INITIAL_SUPPLY.toString();
    return;
  }

  // SEC-23 — defensive R-B precheck. Reads the OtGovernance.authority field
  // and aborts the run if the deployer is no longer authority. mint_ot has
  // `has_one = authority`, so if Phase 7 has already transferred ownership to
  // Futarchy or Multisig, this call would fail with `OwnerMismatch` and the
  // SPRK initial supply would be permanently unmintable (R-B catastrophe).
  //
  // OtGovernance layout (ownership-token/src/state.rs):
  //   0  discriminator        [u8; 8]
  //   8  ot_mint              [u8; 32]
  //   40 authority            [u8; 32]   ← read target
  //   72 pending_authority    [u8; 32]
  //   ...
  // Total = 107 bytes (8 disc + 99 data).
  const OT_GOV_AUTHORITY_OFFSET = 40;
  const OT_GOV_MIN_SIZE = OT_GOV_AUTHORITY_OFFSET + 32;
  const govInfo = await conn.getAccountInfo(otGovernancePda);
  if (govInfo && govInfo.data.length >= OT_GOV_MIN_SIZE) {
    const onChainAuthority = govInfo.data.subarray(
      OT_GOV_AUTHORITY_OFFSET,
      OT_GOV_AUTHORITY_OFFSET + 32,
    );
    if (!Buffer.from(onChainAuthority).equals(deployer.publicKey.toBuffer())) {
      const actual = new PublicKey(onChainAuthority).toBase58();
      throw new Error(
        `phase-k FATAL: deployer is no longer OT governance authority — ` +
          `Phase 7 ran already. mint_ot must precede authority transfer (R-B). ` +
          `on-chain authority=${actual}, deployer=${deployer.publicKey.toBase58()}.`,
      );
    }
  }

  try {
    const otClient = new ArlexClient(loadIdlForClient('ownership-token'), otProgramId, conn);
    const tx = otClient.buildTransaction('mint_ot', {
      accounts: {
        authority: deployer.publicKey,
        ot_governance: otGovernancePda,
        ot_config: otConfigPda,
        ot_mint: sprkMint,
        recipient_token_account: recipientAta,
        recipient: deployer.publicKey,
        payer: deployer.publicKey,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
        ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      },
      args: { amount: Number(SPRK_INITIAL_SUPPLY) },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    sprkOt.initial_supply_minted = SPRK_INITIAL_SUPPLY.toString();
    log(
      'phase-k',
      `OT::mint_ot OK (recipient=${recipientAta.toBase58()}, amount=${SPRK_INITIAL_SUPPLY.toString()})`,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-k', `mint_ot failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'OT::mint_ot', error: head });
    art.init_failed = failed;
  }
}

// ===========================================================================
// Layer 10 substep 2 — SPRK/RWT governance pool (Phase 4 plan §85)
// ===========================================================================
//
// Plan §Phase 4 step 2 calls for an SPRK_OT/RWT StandardCurve pool. This is the
// "OT pair with treasury fee" slot — when users swap SPRK for RWT (or vice
// versa), the OT treasury collects a portion of the fee via the
// `has_ot_treasury` PoolState branch (handled inside swap.rs).
//
// Pool PDA seed: ["pool", min(arl, rwt), max(arl, rwt)]. The pool requires RWT
// as one mint (DEX validation::token_a_is_rwt enforces). Seed: 1_000 RWT +
// 1_000 SPRK OT = balanced 50/50 (per plan §88).

async function phaseSprkRwtPool(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-l', 'creating SPRK_OT/RWT StandardCurve pool + seeding liquidity');

  if (!art.ots || art.ots.length === 0) {
    warn('phase-l', 'no OTs in artifact; skipping SPRK/RWT pool');
    return;
  }
  const sprkOt = art.ots[SPRK_OT_INDEX];
  if (!sprkOt) {
    warn('phase-l', `ots[${SPRK_OT_INDEX}] missing; skipping SPRK/RWT pool`);
    return;
  }
  if (!art.mints?.rwt_mint) {
    warn('phase-l', 'rwt_mint missing; skipping SPRK/RWT pool');
    return;
  }
  if (!sprkOt.initial_supply_minted) {
    warn('phase-l', 'SPRK initial supply not yet minted; skipping SPRK/RWT pool seed');
    return;
  }

  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexIdl = loadIdl('native-dex');
  const skipped = art.init_skipped ?? [];

  const sprkMint = new PublicKey(sprkOt.ot_mint);
  const rwtMint = new PublicKey(art.mints.rwt_mint);
  const otTreasuryPda = new PublicKey(sprkOt.ot_treasury_pda);

  // Canonical pool order: a < b
  const [tokenA, tokenB] = sprkMint.toBuffer().compare(rwtMint.toBuffer()) < 0
    ? [sprkMint, rwtMint]
    : [rwtMint, sprkMint];

  const [poolPda] = findPda(
    [Buffer.from('pool'), tokenA.toBuffer(), tokenB.toBuffer()],
    dexProgramId,
  );
  const dexConfigPda = new PublicKey(art.pdas!.dex_config);
  const poolCreatorsPda = new PublicKey(art.pdas!.pool_creators);

  // OT pair pools require remaining_accounts[0..2] = (ot_treasury_pda,
  // treasury_rwt_ata) for fee routing. The treasury RWT ATA is owned by the
  // ot_treasury PDA.
  const treasuryRwtAta = await ensureAta(conn, deployer, rwtMint, otTreasuryPda);

  await ensureDeployerPoolCreator(conn, deployer, art);

  const existing = await conn.getAccountInfo(poolPda);
  let vaultA: PublicKey;
  let vaultB: PublicKey;

  if (existing) {
    log('phase-l', 'SPRK/RWT pool already exists, reading vaults from state');
    vaultA = new PublicKey(existing.data.subarray(73, 105));
    vaultB = new PublicKey(existing.data.subarray(105, 137));
  } else {
    if (!ixExists(dexIdl, 'create_pool')) {
      warn('phase-l', 'DEX IDL missing create_pool; skipping SPRK/RWT pool');
      skipped.push('DEX::create_pool SPRK/RWT');
      art.init_skipped = skipped;
      return;
    }
    const vaultAKp = Keypair.generate();
    const vaultBKp = Keypair.generate();

    const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
    try {
      const tx = dexClient.buildTransaction('create_pool', {
        accounts: {
          creator: deployer.publicKey,
          dex_config: dexConfigPda,
          pool_creators: poolCreatorsPda,
          pool_state: poolPda,
          token_a_mint: tokenA,
          token_b_mint: tokenB,
          vault_a: vaultAKp.publicKey,
          vault_b: vaultBKp.publicKey,
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID,
        },
        args: {},
        // OT-pair fee accounts — DEX detects via remaining_accounts[0..2].
        remainingAccounts: [
          { pubkey: otTreasuryPda, isSigner: false, isWritable: false },
          { pubkey: treasuryRwtAta, isSigner: false, isWritable: false },
        ],
        computeUnits: 300_000,
      });
      await sendAndConfirm(conn, tx, [deployer, vaultAKp, vaultBKp]);
      vaultA = vaultAKp.publicKey;
      vaultB = vaultBKp.publicKey;
      log('phase-l', `SPRK/RWT pool created (pool=${poolPda.toBase58()}, has_ot_treasury=true)`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warn('phase-l', `create_pool SPRK/RWT failed: ${msg}`);
      const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
      const failed = art.init_failed ?? [];
      failed.push({ phase: 'DEX::create_pool SPRK/RWT', error: head });
      art.init_failed = failed;
      return;
    }
  }

  art.pdas = {
    ...art.pdas!,
    sprk_rwt_pool: poolPda.toBase58(),
    sprk_rwt_pool_vault_a: vaultA.toBase58(),
    sprk_rwt_pool_vault_b: vaultB.toBase58(),
  };

  // Seed liquidity if not already seeded.
  const existingLiquidity = await getTokenBalance(conn, vaultA);
  if (existingLiquidity > 0n) {
    log('phase-l', `SPRK/RWT pool already seeded (vaultA=${existingLiquidity.toString()})`);
    return;
  }

  if (!ixExists(dexIdl, 'add_liquidity')) {
    warn('phase-l', 'DEX IDL missing add_liquidity; skipping SPRK/RWT pool seed');
    skipped.push('DEX::add_liquidity SPRK/RWT');
    art.init_skipped = skipped;
    return;
  }

  // Provider has 1_000_000 SPRK minted in phaseSprkMint. RWT comes from
  // admin_mint_rwt (idempotent: only top-up the delta).
  const deployerSprkAta = await ensureAta(conn, deployer, sprkMint, deployer.publicKey);
  const deployerRwtAta = await ensureAta(conn, deployer, rwtMint, deployer.publicKey);

  const sprkBal = await getTokenBalance(conn, deployerSprkAta);
  if (sprkBal < SPRK_RWT_POOL_SEED_SPRK) {
    warn(
      'phase-l',
      `deployer SPRK balance ${sprkBal.toString()} < seed ${SPRK_RWT_POOL_SEED_SPRK.toString()}; skipping pool seed`,
    );
    skipped.push('DEX::add_liquidity SPRK/RWT (insufficient SPRK)');
    art.init_skipped = skipped;
    return;
  }

  const rwtBal = await getTokenBalance(conn, deployerRwtAta);
  if (rwtBal < SPRK_RWT_POOL_SEED_RWT) {
    const rwtIdl = loadIdl('rwt-engine');
    if (ixExists(rwtIdl, 'admin_mint_rwt')) {
      try {
        const rwtClient = new ArlexClient(
          loadIdlForClient('rwt-engine'),
          new PublicKey(art.programs.rwt_engine),
          conn,
        );
        const need = SPRK_RWT_POOL_SEED_RWT - rwtBal;
        // INVARIANT (NAV = $1.0): mirror `rwt_amount` and
        // `backing_capital_usd`. Both args are 6-decimal raw (USDC + RWT
        // share decimals), so equal values preserve NAV = capital / supply
        // at $1.0. Same reasoning as the master-pool seed in phase-f above.
        const adminTx = rwtClient.buildTransaction('admin_mint_rwt', {
          accounts: {
            authority: deployer.publicKey,
            rwt_vault: new PublicKey(art.pdas!.rwt_vault),
            rwt_mint: rwtMint,
            recipient_rwt: deployerRwtAta,
            token_program: TOKEN_PROGRAM_ID,
          },
          args: {
            rwt_amount: Number(need),
            backing_capital_usd: Number(need),
          },
        });
        await sendAndConfirm(conn, adminTx, [deployer]);
        log(
          'phase-l',
          `admin_mint_rwt: minted ${need.toString()} RWT + ${need.toString()} raw USDC capital for SPRK/RWT pool seed (NAV=$1.0)`,
        );
      } catch (e: unknown) {
        warn(
          'phase-l',
          `admin_mint_rwt for SPRK/RWT seed failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        skipped.push('DEX::add_liquidity SPRK/RWT (admin_mint_rwt failed)');
        art.init_skipped = skipped;
        return;
      }
    } else {
      warn('phase-l', 'RWT IDL missing admin_mint_rwt; skipping SPRK/RWT pool seed');
      skipped.push('DEX::add_liquidity SPRK/RWT (no admin_mint_rwt)');
      art.init_skipped = skipped;
      return;
    }
  }

  // Map ATAs and amounts to canonical token order.
  const providerTokenA = tokenA.equals(sprkMint) ? deployerSprkAta : deployerRwtAta;
  const providerTokenB = tokenB.equals(sprkMint) ? deployerSprkAta : deployerRwtAta;
  const amountA = tokenA.equals(sprkMint) ? SPRK_RWT_POOL_SEED_SPRK : SPRK_RWT_POOL_SEED_RWT;
  const amountB = tokenB.equals(sprkMint) ? SPRK_RWT_POOL_SEED_SPRK : SPRK_RWT_POOL_SEED_RWT;

  const [lpPda] = findPda(
    [Buffer.from('lp'), poolPda.toBuffer(), deployer.publicKey.toBuffer()],
    dexProgramId,
  );

  // SEC-26 / R-72 (Layer 10 closure): sandwich protection. First-add
  // (vault_a == 0) uses min_shares: 0 — share calc deterministic. Non-empty
  // re-seed computes 1%-slippage min_shares floor client-side via
  // computeMinSharesForReseed.
  const sprkVaultABalance = await getTokenBalance(conn, vaultA);
  let sprkMinShares: bigint = 0n;
  if (sprkVaultABalance > 0n) {
    sprkMinShares = await computeMinSharesForReseed(conn, poolPda, amountA, amountB);
    log(
      'phase-l',
      `non-empty re-seed: computed min_shares=${sprkMinShares.toString()} (1% slippage floor)`,
    );
  }

  const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
  const seedTx = dexClient.buildTransaction('add_liquidity', {
    accounts: {
      provider: deployer.publicKey,
      payer: deployer.publicKey,
      dex_config: dexConfigPda,
      pool_state: poolPda,
      lp_position: lpPda,
      provider_token_a: providerTokenA,
      provider_token_b: providerTokenB,
      vault_a: vaultA,
      vault_b: vaultB,
      token_program: TOKEN_PROGRAM_ID,
      system_program: SYSTEM_PROGRAM_ID,
    },
    args: { amount_a: Number(amountA), amount_b: Number(amountB), min_shares: Number(sprkMinShares) },
  });
  // T-10 — match rest-of-file pattern: record send failures as init_failed and
  // continue.
  try {
    await sendAndConfirm(conn, seedTx, [deployer]);
    log(
      'phase-l',
      `SPRK/RWT pool seeded (${amountA.toString()}/${amountB.toString()} base units, balanced)`,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-l', `SPRK/RWT pool add_liquidity failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'DEX::add_liquidity SPRK/RWT', error: head });
    art.init_failed = failed;
  }
}

// ===========================================================================
// Layer 10 substep 2 — Phase 6 bot wallet registration (plan §98-105)
// ===========================================================================
//
// Plan §Phase 6 specifies:
//   1. RWT::update_vault_manager(manager=ai_agent_wallet)         ← rwt-manager bot
//   2. DEX::update_dex_config(rebalancer=rebalancer_wallet)       ← pool-rebalancer bot
//   3. YD::publish_authority already set at Phase 2               (verified — no-op)
//   4. nexus.manager already set at Phase 5                       (verified — no-op)
//
// Each registration is idempotent: read current state, skip if already-set to
// the expected pubkey. R-J closure verifies pool-rebalancer + rwt-manager
// keypairs exist (added in stage_bots of e2e-bootstrap.sh).

async function phaseRegisterBots(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-m', 'registering bot wallets in contracts (Phase 6)');

  const skipped = art.init_skipped ?? [];
  const bots = art.bots ?? {};

  // ---- Sub-phase 1: RWT::update_vault_manager(rwt-manager.pubkey) ----
  await registerRwtManager(conn, deployer, art, bots, skipped);

  // ---- Sub-phase 2: DEX::update_dex_config(rebalancer=pool-rebalancer.pubkey) ----
  await registerDexRebalancer(conn, deployer, art, bots, skipped);

  // ---- Sub-phase 3: verify YD publish_authority (no-op confirmation) ----
  await verifyYdPublishAuthority(conn, deployer, art);

  // ---- Sub-phase 4: verify nexus.manager (no-op confirmation) ----
  await verifyNexusManager(conn, deployer, art);

  art.init_skipped = skipped;
}

async function registerRwtManager(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
  bots: NonNullable<Artifact['bots']>,
  skipped: string[],
): Promise<void> {
  const rwtBot = bots['rwt-manager'];
  if (!rwtBot) {
    warn('phase-m', 'rwt-manager bot keypair not generated yet; skipping update_vault_manager');
    skipped.push('RWT::update_vault_manager (no rwt-manager keypair)');
    return;
  }
  const rwtIdl = loadIdl('rwt-engine');
  if (!ixExists(rwtIdl, 'update_vault_manager')) {
    warn('phase-m', 'RWT IDL missing update_vault_manager; skipping');
    skipped.push('RWT::update_vault_manager');
    return;
  }
  const rwtProgramId = new PublicKey(art.programs.rwt_engine);
  const rwtVaultPda = new PublicKey(art.pdas!.rwt_vault);
  const targetPubkey = new PublicKey(rwtBot.pubkey);

  // SEC-20 — verified RwtVault layout (rwt-engine/src/state.rs):
  //   0   discriminator              [u8; 8]
  //   8   total_invested_capital     u128         (16 bytes — first u128 in project)
  //   24  total_rwt_supply           u64
  //   32  nav_book_value             u64
  //   40  capital_accumulator_ata    [u8; 32]
  //   72  rwt_mint                   [u8; 32]
  //   104 authority                  [u8; 32]
  //   136 pending_authority          [u8; 32]
  //   168 has_pending                bool         (1 byte)
  //   169 manager                    [u8; 32]     ← read target
  //   201 pause_authority            [u8; 32]
  //   233 mint_paused                bool
  //   234 areal_fee_destination      [u8; 32]
  //   266 bump                       u8
  // Total = 267 bytes (8 disc + 259 data). Pre-Layer-10 offset was 161 — that
  // missed the extra 8 bytes of total_invested_capital (u128 not u64).
  const MANAGER_OFFSET = 169;
  const RWT_VAULT_MIN_SIZE = MANAGER_OFFSET + 32;

  const vaultInfo = await conn.getAccountInfo(rwtVaultPda);
  if (vaultInfo) {
    if (vaultInfo.data.length >= RWT_VAULT_MIN_SIZE) {
      const current = vaultInfo.data.subarray(MANAGER_OFFSET, MANAGER_OFFSET + 32);
      if (Buffer.from(current).equals(targetPubkey.toBuffer())) {
        log('phase-m', `RWT vault.manager already = rwt-manager (${targetPubkey.toBase58()}); skipping`);
        return;
      }
    }
  }

  try {
    const rwtClient = new ArlexClient(loadIdlForClient('rwt-engine'), rwtProgramId, conn);
    const tx = rwtClient.buildTransaction('update_vault_manager', {
      accounts: {
        authority: deployer.publicKey,
        rwt_vault: rwtVaultPda,
      },
      args: {
        new_manager: Array.from(targetPubkey.toBytes()),
      },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-m', `RWT::update_vault_manager OK (manager=${targetPubkey.toBase58()})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-m', `update_vault_manager failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'RWT::update_vault_manager', error: head });
    art.init_failed = failed;
  }
}

async function registerDexRebalancer(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
  bots: NonNullable<Artifact['bots']>,
  skipped: string[],
): Promise<void> {
  const rebBot = bots['pool-rebalancer'];
  if (!rebBot) {
    warn('phase-m', 'pool-rebalancer bot keypair not generated yet; skipping update_dex_config');
    skipped.push('DEX::update_dex_config (no pool-rebalancer keypair)');
    return;
  }
  const dexIdl = loadIdl('native-dex');
  if (!ixExists(dexIdl, 'update_dex_config')) {
    warn('phase-m', 'DEX IDL missing update_dex_config; skipping');
    skipped.push('DEX::update_dex_config');
    return;
  }
  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexConfigPda = new PublicKey(art.pdas!.dex_config);
  const targetPubkey = new PublicKey(rebBot.pubkey);

  // SEC-19 — verified DexConfig layout (native-dex/src/state.rs):
  //   0   discriminator           [u8; 8]
  //   8   authority               [u8; 32]
  //   40  pending_authority       [u8; 32]
  //   72  has_pending             bool          (1 byte)
  //   73  pause_authority         [u8; 32]
  //   105 base_fee_bps            u16 LE
  //   107 lp_fee_share_bps        u16 LE
  //   109 areal_fee_destination   [u8; 32]
  //   141 rebalancer              [u8; 32]      ← read/write target
  //   173 is_active               bool          (1 byte)
  //   174 bump                    u8
  // Total = 175 bytes (8 disc + 167 data). Pre-Layer-10 offsets were stale.
  const BASE_FEE_BPS_OFFSET = 105;
  const LP_FEE_SHARE_BPS_OFFSET = 107;
  const REBALANCER_OFFSET = 141;
  const IS_ACTIVE_OFFSET = 173;
  const DEX_CONFIG_MIN_SIZE = REBALANCER_OFFSET + 32;

  const configInfo = await conn.getAccountInfo(dexConfigPda);
  if (configInfo) {
    if (configInfo.data.length >= DEX_CONFIG_MIN_SIZE) {
      const current = configInfo.data.subarray(REBALANCER_OFFSET, REBALANCER_OFFSET + 32);
      if (Buffer.from(current).equals(targetPubkey.toBuffer())) {
        log('phase-m', `DEX rebalancer already = pool-rebalancer (${targetPubkey.toBase58()}); skipping`);
        return;
      }
    }
  }

  // Read existing fee bps + is_active so the update preserves them (only the
  // rebalancer changes). Fall back to canonical defaults (30 / 5000 / true)
  // if the read fails or the account is unexpectedly small.
  let baseFeeBps = 30;
  let lpFeeShareBps = 5000;
  let isActive = true;
  if (configInfo && configInfo.data.length >= IS_ACTIVE_OFFSET + 1) {
    baseFeeBps = configInfo.data.readUInt16LE(BASE_FEE_BPS_OFFSET);
    lpFeeShareBps = configInfo.data.readUInt16LE(LP_FEE_SHARE_BPS_OFFSET);
    isActive = configInfo.data.readUInt8(IS_ACTIVE_OFFSET) === 1;
  }

  try {
    const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
    const tx = dexClient.buildTransaction('update_dex_config', {
      accounts: {
        authority: deployer.publicKey,
        dex_config: dexConfigPda,
      },
      args: {
        base_fee_bps: baseFeeBps,
        lp_fee_share_bps: lpFeeShareBps,
        rebalancer: Array.from(targetPubkey.toBytes()),
        is_active: isActive,
      },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-m', `DEX::update_dex_config OK (rebalancer=${targetPubkey.toBase58()})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-m', `update_dex_config failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'DEX::update_dex_config', error: head });
    art.init_failed = failed;
  }
}

async function verifyYdPublishAuthority(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  if (!art.pdas?.yd_dist_config) return;
  const info = await conn.getAccountInfo(new PublicKey(art.pdas.yd_dist_config));
  if (!info) {
    warn('phase-m', 'YD dist_config not found; cannot verify publish_authority');
    return;
  }
  // SEC-22 — verified DistributionConfig layout (yield-distribution/src/state.rs):
  //   0   discriminator        [u8; 8]
  //   8   authority            [u8; 32]
  //   40  pending_authority    [u8; 32]
  //   72  has_pending          bool       (1 byte) ← previously missed
  //   73  publish_authority    [u8; 32]   ← read target
  //   ...
  const PA_OFFSET = 73;
  if (info.data.length < PA_OFFSET + 32) {
    warn('phase-m', 'YD dist_config too small; cannot verify publish_authority');
    return;
  }
  const current = info.data.subarray(PA_OFFSET, PA_OFFSET + 32);
  const currentPubkey = new PublicKey(current);

  const targetBot = art.bots?.['merkle-publisher'];
  if (!targetBot?.pubkey) {
    log('phase-m', `YD publish_authority = ${currentPubkey.toBase58()} (no merkle-publisher bot keypair to rotate)`);
    return;
  }
  const target = new PublicKey(targetBot.pubkey);
  if (currentPubkey.equals(target)) {
    log('phase-m', `YD publish_authority already = merkle-publisher (${target.toBase58()}); skipping`);
    return;
  }

  // SD-36: rotate publish_authority deployer -> merkle-publisher pubkey so
  // verify-deployment.sh check 4 sees the bot registered. Mainnet ceremony
  // performs the same rotation pre-Phase-7 (deployer is still authority here).
  const ydProgramId = new PublicKey(art.programs.yield_distribution);
  const ydIdl = loadIdl('yield-distribution');
  if (!ixExists(ydIdl, 'update_publish_authority')) {
    warn('phase-m', 'YD IDL missing update_publish_authority; skipping rotation');
    return;
  }
  try {
    const ydClient = new ArlexClient(loadIdlForClient('yield-distribution'), ydProgramId, conn);
    const tx = ydClient.buildTransaction('update_publish_authority', {
      accounts: {
        authority: deployer.publicKey,
        config: new PublicKey(art.pdas.yd_dist_config),
      },
      args: { new_publish_authority: Array.from(target.toBytes()) },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-m', `YD::update_publish_authority OK (publisher=${target.toBase58()})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-m', `update_publish_authority failed: ${msg}`);
  }
}

async function verifyNexusManager(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  if (!art.pdas?.liquidity_nexus) return;
  const info = await conn.getAccountInfo(new PublicKey(art.pdas.liquidity_nexus));
  if (!info) {
    warn('phase-m', 'LiquidityNexus not found; cannot verify manager');
    return;
  }
  // LiquidityNexus layout (Layer 9): 8 disc + 32 manager + ...
  if (info.data.length < 8 + 32) {
    warn('phase-m', 'LiquidityNexus too small; cannot verify manager');
    return;
  }
  const current = info.data.subarray(8, 8 + 32);
  const currentPubkey = new PublicKey(current);

  const targetBot = art.bots?.['nexus-manager'];
  if (!targetBot?.pubkey) {
    log('phase-m', `Nexus manager = ${currentPubkey.toBase58()} (no nexus-manager bot keypair to rotate)`);
    return;
  }
  const target = new PublicKey(targetBot.pubkey);
  if (currentPubkey.equals(target)) {
    log('phase-m', `Nexus.manager already = nexus-manager (${target.toBase58()}); skipping`);
    return;
  }

  // SD-36: rotate Nexus.manager deployer -> nexus-manager pubkey so
  // verify-deployment.sh check 4 sees the bot registered. Mainnet ceremony
  // performs the same rotation pre-Phase-7 (deployer is still authority).
  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexIdl = loadIdl('native-dex');
  if (!ixExists(dexIdl, 'update_nexus_manager')) {
    warn('phase-m', 'DEX IDL missing update_nexus_manager; skipping rotation');
    return;
  }
  try {
    const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
    const tx = dexClient.buildTransaction('update_nexus_manager', {
      accounts: {
        authority: deployer.publicKey,
        dex_config: new PublicKey(art.pdas!.dex_config),
        liquidity_nexus: new PublicKey(art.pdas.liquidity_nexus),
      },
      args: { new_manager: Array.from(target.toBytes()) },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-m', `DEX::update_nexus_manager OK (manager=${target.toBase58()})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-m', `update_nexus_manager failed: ${msg}`);
  }
}

// --------------------------------------------------------------------------
// RWT vault state reader + NAV invariant check
// --------------------------------------------------------------------------

/**
 * On-chain `RwtVault` snapshot fields needed for the NAV invariant check.
 *
 * Layout (from contracts/rwt-engine/src/state.rs, repr(C, packed) + 8-byte
 * Arlex discriminator prefix):
 *   bytes  0..8   : account discriminator
 *   bytes  8..24  : total_invested_capital (u128, little-endian)
 *   bytes 24..32  : total_rwt_supply (u64, little-endian)
 *   bytes 32..40  : nav_book_value (u64, little-endian)
 *   bytes 40..    : ATAs / authorities / flags (not needed here)
 */
interface RwtVaultSnapshot {
  totalInvestedCapital: bigint;
  totalRwtSupply: bigint;
  navBookValue: bigint;
}

/**
 * Read the singleton RwtVault account and decode the three NAV-relevant
 * fields. Returns `null` if the account is missing (vault not yet
 * initialized — caller should treat as "skip the check").
 */
async function readRwtVaultSnapshot(
  conn: Connection,
  vaultPda: PublicKey,
): Promise<RwtVaultSnapshot | null> {
  const info = await conn.getAccountInfo(vaultPda, 'confirmed');
  if (!info) return null;
  const buf = Buffer.from(info.data);
  if (buf.length < 40) {
    throw new Error(
      `rwt_vault account too small: ${buf.length} bytes (want >= 40)`,
    );
  }
  // u128 LE: low u64 (bytes 8..16) + high u64 (bytes 16..24) << 64.
  const lo = buf.readBigUInt64LE(8);
  const hi = buf.readBigUInt64LE(16);
  const totalInvestedCapital = lo + (hi << 64n);
  const totalRwtSupply = buf.readBigUInt64LE(24);
  const navBookValue = buf.readBigUInt64LE(32);
  return { totalInvestedCapital, totalRwtSupply, navBookValue };
}

// 6-decimal NAV scale, matches contracts/rwt-engine/src/constants.rs::NAV_SCALE.
// NAV = total_invested_capital * NAV_SCALE / total_rwt_supply.
const NAV_SCALE = 1_000_000n;
// $1.00 expressed in raw NAV (6 decimals).
const INITIAL_NAV = NAV_SCALE;
// Tolerance for the post-bootstrap NAV check. Bootstrap uses equal raw amounts
// for `rwt_amount` + `backing_capital_usd`, so NAV should land exactly on
// $1.0; a smoke `mint_rwt` between bootstrap phases (none currently, but
// defensive) could shift it by a few raw units. ±0.5% is well below any
// real-world drift but catches the "10000x off" bug the invariant was added
// to detect.
const NAV_TOLERANCE_BPS = 50n;

/**
 * Post-bootstrap NAV invariant check.
 *
 * Asserts NAV ≈ $1.00 after the init phases complete. Catches the
 * "admin_mint_rwt without matching backing_capital_usd" regression where
 * `total_rwt_supply` grows but `total_invested_capital` does not, dropping
 * per-token NAV to a tiny fraction of $1.
 *
 * Skipped (warning, not error) if the vault account is missing — that means
 * `phaseRwtVault` itself was skipped (e.g. IDL missing `initialize_vault`),
 * and the warning surfaces in the same list as other init skips.
 */
async function phaseAssertNavInvariant(
  conn: Connection,
  art: Artifact,
): Promise<void> {
  if (!art.pdas?.rwt_vault) {
    warn('phase-z', 'rwt_vault PDA missing from artifact; skipping NAV check');
    return;
  }
  const vaultPda = new PublicKey(art.pdas.rwt_vault);
  const snap = await readRwtVaultSnapshot(conn, vaultPda);
  if (!snap) {
    warn(
      'phase-z',
      `rwt_vault account not found at ${vaultPda.toBase58()}; skipping NAV check`,
    );
    return;
  }

  // Zero-supply case: NAV is $1.0 by short-circuit in `calculate_nav`. No
  // capital mints happened — nothing to check beyond reporting state.
  if (snap.totalRwtSupply === 0n) {
    log(
      'phase-z',
      `NAV check: supply=0 → NAV = $1.00 by zero-supply short-circuit (capital=${snap.totalInvestedCapital.toString()})`,
    );
    return;
  }

  // Compute NAV the same way the contract does. We do this in BigInt to
  // mirror the on-chain u128 arithmetic exactly — no float drift.
  const navComputed =
    (snap.totalInvestedCapital * NAV_SCALE) / BigInt(snap.totalRwtSupply);
  const lower = INITIAL_NAV - (INITIAL_NAV * NAV_TOLERANCE_BPS) / 10_000n;
  const upper = INITIAL_NAV + (INITIAL_NAV * NAV_TOLERANCE_BPS) / 10_000n;

  const navDollars = (Number(navComputed) / Number(NAV_SCALE)).toFixed(6);
  const supplyDecimal = (Number(snap.totalRwtSupply) / Number(NAV_SCALE)).toFixed(6);
  const capitalDecimal = (
    Number(snap.totalInvestedCapital) / Number(NAV_SCALE)
  ).toFixed(6);

  if (navComputed < lower || navComputed > upper) {
    throw new Error(
      `NAV invariant violated: NAV = ${navDollars} USDC (raw ${navComputed.toString()}) ` +
        `is outside ±${NAV_TOLERANCE_BPS.toString()} bps of $1.00. ` +
        `supply=${supplyDecimal} RWT (raw ${snap.totalRwtSupply.toString()}), ` +
        `capital=${capitalDecimal} USDC (raw ${snap.totalInvestedCapital.toString()}). ` +
        `Bootstrap must pair every admin_mint_rwt(rwt_amount=N) with ` +
        `backing_capital_usd=N to preserve NAV=$1.0. ` +
        `See docs/economics/rwt-real-world-token.mdx.`,
    );
  }

  log(
    'phase-z',
    `NAV invariant OK: NAV = ${navDollars} USDC ` +
      `(supply=${supplyDecimal} RWT, capital=${capitalDecimal} USDC, nav_book=${snap.navBookValue.toString()})`,
  );
}

// --------------------------------------------------------------------------
// Argv parsing
// --------------------------------------------------------------------------

interface Argv {
  artifact: string;
  otCount: number;
  /**
   * Cluster override. When set, overrides the `bootstrap_target` field in
   * the loaded artifact. Used by the devnet redeploy harness
   * (scripts/deploy-devnet.sh) to point this driver at a devnet artifact
   * without the localhost-only guard tripping.
   *
   * Accepted values: 'localhost' | 'devnet' (mainnet is intentionally
   * NOT supported — mainnet bootstrap uses scripts/deploy.sh which calls
   * this driver through e2e-bootstrap.sh's localhost path).
   */
  cluster?: 'localhost' | 'devnet';
  /**
   * RPC URL override. When set, overrides `art.rpc_url` from the loaded
   * artifact. Mainly useful when the artifact was generated on a different
   * host than the one running this driver (e.g. CI runner vs deployer VM).
   */
  rpc?: string;
}

function parseArgv(): Argv {
  const args = process.argv.slice(2);
  let artifact = DEFAULT_ARTIFACT_PATH;
  let otCount = DEFAULT_OT_COUNT;
  let cluster: Argv['cluster'];
  let rpc: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--artifact' && next !== undefined) {
      artifact = next;
      i++;
    } else if (a === '--ot-count' && next !== undefined) {
      otCount = parseInt(next, 10);
      i++;
    } else if (a === '--cluster' && next !== undefined) {
      if (next !== 'localhost' && next !== 'devnet') {
        throw new Error(`--cluster must be 'localhost' or 'devnet'; got '${next}'`);
      }
      cluster = next;
      i++;
    } else if (a === '--rpc' && next !== undefined) {
      rpc = next;
      i++;
    }
  }
  if (!Number.isFinite(otCount) || otCount < 0) otCount = DEFAULT_OT_COUNT;
  return { artifact, otCount, cluster, rpc };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = parseArgv();
  log('main', `loading artifact ${argv.artifact}`);
  const art = loadArtifact(argv.artifact);

  // CLI overrides take precedence over the artifact's stored values. This
  // enables the devnet redeploy harness (scripts/deploy-devnet.sh) to
  // reuse this driver against a devnet artifact:
  //   - `--cluster devnet` relaxes the localhost-only guard;
  //   - `--rpc <url>` swaps the on-chain RPC endpoint.
  if (argv.cluster) {
    art.bootstrap_target = argv.cluster;
  }
  if (argv.rpc) {
    art.rpc_url = argv.rpc;
  }

  if (art.bootstrap_target !== 'localhost' && art.bootstrap_target !== 'devnet') {
    throw new Error(
      `bootstrap-init.ts supports localhost|devnet, got ${art.bootstrap_target}`,
    );
  }

  const conn = new Connection(art.rpc_url, 'confirmed');
  const deployer = loadKeypair(art.deployer_keypair_path);
  log('main', `cluster=${art.bootstrap_target}, deployer=${deployer.publicKey.toBase58()}, rpc=${art.rpc_url}`);

  const t0 = Date.now();

  await phaseMints(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseSingletons(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseRwtVault(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseYdConfig(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseLiquidityHolding(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseNexus(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseMasterPool(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseOts(conn, deployer, art, argv.otCount);
  saveArtifact(argv.artifact, art);

  await phaseUsdcSupply(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  // ---------------------------------------------------------------------
  // Layer 10 substep 2 — Phase 3 SPRK OT bootstrap (plan §63-77).
  // Runs AFTER phaseOts so the SPRK OT config / governance / distributor
  // accounts exist, and BEFORE any authority-transfer phase (R-B
  // mitigation: mint_ot must happen while deployer is still OT authority).
  // ---------------------------------------------------------------------
  await phaseFutarchy(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseSprkDistributor(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseDestinations(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseSprkMint(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  // ---------------------------------------------------------------------
  // Layer 10 substep 2 — Phase 4 step 2 (SPRK/RWT StandardCurve pool).
  // Master RWT/USDC concentrated pool was created in phaseMasterPool above
  // (Phase 4 step 3 + 4); the SPRK/RWT pair pool is the second pool of
  // Phase 4. Seeding requires SPRK initial supply minted in phaseSprkMint.
  // ---------------------------------------------------------------------
  await phaseSprkRwtPool(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  // ---------------------------------------------------------------------
  // Layer 10 substep 2 — Phase 6 bot wallet registration (plan §98-105).
  // Consumes pool-rebalancer + rwt-manager keypairs generated by stage_bots
  // in e2e-bootstrap.sh (R-J / D39).
  // ---------------------------------------------------------------------
  await phaseRegisterBots(conn, deployer, art);

  // ============================================================================
  // SUBSTEP 3 HARD-GATE — R-B mitigation
  // DO NOT INSERT ANY AUTHORITY-TRANSFER PHASE BEFORE THIS LINE.
  // phaseSprkMint MUST run before any deployer→Futarchy / deployer→Multisig
  // authority handover, otherwise mint_ot fails with `has_one = authority`
  // and SPRK initial supply is permanently unmintable.
  // ============================================================================

  // Post-bootstrap RWT NAV invariant check. Catches regressions where
  // `admin_mint_rwt(rwt_amount=N)` is called without a matching
  // `backing_capital_usd=N`, leaving per-token NAV << $1.0 and inverting
  // the frontend's RWT economics. Runs after every init phase so it sees
  // the final supply/capital state from both phase-f and phase-l mints.
  await phaseAssertNavInvariant(conn, art);

  art.init_completed_at = new Date().toISOString();
  saveArtifact(argv.artifact, art);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log('main', `init complete in ${elapsed}s`);
  if (art.init_skipped && art.init_skipped.length > 0) {
    log('main', `skipped phases (${art.init_skipped.length}):`);
    for (const s of art.init_skipped) {
      log('main', `  - ${s}`);
    }
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  console.error(`[bootstrap-init] FATAL: ${msg}`);
  process.exit(1);
});
