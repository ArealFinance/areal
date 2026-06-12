#!/usr/bin/env tsx
/*
 * bootstrap-earn.ts — Phase 4.2c devnet bootstrap for the `earn` + `staking`
 * programs.
 *
 * The `earn` (HMBZu87F9zTt4JGbQwaL5V6tFXdLBUyLtgeYTsVh1Rzu) and `staking`
 * (3WFdgqHFUnqtZoKQLpj8pQPd3ecitBGG9M2eBmaup8JL) programs are deployed to
 * devnet but NOT initialized. This script brings their singleton config PDAs
 * online, idempotently:
 *
 *   1. Derive EarnConfig + StakingConfig PDAs.
 *   2. Create the earn-RWT mint (NEW, distinct from the main-app rwt-engine
 *      RWT). Mint authority = EarnConfig PDA, 6 decimals.
 *   3. (staking) stRWT mint is NOT pre-created here — staking.initialize
 *      creates it in-handler (CreateAccount + InitializeMint2). We only
 *      generate a fresh signer keypair for it and co-sign the init tx.
 *   4. Prepare earn's token accounts: dao_fee_destination is a USDC ATA owned
 *      by deployer. basket_vault is now an EXTERNAL USDC treasury token account
 *      (NOT owned by the EarnConfig PDA — the program no longer custodies USDC)
 *      and is no longer passed to earn.initialize; it is set AFTER init via
 *      earn.update_config. The staking pool_vault is created or accepted by
 *      staking.initialize via the Associated Token Program CPI.
 *   5. earn.initialize(authority=deployer) — basket_vault is NOT an account
 *      here anymore; config.basket_vault is left zeroed by the handler.
 *   5b. (optional) earn.seed_genesis(amount) — ONE-TIME founder genesis mint of
 *      earn-RWT against an off-chain RWA. Mints `amount` earn-RWT to a treasury
 *      ATA and sets total_invested_capital = amount (NAV $1.00); no USDC. Opt-in
 *      via EARN_GENESIS_RWT (base units, 6dp); skipped when unset/0 or when the
 *      earn-RWT supply is already non-zero (genesis already done). Recipient
 *      wallet = EARN_GENESIS_RECIPIENT, defaulting to the deployer.
 *   6. earn.update_config(...) to SET basket_vault to the external treasury
 *      USDC account (mint_rwt / add_to_basket revert BasketVaultNotSet until
 *      this runs). dao_fee_destination MUST differ from basket_vault.
 *   7. staking.initialize(reward_depositor=deployer) — authority is taken
 *      from the signer, NOT an arg.
 *   8. Journal everything into data/devnet-addresses.json under an `earn`
 *      section (atomic tmp + rename).
 *
 * Account-creation model — VERIFIED against the contract structs:
 *   - contracts/earn/src/instructions/initialize.rs: EXPECTS pre-created
 *     rwt_mint (authority already = EarnConfig PDA) and dao_fee_destination (a
 *     USDC token account). basket_vault is NO LONGER an initialize account —
 *     the handler leaves config.basket_vault zeroed and it is set later via
 *     update_config. The handler only writes EarnConfig; it does NOT create any
 *     token account or mint.
 *   - contracts/earn/src/instructions/update_config.rs: sets the external
 *     basket_vault (and re-affirms mint_fee_bps / min_mint_amount /
 *     dao_fee_destination). Rejects a zero basket_vault (ZeroBasketVault) and a
 *     basket_vault equal to dao_fee_destination (FeeDestinationIsBasketVault).
 *   - contracts/staking/src/instructions/initialize.rs: CREATES the strwt_mint
 *     (System CreateAccount + Token InitializeMint2, authority = StakingConfig
 *     PDA) and the pool_vault (Associated Token Program Create, RWT ATA owned
 *     by the StakingConfig PDA) IN-HANDLER. So the script passes a fresh
 *     strwt_mint signer keypair and the *derived* pool_vault ATA address as a
 *     writable account. The handler creates or accepts the canonical
 *     pool_vault, then validates its mint/owner/program.
 *
 * Safety: DEFAULTS TO DRY-RUN. With --dry-run (or no flag) the script derives
 * everything, prints the plan, builds the txs and runs
 * connection.simulateTransaction (read-only). It only sends transactions when
 * --execute is passed.
 *
 * Usage (from repo root):
 *   npx tsx scripts/lib/bootstrap-earn.ts [--dry-run]      # default, no send
 *   npx tsx scripts/lib/bootstrap-earn.ts --execute        # actually sends
 *
 * Genesis seed (optional, opt-in):
 *   EARN_GENESIS_RWT=25000000000 npx tsx scripts/lib/bootstrap-earn.ts --execute
 *     # mints 25,000 earn-RWT (6dp) at genesis to the deployer's earn-RWT ATA.
 *   EARN_GENESIS_RECIPIENT=<wallet> overrides the recipient (default: deployer).
 *   Unset/0 EARN_GENESIS_RWT ⇒ the seed_genesis step is skipped.
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
  MINT_SIZE,
  ACCOUNT_SIZE,
  getMinimumBalanceForRentExemptMint,
  getMinimumBalanceForRentExemptAccount,
  createInitializeMint2Instruction,
  createInitializeAccountInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
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

// On-chain seeds (must match contracts/<prog>/src/constants.rs).
//   earn:    EARN_CONFIG_SEED    = b"earn_config"
//   staking: STAKING_CONFIG_SEED = b"staking_config"
const EARN_CONFIG_SEED = Buffer.from('earn_config');
const STAKING_CONFIG_SEED = Buffer.from('staking_config');

// Token decimals (contracts/earn::RWT_DECIMALS=6, staking::STRWT_DECIMALS=6).
const EARN_RWT_DECIMALS = 6;
const STRWT_DECIMALS = 6;

// Instruction discriminators (8-byte sha256, from the generated bindings):
//   sdk/src/programs/earn/instructions.generated.ts    INITIALIZE_DISCRIMINATOR
//   sdk/src/programs/staking/instructions.generated.ts INITIALIZE_DISCRIMINATOR
// Both `initialize` ix happen to share the same discriminator (same ix name).
const EARN_INITIALIZE_DISCRIMINATOR = Buffer.from([
  0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed,
]);
const STAKING_INITIALIZE_DISCRIMINATOR = Buffer.from([
  0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed,
]);
// earn.update_config (from sdk/src/programs/earn/instructions.generated.ts
// UPDATE_CONFIG_DISCRIMINATOR). Used to SET the external basket_vault after init.
const EARN_UPDATE_CONFIG_DISCRIMINATOR = Buffer.from([
  0x1d, 0x9e, 0xfc, 0xbf, 0x0a, 0x53, 0xdb, 0x63,
]);
// earn.seed_genesis (from sdk/src/programs/earn/instructions.generated.ts
// SEED_GENESIS_DISCRIMINATOR == sha256("global:seed_genesis")[0..8]). One-time
// founder genesis mint: records an off-chain RWA's value as the initial
// total_invested_capital and mints the matching earn-RWT at NAV $1.00 (no USDC).
const EARN_SEED_GENESIS_DISCRIMINATOR = Buffer.from([
  0xb8, 0x20, 0x6c, 0x56, 0x9a, 0x4e, 0xbc, 0xa0,
]);

// earn.update_config arg defaults (contracts/earn/src/constants.rs). initialize
// seeds the config with these, so re-affirming them in update_config is a no-op
// that only changes basket_vault. Bounds are also enforced on-chain.
const EARN_DEFAULT_MINT_FEE_BPS = 100; // 1% — DEFAULT_MINT_FEE_BPS
const EARN_DEFAULT_MIN_MINT_AMOUNT = 1_000_000n; // $1.00 — MIN_MINT_AMOUNT

// Account discriminators (from sdk/src/programs/*/accounts.generated.ts).
const EARN_CONFIG_DISCRIMINATOR = Buffer.from([
  0x8f, 0x6e, 0x3f, 0xb5, 0x95, 0x8c, 0xbe, 0x90,
]);
const STAKING_CONFIG_DISCRIMINATOR = Buffer.from([
  0x2d, 0x86, 0xfc, 0x52, 0x25, 0x39, 0x54, 0x19,
]);

// SPL Token mint account layout offsets we need for idempotency reads.
//   mint_authority option: bytes [0..4) = COption tag, [4..36) = authority
//   supply: bytes [36..44)
const MINT_AUTHORITY_TAG_OFFSET = 0;
const MINT_AUTHORITY_OFFSET = 4;
// Mint supply (u64 LE) starts right after the 36-byte COption<authority> prefix.
// Used by seed_genesis idempotency: a non-zero supply means genesis already ran.
const MINT_SUPPLY_OFFSET = 36;

// EarnConfig layout offsets including the 8-byte Arlex account discriminator.
// See contracts/earn/src/state.rs (data running offsets:
// 16,48,80,81,83,115,147,179,211,219,220).
const EARN_CONFIG_ACCOUNT_LENGTH = 228;
const EARN_CONFIG_MINT_FEE_BPS_OFFSET = 8 + 81;
const EARN_CONFIG_BASKET_VAULT_OFFSET = 8 + 83;
const EARN_CONFIG_DAO_FEE_DESTINATION_OFFSET = 8 + 115;
const EARN_CONFIG_RWT_MINT_OFFSET = 8 + 147;
const EARN_CONFIG_USDC_MINT_OFFSET = 8 + 179;
const EARN_CONFIG_MIN_MINT_AMOUNT_OFFSET = 8 + 211;

// StakingConfig layout offsets including the 8-byte Arlex discriminator.
// See contracts/staking/src/state.rs (data running offsets:
// 32,64,65,97,129,161,193,201,209,217,225,226).
const STAKING_CONFIG_ACCOUNT_LENGTH = 234;
const STAKING_CONFIG_RWT_MINT_OFFSET = 8 + 65;
const STAKING_CONFIG_STRWT_MINT_OFFSET = 8 + 97;
const STAKING_CONFIG_POOL_VAULT_OFFSET = 8 + 161;

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function log(stage: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[bootstrap-earn] [${stage}] ${msg}`;
  if (extra) console.log(line, JSON.stringify(extra));
  else console.log(line);
}

function warn(stage: string, msg: string): void {
  console.warn(`[bootstrap-earn] [${stage}] WARN: ${msg}`);
}

// --------------------------------------------------------------------------
// devnet-addresses.json I/O
// --------------------------------------------------------------------------

interface DevnetAddresses {
  cluster: string;
  rpc: { http: string; ws?: string; airdrop_http?: string };
  deployer: { keypair_path: string; pubkey: string };
  programs: Record<string, { pubkey: string }>;
  mints: { usdc: string; rwt?: string; [k: string]: string | undefined };
  earn?: EarnSection;
  [k: string]: unknown;
}

interface EarnSection {
  earn_rwt_mint?: string;
  strwt_mint?: string;
  // basket_vault is now an EXTERNAL USDC treasury token account (NOT owned by
  // the EarnConfig PDA) set via update_config after init.
  basket_vault?: string;
  // Owner of the external basket_vault treasury account (deployer by default,
  // or the EARN_TREASURY wallet). Recorded for audit; not used on-chain.
  basket_vault_owner?: string;
  dao_fee_destination?: string;
  pool_vault?: string;
  earn_config_pda?: string;
  staking_config_pda?: string;
  // Genesis seed (earn.seed_genesis) — recorded for audit. Only present when a
  // genesis was requested (EARN_GENESIS_RWT > 0). The mint lands at NAV $1.00:
  // total_invested_capital == genesis_rwt_amount, no USDC deposited.
  genesis_recipient_ata?: string;
  genesis_recipient_owner?: string;
  genesis_rwt_amount?: string;
  genesis_nav_note?: string;
  bootstrapped_at?: string;
  // Secret material: the earn-RWT + stRWT mint keypair bytes (base64). Needed
  // for warm restarts so re-runs reuse the same mints instead of generating
  // fresh ones. (The stRWT mint must be re-created with the SAME keypair if
  // staking.initialize failed mid-way.)
  earn_rwt_mint_keypair_b64?: string;
  strwt_mint_keypair_b64?: string;
  // Secret material: the default (deployer-owned) basket_vault treasury token
  // account keypair (base64). Only present when the treasury is a fresh
  // script-generated token account (no EARN_BASKET_VAULT / EARN_TREASURY env).
  // Lets warm restarts reuse the same treasury account instead of generating a
  // fresh one. When an external treasury is configured via env, this is absent.
  basket_vault_keypair_b64?: string;
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

function keypairToB64(kp: Keypair): string {
  return Buffer.from(kp.secretKey).toString('base64');
}

function keypairFromB64(b64: string): Keypair {
  return Keypair.fromSecretKey(Buffer.from(b64, 'base64'));
}

// --------------------------------------------------------------------------
// PDA helpers
// --------------------------------------------------------------------------

function findPda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function findAta(owner: PublicKey, mint: PublicKey, allowOwnerOffCurve = false): PublicKey {
  // For PDA owners (basket_vault / pool_vault) the owner is off-curve, so
  // allowOwnerOffCurve must be true.
  return getAssociatedTokenAddressSync(
    mint,
    owner,
    allowOwnerOffCurve,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

// --------------------------------------------------------------------------
// Instruction encoders (inlined — the published @areal/sdk in bots/
// node_modules does not yet ship earn/staking; the encoders are trivial
// discriminator + fixed [u8;32] args). Mirrors the generated bindings:
//   earn.initialize(authority)
//   staking.initialize(reward_depositor)
// Staking's `authority` is the signer account, NOT an arg.
// --------------------------------------------------------------------------

function encodeEarnInitializeArgs(authority: PublicKey): Buffer {
  return Buffer.concat([
    EARN_INITIALIZE_DISCRIMINATOR,
    Buffer.from(authority.toBytes()),
  ]);
}

function encodeStakingInitializeArgs(rewardDepositor: PublicKey): Buffer {
  return Buffer.concat([
    STAKING_INITIALIZE_DISCRIMINATOR,
    Buffer.from(rewardDepositor.toBytes()),
  ]);
}

// earn.update_config(mint_fee_bps: u16, min_mint_amount: u64,
//                    dao_fee_destination: [u8;32], basket_vault: [u8;32])
// Borsh wire order: u16 (LE), u64 (LE), then two 32-byte arrays.
function encodeEarnUpdateConfigArgs(
  mintFeeBps: number,
  minMintAmount: bigint,
  daoFeeDestination: PublicKey,
  basketVault: PublicKey,
): Buffer {
  const feeBuf = Buffer.alloc(2);
  feeBuf.writeUInt16LE(mintFeeBps, 0);
  const minBuf = Buffer.alloc(8);
  minBuf.writeBigUInt64LE(minMintAmount, 0);
  return Buffer.concat([
    EARN_UPDATE_CONFIG_DISCRIMINATOR,
    feeBuf,
    minBuf,
    Buffer.from(daoFeeDestination.toBytes()),
    Buffer.from(basketVault.toBytes()),
  ]);
}

// earn.seed_genesis(amount: u64). Borsh wire order: a single u64 (LE).
function encodeEarnSeedGenesisArgs(amount: bigint): Buffer {
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amount, 0);
  return Buffer.concat([EARN_SEED_GENESIS_DISCRIMINATOR, amountBuf]);
}

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({
  pubkey,
  isSigner,
  isWritable,
});

// --------------------------------------------------------------------------
// On-chain reads (idempotency)
// --------------------------------------------------------------------------

async function accountExists(conn: Connection, addr: PublicKey): Promise<boolean> {
  const info = await conn.getAccountInfo(addr, 'confirmed');
  return info !== null;
}

interface OnchainEarnConfig {
  mintFeeBps: number;
  basketVault: PublicKey;
  daoFeeDestination: PublicKey;
  rwtMint: PublicKey;
  usdcMint: PublicKey;
  minMintAmount: bigint;
}

interface OnchainStakingConfig {
  rwtMint: PublicKey;
  strwtMint: PublicKey;
  poolVault: PublicKey;
}

function readPubkeyAt(data: Buffer, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}

async function readInitializedConfigData(
  conn: Connection,
  addr: PublicKey,
  programId: PublicKey,
  discriminator: Buffer,
  label: string,
): Promise<Buffer | null> {
  const info = await conn.getAccountInfo(addr, 'confirmed');
  if (!info) return null;

  if (info.owner.equals(SYSTEM_PROGRAM_ID)) {
    warn(
      'config-prefund',
      `${label} ${addr.toBase58()} is system-owned; treating it as an uninitialized prefund`,
    );
    return null;
  }

  if (!info.owner.equals(programId)) {
    throw new Error(
      `${label} ${addr.toBase58()} owner ${info.owner.toBase58()} != program ${programId.toBase58()}`,
    );
  }

  if (
    info.data.length < discriminator.length ||
    !Buffer.from(info.data.subarray(0, discriminator.length)).equals(discriminator)
  ) {
    throw new Error(`${label} ${addr.toBase58()} has program owner but wrong discriminator`);
  }

  return Buffer.from(info.data);
}

function readEarnConfig(data: Buffer, addr: PublicKey): OnchainEarnConfig {
  if (data.length !== EARN_CONFIG_ACCOUNT_LENGTH) {
    throw new Error(
      `EarnConfig ${addr.toBase58()} length ${data.length} != ${EARN_CONFIG_ACCOUNT_LENGTH}; ` +
        'old paused layouts require a fresh rebootstrap or an explicit migration',
    );
  }
  return {
    mintFeeBps: data.readUInt16LE(EARN_CONFIG_MINT_FEE_BPS_OFFSET),
    basketVault: readPubkeyAt(data, EARN_CONFIG_BASKET_VAULT_OFFSET),
    daoFeeDestination: readPubkeyAt(data, EARN_CONFIG_DAO_FEE_DESTINATION_OFFSET),
    rwtMint: readPubkeyAt(data, EARN_CONFIG_RWT_MINT_OFFSET),
    usdcMint: readPubkeyAt(data, EARN_CONFIG_USDC_MINT_OFFSET),
    minMintAmount: data.readBigUInt64LE(EARN_CONFIG_MIN_MINT_AMOUNT_OFFSET),
  };
}

/** True when the on-chain basket_vault is the all-zero (unset) address. */
function isZeroPubkey(pk: PublicKey): boolean {
  return pk.equals(PublicKey.default);
}

function readStakingConfig(data: Buffer, addr: PublicKey): OnchainStakingConfig {
  if (data.length !== STAKING_CONFIG_ACCOUNT_LENGTH) {
    throw new Error(
      `StakingConfig ${addr.toBase58()} length ${data.length} != ${STAKING_CONFIG_ACCOUNT_LENGTH}; ` +
        'old paused layouts require a fresh rebootstrap or an explicit migration',
    );
  }
  return {
    rwtMint: readPubkeyAt(data, STAKING_CONFIG_RWT_MINT_OFFSET),
    strwtMint: readPubkeyAt(data, STAKING_CONFIG_STRWT_MINT_OFFSET),
    poolVault: readPubkeyAt(data, STAKING_CONFIG_POOL_VAULT_OFFSET),
  };
}

/** Returns the mint authority pubkey of an SPL mint, or null if unset/missing. */
async function readMintAuthority(conn: Connection, mint: PublicKey): Promise<PublicKey | null> {
  const info = await conn.getAccountInfo(mint, 'confirmed');
  if (!info || info.data.length < MINT_SIZE) return null;
  const tag = info.data.readUInt32LE(MINT_AUTHORITY_TAG_OFFSET);
  if (tag === 0) return null; // COption::None
  return new PublicKey(info.data.subarray(MINT_AUTHORITY_OFFSET, MINT_AUTHORITY_OFFSET + 32));
}

/**
 * Returns the current SPL mint supply (u64), or null if the mint does not yet
 * exist. seed_genesis is a ONE-TIME op gated on supply == 0 on-chain; we read
 * the supply here to skip the step cleanly when genesis already happened
 * (instead of relying on the contract's GenesisAlreadyComplete = 6027 revert).
 */
async function readMintSupply(conn: Connection, mint: PublicKey): Promise<bigint | null> {
  const info = await conn.getAccountInfo(mint, 'confirmed');
  if (!info || info.data.length < MINT_SIZE) return null;
  return info.data.readBigUInt64LE(MINT_SUPPLY_OFFSET);
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
  tx.sign(...signers);

  if (!execute) {
    const sim = await conn.simulateTransaction(tx);
    const err = sim.value.err;
    log('simulate', `${label}: ${err ? 'ERR' : 'OK'}`, {
      err: err ?? null,
      unitsConsumed: sim.value.unitsConsumed ?? null,
    });
    if (sim.value.logs) {
      for (const l of sim.value.logs) console.log(`    | ${l}`);
    }
    if (err) {
      throw new Error(`simulation failed for ${label}: ${JSON.stringify(err)}`);
    }
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
// Main
// --------------------------------------------------------------------------

interface Cli {
  execute: boolean;
  // Explicit external basket_vault USDC token-account address (highest
  // precedence). Set via the EARN_BASKET_VAULT env var. Used as-is.
  basketVaultOverride: PublicKey | null;
  // Treasury wallet whose USDC ATA becomes the basket_vault. Set via the
  // EARN_TREASURY env var. Lower precedence than EARN_BASKET_VAULT.
  treasuryOwnerOverride: PublicKey | null;
  // One-time founder genesis seed (earn.seed_genesis). Amount of earn-RWT to
  // mint at genesis, in base units (6dp): e.g. 25_000_000_000 = 25k RWT @ $1.00.
  // Set via EARN_GENESIS_RWT. 0n (unset/zero) ⇒ the seed_genesis step is SKIPPED.
  genesisAmount: bigint;
  // Wallet that receives the genesis mint; its earn-RWT ATA is the recipient and
  // is created idempotently. Set via EARN_GENESIS_RECIPIENT; defaults to the
  // deployer when unset.
  genesisRecipientOwner: PublicKey | null;
  // Optional pre-provisioned mint keypairs. When EARN_RWT_MINT_KEYPAIR /
  // STRWT_MINT_KEYPAIR point to a keypair file, that exact keypair is used to
  // create the mint (mainnet uses the vanity mints under keys/mainnet/). When
  // unset, the script generates a fresh keypair (devnet default). On a warm
  // restart the journaled `*_keypair_b64` / on-chain config still take
  // precedence over these — they only seed the cold-start case.
  earnRwtMintKeypair: Keypair | null;
  strwtMintKeypair: Keypair | null;
}

function parseArgs(argv: string[]): Cli {
  let execute = false;
  for (const a of argv) {
    if (a === '--execute') execute = true;
    else if (a === '--dry-run') execute = false;
    else {
      throw new Error(`unknown flag: ${a} (valid: --dry-run | --execute)`);
    }
  }

  // basket_vault treasury is sourced from the environment, not flags:
  //   EARN_BASKET_VAULT — explicit USDC token-account pubkey (used verbatim).
  //   EARN_TREASURY     — a wallet pubkey; basket_vault = its USDC ATA.
  // If neither is set, the script creates a fresh deployer-owned USDC token
  // account (external to the EarnConfig PDA) and journals it for reuse.
  const basketVaultOverride = process.env.EARN_BASKET_VAULT
    ? new PublicKey(process.env.EARN_BASKET_VAULT)
    : null;
  const treasuryOwnerOverride = process.env.EARN_TREASURY
    ? new PublicKey(process.env.EARN_TREASURY)
    : null;

  // Genesis seed is sourced from the environment, opt-in:
  //   EARN_GENESIS_RWT       — amount in base units (6dp). Unset/0 ⇒ skip the step.
  //   EARN_GENESIS_RECIPIENT — wallet that receives the mint (its earn-RWT ATA).
  //                            Defaults to the deployer when unset.
  let genesisAmount = 0n;
  if (process.env.EARN_GENESIS_RWT) {
    const raw = process.env.EARN_GENESIS_RWT.trim();
    if (!/^\d+$/.test(raw)) {
      throw new Error(
        `EARN_GENESIS_RWT must be a non-negative integer in base units (6dp), got "${raw}"`,
      );
    }
    genesisAmount = BigInt(raw);
  }
  const genesisRecipientOwner = process.env.EARN_GENESIS_RECIPIENT
    ? new PublicKey(process.env.EARN_GENESIS_RECIPIENT)
    : null;

  // Optional mint keypair files (mainnet vanity mints). Each, when set, must
  // point at a Solana keypair JSON (the same format as the deployer keypair).
  // The mint is then created at that exact (vanity) address. Unset ⇒ fresh
  // keypair generated downstream (devnet default).
  const earnRwtMintKeypair = process.env.EARN_RWT_MINT_KEYPAIR
    ? loadKeypair(process.env.EARN_RWT_MINT_KEYPAIR)
    : null;
  const strwtMintKeypair = process.env.STRWT_MINT_KEYPAIR
    ? loadKeypair(process.env.STRWT_MINT_KEYPAIR)
    : null;

  return {
    execute,
    basketVaultOverride,
    treasuryOwnerOverride,
    genesisAmount,
    genesisRecipientOwner,
    earnRwtMintKeypair,
    strwtMintKeypair,
  };
}

async function main(): Promise<void> {
  const {
    execute,
    basketVaultOverride,
    treasuryOwnerOverride,
    genesisAmount,
    genesisRecipientOwner,
    earnRwtMintKeypair,
    strwtMintKeypair,
  } = parseArgs(process.argv.slice(2));

  const art = loadAddresses();
  if (art.cluster !== 'devnet' || !art.rpc.http.includes('devnet')) {
    throw new Error(`refusing to run on non-devnet target (cluster=${art.cluster})`);
  }

  const rpcUrl = art.rpc.http;
  const conn = new Connection(rpcUrl, 'confirmed');

  const deployer = loadKeypair(join(REPO_ROOT, art.deployer.keypair_path));
  if (deployer.publicKey.toBase58() !== art.deployer.pubkey) {
    throw new Error(
      `deployer keypair ${deployer.publicKey.toBase58()} != addresses.json ${art.deployer.pubkey}`,
    );
  }

  const earnProgramId = new PublicKey(art.programs.earn!.pubkey);
  const stakingProgramId = new PublicKey(art.programs.staking!.pubkey);
  const usdcMint = new PublicKey(art.mints.usdc);

  // --- Step 1: derive config PDAs -----------------------------------------
  const [earnConfigPda, earnConfigBump] = findPda([EARN_CONFIG_SEED], earnProgramId);
  const [stakingConfigPda, stakingConfigBump] = findPda([STAKING_CONFIG_SEED], stakingProgramId);

  // --- Mint keypairs (reuse from journal on warm restart) ------------------
  const earnSection: EarnSection = { ...(art.earn ?? {}) };
  const earnConfigData = await readInitializedConfigData(
    conn,
    earnConfigPda,
    earnProgramId,
    EARN_CONFIG_DISCRIMINATOR,
    'EarnConfig',
  );
  const earnConfigExists = earnConfigData !== null;
  const onchainEarnConfig = earnConfigData ? readEarnConfig(earnConfigData, earnConfigPda) : null;
  const stakingConfigData = await readInitializedConfigData(
    conn,
    stakingConfigPda,
    stakingProgramId,
    STAKING_CONFIG_DISCRIMINATOR,
    'StakingConfig',
  );
  const stakingConfigExists = stakingConfigData !== null;
  const onchainStakingConfig = stakingConfigData
    ? readStakingConfig(stakingConfigData, stakingConfigPda)
    : null;
  if (onchainEarnConfig && !onchainEarnConfig.usdcMint.equals(usdcMint)) {
    throw new Error(
      `on-chain EarnConfig USDC mint ${onchainEarnConfig.usdcMint.toBase58()} != addresses.json ${usdcMint.toBase58()}`,
    );
  }

  let earnRwtMintKp: Keypair | null = null;
  let earnRwtMint: PublicKey;
  if (onchainEarnConfig) {
    earnRwtMint = onchainEarnConfig.rwtMint;
    if (earnSection.earn_rwt_mint && earnSection.earn_rwt_mint !== earnRwtMint.toBase58()) {
      throw new Error(
        `earn.earn_rwt_mint ${earnSection.earn_rwt_mint} != on-chain EarnConfig rwt_mint ${earnRwtMint.toBase58()}`,
      );
    }
    if (
      earnSection.dao_fee_destination &&
      earnSection.dao_fee_destination !== onchainEarnConfig.daoFeeDestination.toBase58()
    ) {
      throw new Error(
        `earn.dao_fee_destination ${earnSection.dao_fee_destination} != on-chain EarnConfig dao_fee_destination ` +
          `${onchainEarnConfig.daoFeeDestination.toBase58()}`,
      );
    }
    if (earnSection.earn_rwt_mint_keypair_b64) {
      const journalMintKp = keypairFromB64(earnSection.earn_rwt_mint_keypair_b64);
      if (!journalMintKp.publicKey.equals(earnRwtMint)) {
        throw new Error(
          `earn_rwt_mint_keypair ${journalMintKp.publicKey.toBase58()} != on-chain EarnConfig rwt_mint ${earnRwtMint.toBase58()}`,
        );
      }
      earnRwtMintKp = journalMintKp;
    }
  } else if (earnSection.earn_rwt_mint_keypair_b64) {
    // Warm restart: reuse the journaled mint keypair. If an env keypair is also
    // provided, it MUST match (otherwise we'd silently ignore the requested
    // vanity mint).
    earnRwtMintKp = keypairFromB64(earnSection.earn_rwt_mint_keypair_b64);
    earnRwtMint = earnRwtMintKp.publicKey;
    if (earnRwtMintKeypair && !earnRwtMintKeypair.publicKey.equals(earnRwtMint)) {
      throw new Error(
        `EARN_RWT_MINT_KEYPAIR ${earnRwtMintKeypair.publicKey.toBase58()} != journaled ` +
          `earn-RWT mint ${earnRwtMint.toBase58()} (clear the journal to switch mints)`,
      );
    }
  } else if (earnRwtMintKeypair) {
    // Cold start with a pre-provisioned mint keypair (e.g. mainnet vanity mint
    // keys/mainnet/rwt-mint.json). Create the mint at that exact address.
    earnRwtMintKp = earnRwtMintKeypair;
    earnRwtMint = earnRwtMintKp.publicKey;
  } else {
    // Cold start, no override: generate a fresh mint (devnet default).
    earnRwtMintKp = Keypair.generate();
    earnRwtMint = earnRwtMintKp.publicKey;
  }

  if (onchainStakingConfig && !onchainStakingConfig.rwtMint.equals(earnRwtMint)) {
    throw new Error(
      `on-chain StakingConfig rwt_mint ${onchainStakingConfig.rwtMint.toBase58()} != earn-RWT mint ${earnRwtMint.toBase58()}`,
    );
  }

  let strwtMintKp: Keypair | null = null;
  let strwtMint: PublicKey;
  if (onchainStakingConfig) {
    strwtMint = onchainStakingConfig.strwtMint;
    if (earnSection.strwt_mint && earnSection.strwt_mint !== strwtMint.toBase58()) {
      throw new Error(
        `earn.strwt_mint ${earnSection.strwt_mint} != on-chain StakingConfig strwt_mint ${strwtMint.toBase58()}`,
      );
    }
    if (earnSection.strwt_mint_keypair_b64) {
      const journalStrwtMintKp = keypairFromB64(earnSection.strwt_mint_keypair_b64);
      if (!journalStrwtMintKp.publicKey.equals(strwtMint)) {
        throw new Error(
          `strwt_mint_keypair ${journalStrwtMintKp.publicKey.toBase58()} != on-chain StakingConfig strwt_mint ${strwtMint.toBase58()}`,
        );
      }
      strwtMintKp = journalStrwtMintKp;
    }
  } else if (earnSection.strwt_mint_keypair_b64) {
    // Warm restart: reuse the journaled stRWT mint keypair. An env keypair, if
    // provided, MUST match.
    strwtMintKp = keypairFromB64(earnSection.strwt_mint_keypair_b64);
    strwtMint = strwtMintKp.publicKey;
    if (strwtMintKeypair && !strwtMintKeypair.publicKey.equals(strwtMint)) {
      throw new Error(
        `STRWT_MINT_KEYPAIR ${strwtMintKeypair.publicKey.toBase58()} != journaled ` +
          `stRWT mint ${strwtMint.toBase58()} (clear the journal to switch mints)`,
      );
    }
  } else if (strwtMintKeypair) {
    // Cold start with a pre-provisioned stRWT mint keypair (e.g. mainnet vanity
    // mint keys/mainnet/strwt-mint.json). staking.initialize creates the mint
    // at this exact address (it co-signs with this keypair).
    strwtMintKp = strwtMintKeypair;
    strwtMint = strwtMintKp.publicKey;
  } else {
    // Cold start, no override: generate a fresh stRWT mint (devnet default).
    strwtMintKp = Keypair.generate();
    strwtMint = strwtMintKp.publicKey;
  }

  // dao_fee_destination: USDC ATA owned by deployer until EarnConfig exists;
  // after init, read the actual value from on-chain config because it is
  // tunable via update_config. (Derived before basket_vault because the
  // default fresh-treasury branch must guarantee basket_vault != dao_fee.)
  const daoFeeDestination = onchainEarnConfig?.daoFeeDestination ?? findAta(deployer.publicKey, usdcMint, false);

  // --- basket_vault: EXTERNAL USDC treasury (NOT owned by the EarnConfig PDA) -
  // The program no longer custodies USDC; basket_vault is an external treasury
  // token account set via update_config AFTER init. Source precedence:
  //   1. EARN_BASKET_VAULT — explicit USDC token-account pubkey (used as-is).
  //   2. EARN_TREASURY     — a wallet; basket_vault = its USDC ATA (idempotent).
  //   3. default           — a fresh deployer-owned USDC token account (signer),
  //                          journaled for warm-restart reuse. Owner = deployer,
  //                          so it stays distinct from the EarnConfig PDA and is
  //                          NOT the deployer's USDC ATA (= dao_fee_destination).
  // If EarnConfig already pins a basket_vault, that on-chain value wins.
  let basketVaultKp: Keypair | null = null; // only set for the default fresh-treasury branch
  let basketVault: PublicKey;
  let basketVaultOwner: PublicKey; // deployer or EARN_TREASURY; informational
  let basketVaultSource: string;
  if (onchainEarnConfig && !isZeroPubkey(onchainEarnConfig.basketVault)) {
    // Already configured on-chain (a prior update_config ran): pin to it.
    basketVault = onchainEarnConfig.basketVault;
    basketVaultOwner = deployer.publicKey; // owner unknowable from config; informational only
    basketVaultSource = 'on-chain EarnConfig (already set)';
    if (earnSection.basket_vault && earnSection.basket_vault !== basketVault.toBase58()) {
      throw new Error(
        `earn.basket_vault ${earnSection.basket_vault} != on-chain EarnConfig basket_vault ${basketVault.toBase58()}`,
      );
    }
  } else if (basketVaultOverride) {
    basketVault = basketVaultOverride;
    basketVaultOwner = deployer.publicKey; // unknown for an opaque token account; informational
    basketVaultSource = 'EARN_BASKET_VAULT env (explicit token account)';
  } else if (treasuryOwnerOverride) {
    basketVaultOwner = treasuryOwnerOverride;
    basketVault = findAta(treasuryOwnerOverride, usdcMint, true);
    basketVaultSource = 'EARN_TREASURY env (treasury wallet USDC ATA)';
  } else if (earnSection.basket_vault_keypair_b64) {
    // Warm restart of the default fresh-treasury branch: reuse the journaled
    // deployer-owned treasury token account.
    basketVaultKp = keypairFromB64(earnSection.basket_vault_keypair_b64);
    basketVault = basketVaultKp.publicKey;
    basketVaultOwner = deployer.publicKey;
    basketVaultSource = 'journaled deployer-owned treasury token account (reused)';
  } else {
    basketVaultKp = Keypair.generate();
    basketVault = basketVaultKp.publicKey;
    basketVaultOwner = deployer.publicKey;
    basketVaultSource = 'fresh deployer-owned treasury token account (generated)';
  }
  // Contract invariant: basket_vault MUST differ from dao_fee_destination
  // (FeeDestinationIsBasketVault). Fail fast with a clear message instead of an
  // opaque on-chain custom error.
  if (basketVault.equals(daoFeeDestination)) {
    throw new Error(
      `basket_vault ${basketVault.toBase58()} must differ from dao_fee_destination ` +
        `${daoFeeDestination.toBase58()} (contract rejects FeeDestinationIsBasketVault). ` +
        'Configure a distinct EARN_BASKET_VAULT / EARN_TREASURY treasury account.',
    );
  }
  if (earnSection.basket_vault && earnSection.basket_vault !== basketVault.toBase58()) {
    throw new Error(
      `earn.basket_vault ${earnSection.basket_vault} != resolved basket_vault ${basketVault.toBase58()}`,
    );
  }
  // pool_vault: earn-RWT ATA owned by StakingConfig PDA. Before staking init
  // it is the canonical derived ATA; after init, read the pinned on-chain value.
  const canonicalPoolVault = findAta(stakingConfigPda, earnRwtMint, true);
  const poolVault = onchainStakingConfig?.poolVault ?? canonicalPoolVault;
  if (onchainStakingConfig && !poolVault.equals(canonicalPoolVault)) {
    throw new Error(
      `on-chain StakingConfig pool_vault ${poolVault.toBase58()} != canonical ATA ${canonicalPoolVault.toBase58()}`,
    );
  }
  if (earnSection.pool_vault && earnSection.pool_vault !== poolVault.toBase58()) {
    throw new Error(
      `earn.pool_vault ${earnSection.pool_vault} != expected staking pool_vault ${poolVault.toBase58()}`,
    );
  }

  // --- genesis seed recipient (earn.seed_genesis) --------------------------
  // The genesis mint lands in the treasury wallet's earn-RWT ATA. The treasury
  // wallet defaults to the deployer (EARN_GENESIS_RECIPIENT overrides it). The
  // ATA is an on-curve wallet ATA, so allowOwnerOffCurve = false.
  const genesisEnabled = genesisAmount > 0n;
  const genesisRecipientWallet = genesisRecipientOwner ?? deployer.publicKey;
  const genesisRecipientAta = findAta(genesisRecipientWallet, earnRwtMint, false);

  // --- Plan print ----------------------------------------------------------
  console.log('\n================ bootstrap-earn PLAN ================');
  console.log(`mode:                 ${execute ? 'EXECUTE (will send)' : 'DRY-RUN (simulate only)'}`);
  console.log(`rpc:                  ${rpcUrl}`);
  console.log(`deployer:             ${deployer.publicKey.toBase58()}`);
  console.log(`earn program:         ${earnProgramId.toBase58()}`);
  console.log(`staking program:      ${stakingProgramId.toBase58()}`);
  console.log(`usdc mint:            ${usdcMint.toBase58()}`);
  console.log('--- derived PDAs ---');
  console.log(`earn_config PDA:      ${earnConfigPda.toBase58()} (bump ${earnConfigBump})`);
  console.log(`staking_config PDA:   ${stakingConfigPda.toBase58()} (bump ${stakingConfigBump})`);
  console.log('--- mints ---');
  console.log(`earn-RWT mint:        ${earnRwtMint.toBase58()} (auth=earn_config PDA, 6 dec)`);
  console.log(`stRWT mint:           ${strwtMint.toBase58()} (created in-handler, auth=staking_config PDA, 6 dec)`);
  console.log('--- token accounts ---');
  console.log(`basket_vault (USDC):  ${basketVault.toBase58()} (EXTERNAL treasury; ${basketVaultSource})`);
  console.log(`basket_vault owner:   ${basketVaultOwner.toBase58()} (NOT the EarnConfig PDA — program does not custody USDC)`);
  console.log(`dao_fee_dest (USDC):  ${daoFeeDestination.toBase58()} (${onchainEarnConfig ? 'from EarnConfig' : 'owner=deployer'})`);
  console.log(`pool_vault (earn-RWT):${poolVault.toBase58()} (owner=staking_config PDA, create-idempotent in-handler)`);
  console.log('--- init args ---');
  console.log(
    `earn.initialize:      authority=${deployer.publicKey.toBase58()} (basket_vault set later via update_config)`,
  );
  console.log(
    `earn.update_config:   basket_vault=${basketVault.toBase58()} ` +
      `mint_fee_bps=${onchainEarnConfig?.mintFeeBps ?? EARN_DEFAULT_MINT_FEE_BPS} ` +
      `min_mint_amount=${(onchainEarnConfig?.minMintAmount ?? EARN_DEFAULT_MIN_MINT_AMOUNT).toString()}`,
  );
  console.log(
    `staking.initialize:   reward_depositor=${deployer.publicKey.toBase58()} ` +
      `(authority=signer=deployer)`,
  );
  if (genesisEnabled) {
    console.log(
      `earn.seed_genesis:    amount=${genesisAmount.toString()} base units ` +
        `(${(Number(genesisAmount) / 10 ** EARN_RWT_DECIMALS).toLocaleString()} RWT @ NAV $1.00)`,
    );
    console.log(
      `  genesis recipient:  ${genesisRecipientAta.toBase58()} ` +
        `(earn-RWT ATA of ${genesisRecipientWallet.toBase58()}${genesisRecipientOwner ? ', EARN_GENESIS_RECIPIENT' : ', deployer default'})`,
    );
  } else {
    console.log('earn.seed_genesis:    SKIPPED (EARN_GENESIS_RWT unset or 0)');
  }
  console.log('=====================================================\n');

  // ========================================================================
  // Step 2: Create the earn-RWT mint (mint authority = EarnConfig PDA).
  // earn.initialize EXPECTS this mint to already exist with authority pinned
  // to the EarnConfig PDA, so it must be created BEFORE earn.initialize.
  // ========================================================================
  {
    const existingAuth = await readMintAuthority(conn, earnRwtMint);
    if (earnConfigExists) {
      if (!existingAuth || !existingAuth.equals(earnConfigPda)) {
        throw new Error(
          `on-chain EarnConfig rwt_mint ${earnRwtMint.toBase58()} has mint authority ` +
            `${existingAuth?.toBase58() ?? '<none>'} != EarnConfig PDA ${earnConfigPda.toBase58()}`,
        );
      }
      log('mint-earn-rwt', 'skip (EarnConfig already pins existing rwt_mint)');
    } else if (existingAuth) {
      if (!existingAuth.equals(earnConfigPda)) {
        throw new Error(
          `earn-RWT mint ${earnRwtMint.toBase58()} exists but its mint authority ` +
            `${existingAuth.toBase58()} != EarnConfig PDA ${earnConfigPda.toBase58()}`,
        );
      }
      log('mint-earn-rwt', 'skip (mint exists, authority = EarnConfig PDA)');
    } else if (await accountExists(conn, earnRwtMint)) {
      throw new Error(`earn-RWT mint ${earnRwtMint.toBase58()} exists but has no mint authority`);
    } else {
      if (!earnRwtMintKp) {
        throw new Error('earn-RWT mint keypair unavailable while EarnConfig is uninitialized');
      }
      const lamports = await getMinimumBalanceForRentExemptMint(conn);
      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: deployer.publicKey,
          newAccountPubkey: earnRwtMint,
          lamports,
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(
          earnRwtMint,
          EARN_RWT_DECIMALS,
          earnConfigPda, // mint authority = EarnConfig PDA (PDA may be a mint authority)
          null, // no freeze authority
          TOKEN_PROGRAM_ID,
        ),
      );
      await simulateOrSend(conn, tx, [deployer, earnRwtMintKp], execute, 'create earn-RWT mint');
    }
  }

  // ========================================================================
  // Step 4 (earn token accounts): dao_fee_destination.
  // basket_vault is no longer an initialize account; it is an EXTERNAL treasury
  // set via update_config after init (Step 6), so it is NOT created here.
  // dao_fee_destination is an ordinary deployer-owned ATA and is safe to
  // create idempotently ahead of time.
  // ========================================================================
  {
    const ixs: TransactionInstruction[] = [];
    if (earnConfigExists) {
      if (!(await accountExists(conn, daoFeeDestination))) {
        throw new Error(
          `on-chain EarnConfig dao_fee_destination ${daoFeeDestination.toBase58()} does not exist`,
        );
      }
      log('ata-dao-fee', 'skip (EarnConfig already pins dao_fee_destination)');
    } else if (!(await accountExists(conn, daoFeeDestination))) {
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          deployer.publicKey,
          daoFeeDestination,
          deployer.publicKey, // owner
          usdcMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    } else {
      log('ata-dao-fee', 'skip (exists)');
    }
    if (ixs.length > 0) {
      const tx = new Transaction().add(...ixs);
      await simulateOrSend(conn, tx, [deployer], execute, 'create earn DAO fee ATA');
    }
  }

  // ========================================================================
  // Step 5: earn.initialize
  // basket_vault is NO LONGER an initialize account (the program does not
  // custody USDC; config.basket_vault is left zeroed and set via update_config
  // in Step 6).
  // Account order (1:1 with contracts/earn/src/instructions/initialize.rs):
  //   0 deployer            signer, writable   (mut, signer)
  //   1 earn_config         writable           (manual create after validation)
  //   2 rwt_mint            readonly           (= earn-RWT mint)
  //   3 usdc_mint           readonly           (= devnet USDC)
  //   4 dao_fee_destination readonly
  //   5 system_program      readonly
  // ========================================================================
  {
    if (earnConfigExists) {
      log('earn-initialize', 'skip (EarnConfig PDA already has data)');
    } else if (!execute && !(await accountExists(conn, earnRwtMint))) {
      // Dry-run limitation: simulateTransaction runs each tx independently
      // against committed on-chain state, so a not-yet-sent mint creation isn't
      // visible here. earn.initialize would fail with `IllegalOwner` on
      // `rwt_mint` purely because the mint exists only in the (un-sent) prior
      // tx. Defer the simulation rather than report a false failure.
      log(
        'earn-initialize',
        'DEFERRED in dry-run — depends on earn-RWT mint created by a prior ' +
          'un-sent tx (would simulate cleanly once that tx is committed under --execute)',
      );
    } else if (!execute && !(await accountExists(conn, daoFeeDestination))) {
      // Same dry-run limitation: token accounts may only exist in the prior
      // simulated tx, not in committed state.
      log(
        'earn-initialize',
        'DEFERRED in dry-run — depends on earn token accounts created by a prior ' +
          'un-sent tx (would simulate cleanly once that tx is committed under --execute)',
      );
    } else {
      const keys: AccountMeta[] = [
        meta(deployer.publicKey, true, true),
        meta(earnConfigPda, false, true),
        meta(earnRwtMint, false, false),
        meta(usdcMint, false, false),
        meta(daoFeeDestination, false, false),
        meta(SYSTEM_PROGRAM_ID, false, false),
      ];
      const data = encodeEarnInitializeArgs(deployer.publicKey);
      const ix = new TransactionInstruction({ programId: earnProgramId, keys, data });
      const tx = new Transaction().add(ix);
      await simulateOrSend(conn, tx, [deployer], execute, 'earn.initialize');
    }
  }

  // ========================================================================
  // Step 5b: earn.seed_genesis — ONE-TIME founder genesis mint.
  // Placed right after earn.initialize: it only needs the EarnConfig PDA and the
  // earn-RWT mint (both live by now); it does NOT need basket_vault (no USDC is
  // moved). Records an off-chain RWA's value as the initial
  // total_invested_capital and mints the matching earn-RWT at NAV $1.00.
  //
  // Opt-in + idempotent:
  //   - SKIP entirely when EARN_GENESIS_RWT is unset/0 (devnet may not want a
  //     genesis seed).
  //   - SKIP cleanly when the earn-RWT mint supply is already != 0 (genesis
  //     already done). The contract would also reject with
  //     GenesisAlreadyComplete = 6027, but skipping avoids a guaranteed revert.
  //   - The recipient earn-RWT ATA is created idempotently in the SAME tx.
  //
  // Account order (1:1 with contracts/earn/src/instructions/seed_genesis.rs):
  //   0 bootstrap_authority signer            (= deployer; must == on-chain
  //                                             BOOTSTRAP_AUTHORITY pin)
  //   1 earn_config          writable
  //   2 rwt_mint             writable          (= earn-RWT mint; supply must be 0)
  //   3 recipient_rwt        writable          (treasury earn-RWT ATA)
  //   4 token_program        readonly
  // Args: amount (u64).
  // ========================================================================
  {
    if (!genesisEnabled) {
      log('earn-seed-genesis', 'skip (EARN_GENESIS_RWT unset or 0 — no genesis seed requested)');
    } else if (!execute && !earnConfigExists) {
      // Dry-run limitation: EarnConfig + earn-RWT mint exist only in prior
      // un-sent txs, so a standalone simulation would fail. Defer (same pattern
      // as earn.update_config / staking.initialize above).
      log(
        'earn-seed-genesis',
        'DEFERRED in dry-run — depends on EarnConfig + earn-RWT mint created by ' +
          'prior un-sent txs (would simulate cleanly once committed under --execute)',
      );
    } else {
      // Idempotency: a non-zero earn-RWT supply means genesis already ran.
      const currentSupply = await readMintSupply(conn, earnRwtMint);
      if (currentSupply !== null && currentSupply !== 0n) {
        log(
          'earn-seed-genesis',
          `skip (earn-RWT supply already ${currentSupply.toString()} != 0 — genesis already complete)`,
        );
      } else {
        // Build: create the recipient earn-RWT ATA idempotently, then seed_genesis.
        const setupIxs: TransactionInstruction[] = [];
        if (!(await accountExists(conn, genesisRecipientAta))) {
          setupIxs.push(
            createAssociatedTokenAccountIdempotentInstruction(
              deployer.publicKey, // payer
              genesisRecipientAta,
              genesisRecipientWallet, // owner of the treasury ATA
              earnRwtMint,
              TOKEN_PROGRAM_ID,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
          );
        } else {
          log('earn-genesis-ata', 'skip create (recipient earn-RWT ATA exists)');
        }

        const keys: AccountMeta[] = [
          meta(deployer.publicKey, true, false), // bootstrap_authority (signer)
          meta(earnConfigPda, false, true),
          meta(earnRwtMint, false, true),
          meta(genesisRecipientAta, false, true),
          meta(TOKEN_PROGRAM_ID, false, false),
        ];
        const data = encodeEarnSeedGenesisArgs(genesisAmount);
        const ix = new TransactionInstruction({ programId: earnProgramId, keys, data });
        const tx = new Transaction().add(...setupIxs, ix);
        await simulateOrSend(conn, tx, [deployer], execute, 'earn.seed_genesis');
      }
    }
  }

  // ========================================================================
  // Step 6: earn.update_config — SET the external basket_vault.
  // config.basket_vault is zeroed at init; mint_rwt / add_to_basket revert
  // BasketVaultNotSet until it is set here. We re-affirm the other tunables at
  // their current/default values so only basket_vault effectively changes.
  //
  // Treasury creation: when the default fresh-treasury branch is used, the
  // deployer-owned USDC token account is created in the SAME tx (System
  // CreateAccount + InitializeAccount, owner = deployer). For an EARN_TREASURY
  // wallet, its USDC ATA is created idempotently. For an explicit
  // EARN_BASKET_VAULT account, it is assumed to already exist.
  //
  // Account order (1:1 with contracts/earn/src/instructions/update_config.rs):
  //   0 authority     signer            (= deployer = config.authority)
  //   1 earn_config   writable
  // basket_vault itself is passed by VALUE in the args, NOT as an account.
  // ========================================================================
  {
    const alreadySet =
      onchainEarnConfig != null && !isZeroPubkey(onchainEarnConfig.basketVault);
    if (alreadySet) {
      log('earn-update-config', `skip (basket_vault already set to ${basketVault.toBase58()})`);
    } else if (!execute && !earnConfigExists) {
      // Dry-run limitation: EarnConfig is only created by the prior un-sent
      // earn.initialize tx, so update_config would fail standalone. Defer.
      log(
        'earn-update-config',
        'DEFERRED in dry-run — depends on EarnConfig created by the prior un-sent ' +
          'earn.initialize tx (would simulate cleanly once that tx is committed under --execute)',
      );
    } else {
      // Re-affirm current/default tunables; only basket_vault changes.
      const mintFeeBps = onchainEarnConfig?.mintFeeBps ?? EARN_DEFAULT_MINT_FEE_BPS;
      const minMintAmount = onchainEarnConfig?.minMintAmount ?? EARN_DEFAULT_MIN_MINT_AMOUNT;

      // Create the treasury account in the same tx when needed.
      const setupIxs: TransactionInstruction[] = [];
      const signers = [deployer];
      if (basketVaultKp) {
        // Default branch: fresh deployer-owned USDC token account (NOT an ATA,
        // NOT the EarnConfig PDA, NOT the deployer's dao_fee ATA).
        if (!(await accountExists(conn, basketVault))) {
          const lamports = await getMinimumBalanceForRentExemptAccount(conn);
          setupIxs.push(
            SystemProgram.createAccount({
              fromPubkey: deployer.publicKey,
              newAccountPubkey: basketVault,
              lamports,
              space: ACCOUNT_SIZE,
              programId: TOKEN_PROGRAM_ID,
            }),
            createInitializeAccountInstruction(
              basketVault,
              usdcMint,
              deployer.publicKey, // owner = deployer (external to the EarnConfig PDA)
              TOKEN_PROGRAM_ID,
            ),
          );
          signers.push(basketVaultKp);
        } else {
          log('earn-treasury', 'skip create (journaled treasury token account exists)');
        }
      } else if (treasuryOwnerOverride) {
        // EARN_TREASURY: ensure the treasury wallet's USDC ATA exists.
        if (!(await accountExists(conn, basketVault))) {
          setupIxs.push(
            createAssociatedTokenAccountIdempotentInstruction(
              deployer.publicKey,
              basketVault,
              treasuryOwnerOverride, // owner
              usdcMint,
              TOKEN_PROGRAM_ID,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
          );
        } else {
          log('earn-treasury', 'skip create (EARN_TREASURY USDC ATA exists)');
        }
      } else {
        // EARN_BASKET_VAULT: explicit token account, assumed to already exist.
        if (execute && !(await accountExists(conn, basketVault))) {
          throw new Error(
            `EARN_BASKET_VAULT ${basketVault.toBase58()} does not exist on-chain; ` +
              'create the treasury token account first or use EARN_TREASURY.',
          );
        }
      }

      const keys: AccountMeta[] = [
        meta(deployer.publicKey, true, false),
        meta(earnConfigPda, false, true),
      ];
      const data = encodeEarnUpdateConfigArgs(
        mintFeeBps,
        minMintAmount,
        daoFeeDestination,
        basketVault,
      );
      const ix = new TransactionInstruction({ programId: earnProgramId, keys, data });
      const tx = new Transaction().add(...setupIxs, ix);
      await simulateOrSend(
        conn,
        tx,
        signers,
        execute,
        'earn.update_config (set basket_vault)',
      );
    }
  }

  // ========================================================================
  // Step 7: staking.initialize
  // The handler CREATES strwt_mint (System CreateAccount + Token
  // InitializeMint2) and creates/accepts pool_vault (ATA CreateIdempotent CPI)
  // internally. So:
  //   - strwt_mint is passed as a FRESH signer keypair (mut, signer); must NOT
  //     pre-exist.
  //   - pool_vault is passed as the derived canonical ATA address (mut).
  //
  // Account order (1:1 with contracts/staking/src/instructions/initialize.rs):
  //   0 authority       signer, writable  (mut, signer; pays rent; = config.authority)
  //   1 staking_config  writable          (manual create after validation)
  //   2 rwt_mint        readonly          (= earn-RWT mint; staked token)
  //   3 strwt_mint      signer, writable  (created in-handler)
  //   4 pool_vault      writable          (created or accepted in-handler)
  //   5 token_program   readonly
  //   6 system_program  readonly
  //   7 ata_program     readonly
  //
  // Args: reward_depositor (authority comes from signer).
  // ========================================================================
  {
    if (stakingConfigExists) {
      log('staking-initialize', 'skip (StakingConfig PDA already has data)');
    } else if (!execute && !(await accountExists(conn, earnRwtMint))) {
      // Dry-run limitation (same as earn.initialize): the earn-RWT mint that
      // staking pins as `rwt_mint` is only created in a prior un-sent tx, so a
      // standalone simulation here would fail on the `#[account(owner =
      // SPL_TOKEN_PROGRAM)]` check for rwt_mint. Defer rather than report a
      // false failure.
      log(
        'staking-initialize',
        'DEFERRED in dry-run — depends on earn-RWT mint created by a prior ' +
          'un-sent tx (would simulate cleanly once that tx is committed under --execute)',
      );
    } else {
      // Guard: strwt_mint must NOT pre-exist (handler creates it). If a prior
      // partial run created it, the journal keypair lets us re-sign but the
      // CreateAccount would fail — surface that clearly.
      if (await accountExists(conn, strwtMint)) {
        throw new Error(
          `stRWT mint ${strwtMint.toBase58()} already exists but StakingConfig is ` +
            `uninitialized — staking.initialize creates the mint in-handler and will ` +
            `fail. Inspect/clean up the orphaned mint account before retrying.`,
        );
      }
      const keys: AccountMeta[] = [
        meta(deployer.publicKey, true, true),
        meta(stakingConfigPda, false, true),
        meta(earnRwtMint, false, false),
        meta(strwtMint, true, true),
        meta(poolVault, false, true),
        meta(TOKEN_PROGRAM_ID, false, false),
        meta(SYSTEM_PROGRAM_ID, false, false),
        meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      ];
      const data = encodeStakingInitializeArgs(deployer.publicKey);
      const ix = new TransactionInstruction({ programId: stakingProgramId, keys, data });
      const tx = new Transaction().add(ix);
      if (!strwtMintKp) {
        throw new Error('stRWT mint keypair unavailable while StakingConfig is uninitialized');
      }
      await simulateOrSend(conn, tx, [deployer, strwtMintKp], execute, 'staking.initialize');
    }
  }

  // ========================================================================
  // Step 8: Journal everything into data/devnet-addresses.json
  // ========================================================================
  earnSection.earn_rwt_mint = earnRwtMint.toBase58();
  earnSection.strwt_mint = strwtMint.toBase58();
  earnSection.basket_vault = basketVault.toBase58();
  earnSection.basket_vault_owner = basketVaultOwner.toBase58();
  earnSection.dao_fee_destination = daoFeeDestination.toBase58();
  earnSection.pool_vault = poolVault.toBase58();
  earnSection.earn_config_pda = earnConfigPda.toBase58();
  earnSection.staking_config_pda = stakingConfigPda.toBase58();
  // Genesis seed audit trail. Only journal when a genesis was requested; clear
  // any stale fields otherwise so the section stays truthful across re-runs.
  if (genesisEnabled) {
    earnSection.genesis_recipient_ata = genesisRecipientAta.toBase58();
    earnSection.genesis_recipient_owner = genesisRecipientWallet.toBase58();
    earnSection.genesis_rwt_amount = genesisAmount.toString();
    earnSection.genesis_nav_note =
      `total_invested_capital set to ${genesisAmount.toString()} (6dp); NAV $1.00 ` +
      `(INITIAL_NAV) at genesis — earn-RWT and USDC share 6dp scale, capital == supply 1:1`;
  } else {
    delete earnSection.genesis_recipient_ata;
    delete earnSection.genesis_recipient_owner;
    delete earnSection.genesis_rwt_amount;
    delete earnSection.genesis_nav_note;
  }
  if (earnRwtMintKp) {
    earnSection.earn_rwt_mint_keypair_b64 = keypairToB64(earnRwtMintKp);
  } else {
    delete earnSection.earn_rwt_mint_keypair_b64;
  }
  if (strwtMintKp) {
    earnSection.strwt_mint_keypair_b64 = keypairToB64(strwtMintKp);
  } else {
    delete earnSection.strwt_mint_keypair_b64;
  }
  // Journal the default-treasury keypair only when the script generated/owns it
  // (fresh deployer-owned treasury account); drop it when an external treasury
  // is configured via env so no stale secret lingers.
  if (basketVaultKp) {
    earnSection.basket_vault_keypair_b64 = keypairToB64(basketVaultKp);
  } else {
    delete earnSection.basket_vault_keypair_b64;
  }

  if (execute) {
    earnSection.bootstrapped_at = new Date().toISOString();
    art.earn = earnSection;
    saveAddresses(art);
    log('journal', `wrote earn section to ${ADDRESSES_PATH}`);
  } else {
    log('journal', 'DRY-RUN — not writing devnet-addresses.json. Would journal:', {
      earn_rwt_mint: earnSection.earn_rwt_mint,
      strwt_mint: earnSection.strwt_mint,
      basket_vault: earnSection.basket_vault,
      basket_vault_owner: earnSection.basket_vault_owner,
      dao_fee_destination: earnSection.dao_fee_destination,
      pool_vault: earnSection.pool_vault,
      earn_config_pda: earnSection.earn_config_pda,
      staking_config_pda: earnSection.staking_config_pda,
      genesis_recipient_ata: earnSection.genesis_recipient_ata ?? null,
      genesis_recipient_owner: earnSection.genesis_recipient_owner ?? null,
      genesis_rwt_amount: earnSection.genesis_rwt_amount ?? null,
    });
  }

  // TODO(pool-seed): seeding the native-dex earn-RWT/USDC pool is OUT OF SCOPE
  // for this script. That follow-up requires (a) minting earn-RWT (via
  // earn.mint_rwt against minted USDC), (b) a whitelisted pool creator on the
  // DEX, and (c) DEX::create_pool + add_liquidity. Handle separately once the
  // two programs' state is live.

  console.log(`\n[bootstrap-earn] DONE (${execute ? 'executed' : 'dry-run / simulate only'}).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  process.exit(1);
});
