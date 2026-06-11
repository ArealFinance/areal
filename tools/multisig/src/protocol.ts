/**
 * Areal protocol instruction encoders + decoders.
 *
 * Ground truth: the Rust source at contracts/{earn,staking}/src/lib.rs and
 * instructions/*.rs. We DO NOT depend on
 * the repo's sdk/ (stale IDLs, uncommitted WIP). Instructions are encoded
 * directly using the same scheme bootstrap-earn.ts uses.
 *
 * Discriminator scheme — Arlex is Anchor-compatible:
 *   discriminator = sha256("global:<snake_case_ix_name>")[0..8]
 * Confirmed against arlex-framework/client/src/discriminator.ts and the
 * `initialize` value baked into scripts/lib/bootstrap-earn.ts
 * (af af 6d 1f 0d 98 9b ed).
 *
 * Arg packing — Borsh, little-endian, fixed layouts (no Vec, no Option except
 * where noted). Account meta order is 1:1 with each `#[derive(Accounts)]` struct
 * in the Rust source; "authority" signer accounts are mapped to the Squads VAULT
 * PDA (it signs via CPI on execute).
 */
import { createHash } from 'node:crypto';
import { PublicKey, type AccountMeta, TransactionInstruction } from '@solana/web3.js';

// --------------------------------------------------------------------------
// Discriminator derivation
// --------------------------------------------------------------------------

/** sha256("global:<name>")[0..8] — Anchor/Arlex instruction discriminator. */
export function instructionDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

/** Known instruction names we support, with their derived discriminators. */
export const EARN_IX = {
  updateConfig: 'update_config',
  writedownCapital: 'writedown_capital',
  acceptAuthorityTransfer: 'accept_authority_transfer',
} as const;

export const STAKING_IX = {
  updateConfig: 'update_config',
  acceptAuthorityTransfer: 'accept_authority_transfer',
} as const;

// --------------------------------------------------------------------------
// Borsh primitive writers (LE, fixed width)
// --------------------------------------------------------------------------

function u16le(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw new Error(`u16 out of range: ${n}`);
  }
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u8(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0 || n > 0xff) {
    throw new Error(`u8 out of range: ${n}`);
  }
  return Buffer.from([n]);
}

function u64le(n: bigint): Buffer {
  if (n < 0n || n > 0xffffffffffffffffn) {
    throw new Error(`u64 out of range: ${n}`);
  }
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
}

function i64le(n: bigint): Buffer {
  if (n < -(2n ** 63n) || n > 2n ** 63n - 1n) {
    throw new Error(`i64 out of range: ${n}`);
  }
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(n, 0);
  return b;
}

function pubkey32(pk: PublicKey): Buffer {
  return Buffer.from(pk.toBytes());
}

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta => ({
  pubkey,
  isSigner,
  isWritable,
});

// --------------------------------------------------------------------------
// Account-role labels (for human-readable `show` output)
// --------------------------------------------------------------------------

export interface NamedAccount {
  name: string;
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}

// --------------------------------------------------------------------------
// EARN instruction builders
// --------------------------------------------------------------------------

export interface EarnUpdateConfigArgs {
  /** mint_fee_bps (u16). Capped at 1000 (10%) on-chain. */
  feeBps: number;
  /** min_mint_amount (u64). USDC base units, 6-dec. */
  minMint: bigint;
  /** dao_fee_destination ([u8;32]). */
  feeDestination: PublicKey;
  /**
   * basket_vault ([u8;32]). External USDC treasury token account (the program
   * does NOT custody USDC). Rejected on-chain if zero (ZeroBasketVault) or
   * equal to dao_fee_destination (FeeDestinationIsBasketVault).
   */
  basketVault: PublicKey;
}

/**
 * earn.update_config(mint_fee_bps: u16, min_mint_amount: u64, dao_fee_destination: [u8;32], basket_vault: [u8;32]).
 * Accounts (contracts/earn/src/instructions/update_config.rs):
 *   0 authority   signer            -> VAULT PDA
 *   1 earn_config mut
 */
export function buildEarnUpdateConfig(
  earnProgram: PublicKey,
  vault: PublicKey,
  earnConfig: PublicKey,
  args: EarnUpdateConfigArgs,
): TransactionInstruction {
  const data = Buffer.concat([
    instructionDiscriminator(EARN_IX.updateConfig),
    u16le(args.feeBps),
    u64le(args.minMint),
    pubkey32(args.feeDestination),
    pubkey32(args.basketVault),
  ]);
  const keys: AccountMeta[] = [meta(vault, true, false), meta(earnConfig, false, true)];
  return new TransactionInstruction({ programId: earnProgram, keys, data });
}

export interface EarnWritedownArgs {
  /** amount (u64). */
  amount: bigint;
  /** reason_code (u8). Free-form authority hint. */
  reason: number;
}

/**
 * earn.writedown_capital(amount: u64, reason_code: u8).
 * Accounts (contracts/earn/src/instructions/writedown_capital.rs):
 *   0 authority   signer        -> VAULT PDA
 *   1 earn_config mut
 *   2 rwt_mint    readonly       (= earn-RWT mint; supply is read for NAV)
 */
export function buildEarnWritedown(
  earnProgram: PublicKey,
  vault: PublicKey,
  earnConfig: PublicKey,
  rwtMint: PublicKey,
  args: EarnWritedownArgs,
): TransactionInstruction {
  const data = Buffer.concat([
    instructionDiscriminator(EARN_IX.writedownCapital),
    u64le(args.amount),
    u8(args.reason),
  ]);
  const keys: AccountMeta[] = [
    meta(vault, true, false),
    meta(earnConfig, false, true),
    meta(rwtMint, false, false),
  ];
  return new TransactionInstruction({ programId: earnProgram, keys, data });
}

/**
 * earn.accept_authority_transfer().
 * Accounts (contracts/earn/src/instructions/authority_transfer.rs::AcceptAuthorityTransfer):
 *   0 new_authority signer       -> VAULT PDA (vault accepts becoming the authority)
 *   1 earn_config   mut
 */
export function buildEarnAuthorityAccept(
  earnProgram: PublicKey,
  vault: PublicKey,
  earnConfig: PublicKey,
): TransactionInstruction {
  const data = instructionDiscriminator(EARN_IX.acceptAuthorityTransfer);
  const keys: AccountMeta[] = [meta(vault, true, false), meta(earnConfig, false, true)];
  return new TransactionInstruction({ programId: earnProgram, keys, data });
}

// --------------------------------------------------------------------------
// STAKING instruction builders
// --------------------------------------------------------------------------

export interface StakingUpdateConfigArgs {
  /** reward_depositor ([u8;32]). */
  rewardDepositor: PublicKey;
  /** min_stake_amount (u64). Clamped up to MIN_STAKE_AMOUNT on-chain. */
  minStake: bigint;
  /** cooldown_seconds (i64). Clamped up to COOLDOWN_SECONDS on-chain. */
  cooldown: bigint;
}

/**
 * staking.update_config(reward_depositor: [u8;32], min_stake_amount: u64, cooldown_seconds: i64).
 * Accounts (contracts/staking/src/instructions/update_config.rs):
 *   0 authority      signer  -> VAULT PDA
 *   1 staking_config mut
 */
export function buildStakingUpdateConfig(
  stakingProgram: PublicKey,
  vault: PublicKey,
  stakingConfig: PublicKey,
  args: StakingUpdateConfigArgs,
): TransactionInstruction {
  const data = Buffer.concat([
    instructionDiscriminator(STAKING_IX.updateConfig),
    pubkey32(args.rewardDepositor),
    u64le(args.minStake),
    i64le(args.cooldown),
  ]);
  const keys: AccountMeta[] = [meta(vault, true, false), meta(stakingConfig, false, true)];
  return new TransactionInstruction({ programId: stakingProgram, keys, data });
}

/**
 * staking.accept_authority_transfer().
 * Accounts (contracts/staking/src/instructions/authority_transfer.rs::AcceptAuthorityTransfer):
 *   0 new_authority  signer -> VAULT PDA
 *   1 staking_config mut
 */
export function buildStakingAuthorityAccept(
  stakingProgram: PublicKey,
  vault: PublicKey,
  stakingConfig: PublicKey,
): TransactionInstruction {
  const data = instructionDiscriminator(STAKING_IX.acceptAuthorityTransfer);
  const keys: AccountMeta[] = [meta(vault, true, false), meta(stakingConfig, false, true)];
  return new TransactionInstruction({ programId: stakingProgram, keys, data });
}

// --------------------------------------------------------------------------
// BPF Upgradeable Loader: Upgrade instruction
// --------------------------------------------------------------------------

/**
 * BPF Upgradeable Loader `Upgrade` instruction.
 *
 * The loader's instruction set is a bincode-serialized enum; `Upgrade` is
 * variant index 3, encoded as a bare little-endian u32 with no further data.
 * Account order (must match the loader):
 *   0 programdata     writable
 *   1 program         writable
 *   2 buffer          writable
 *   3 spill           writable  (lamport recipient; default = vault)
 *   4 rent sysvar     readonly
 *   5 clock sysvar    readonly
 *   6 authority       signer    -> VAULT PDA (current upgrade authority)
 */
export const BPF_LOADER_UPGRADE_IX_INDEX = 3;

const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
const SYSVAR_CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111');

export interface UpgradeAccounts {
  loader: PublicKey;
  programData: PublicKey;
  program: PublicKey;
  buffer: PublicKey;
  spill: PublicKey;
  /** Upgrade authority — the Squads VAULT PDA. */
  authority: PublicKey;
}

export function buildBpfUpgrade(a: UpgradeAccounts): TransactionInstruction {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(BPF_LOADER_UPGRADE_IX_INDEX, 0);
  const keys: AccountMeta[] = [
    meta(a.programData, false, true),
    meta(a.program, false, true),
    meta(a.buffer, false, true),
    meta(a.spill, false, true),
    meta(SYSVAR_RENT, false, false),
    meta(SYSVAR_CLOCK, false, false),
    meta(a.authority, true, false),
  ];
  return new TransactionInstruction({ programId: a.loader, keys, data });
}

// --------------------------------------------------------------------------
// Decoder — used by `show`. Reconstructs human-readable meaning from a raw
// inner instruction (program id, data bytes, account metas). REFUSES to claim
// an unknown instruction is safe.
// --------------------------------------------------------------------------

export interface DecodedArg {
  name: string;
  value: string;
}

export interface DecodedInstruction {
  /** True when fully decoded; false → UNKNOWN INSTRUCTION (show prints raw hex). */
  known: boolean;
  /**
   * True only when EVERY labeled account matched its expected configured pubkey
   * (and, for upgrades, the programData matched). When false on an otherwise
   * `known` ix, the renderer flags the mismatch and the approve flow escalates
   * to the index-echo step — a decoded-but-unverified ix is NOT presented as
   * clean. Always false for `known:false` results.
   */
  verified: boolean;
  program: string;
  programId: PublicKey;
  instructionName: string;
  args: DecodedArg[];
  accounts: NamedAccount[];
  /** Raw instruction data hex (always populated, for audit). */
  rawDataHex: string;
  /**
   * Free-form caution/warning lines the renderer prints verbatim (e.g. the
   * unverifiable-buffer notice on upgrades, programData mismatch). Always an
   * array; empty when there is nothing to flag.
   */
  warnings: string[];
}

/** Borsh primitive readers (LE). */
function readU16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}
function readU64(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off);
}
function readI64(buf: Buffer, off: number): bigint {
  return buf.readBigInt64LE(off);
}
function readPubkey(buf: Buffer, off: number): PublicKey {
  return new PublicKey(buf.subarray(off, off + 32));
}

/** Identify program by id against the known program set. */
export interface KnownPrograms {
  earn: PublicKey;
  staking: PublicKey;
  bpfUpgradeableLoader: PublicKey;
}

/**
 * Full decode context: the known program ids PLUS the configured identities a
 * decoded instruction is checked against (vault PDA, config PDAs, optional
 * programData accounts). Threaded into `decodeInstruction` so it can verify that
 * a known proposal actually targets the REAL config PDA — not a look-alike
 * account a malicious proposer slipped in.
 */
export interface DecodeContext extends KnownPrograms {
  /** Squads vault PDA — the expected `authority` signer on every known ix. */
  vault: PublicKey;
  configPdas: {
    earnConfig: PublicKey;
    stakingConfig: PublicKey;
  };
  /** Optional configured programData accounts (used to label upgrade targets). */
  programData?: {
    earn?: PublicKey;
    staking?: PublicKey;
  };
}

function labelAccounts(metas: AccountMeta[], names: string[]): NamedAccount[] {
  return metas.map((m, i) => ({
    name: names[i] ?? `account[${i}]`,
    pubkey: m.pubkey,
    isSigner: m.isSigner,
    isWritable: m.isWritable,
  }));
}

/**
 * Like `labelAccounts`, but verifies each account at an index whose expected
 * pubkey is provided against the actual pubkey. On mismatch it appends a loud
 * `⚠ DOES NOT MATCH CONFIGURED <name>` suffix to the label and records the
 * position so the caller can flip `verified:false`.
 *
 * `expected[i]` may be `undefined` for positions with no known expectation
 * (e.g. a free-form fee destination is an arg, not a verifiable account).
 */
function labelAndVerifyAccounts(
  metas: AccountMeta[],
  names: string[],
  expected: (PublicKey | undefined)[],
): { accounts: NamedAccount[]; verified: boolean } {
  let verified = true;
  const accounts = metas.map((m, i) => {
    const baseName = names[i] ?? `account[${i}]`;
    const want = expected[i];
    let name = baseName;
    if (want && !want.equals(m.pubkey)) {
      verified = false;
      name = `${baseName} ⚠ DOES NOT MATCH CONFIGURED ${baseName} (expected ${want.toBase58()})`;
    }
    return { name, pubkey: m.pubkey, isSigner: m.isSigner, isWritable: m.isWritable };
  });
  return { accounts, verified };
}

const DISC_EARN_UPDATE = instructionDiscriminator(EARN_IX.updateConfig);
const DISC_EARN_WRITEDOWN = instructionDiscriminator(EARN_IX.writedownCapital);
const DISC_EARN_ACCEPT = instructionDiscriminator(EARN_IX.acceptAuthorityTransfer);
const DISC_STAKING_UPDATE = instructionDiscriminator(STAKING_IX.updateConfig);
const DISC_STAKING_ACCEPT = instructionDiscriminator(STAKING_IX.acceptAuthorityTransfer);

function discEquals(data: Buffer, disc: Buffer): boolean {
  return data.length >= 8 && data.subarray(0, 8).equals(disc);
}

function unknown(
  programId: PublicKey,
  metas: AccountMeta[],
  data: Buffer,
  programLabel: string,
  reason: string,
): DecodedInstruction {
  return {
    known: false,
    verified: false,
    program: programLabel,
    programId,
    instructionName: `UNKNOWN (${reason})`,
    args: [],
    accounts: labelAccounts(
      metas,
      metas.map((_, i) => `account[${i}]`),
    ),
    rawDataHex: data.toString('hex'),
    warnings: [],
  };
}

/** Caution line shown on EVERY upgrade — buffer bytecode is not verifiable on-chain. */
export const BUFFER_UNVERIFIABLE_WARNING =
  '⚠ BUFFER CONTENTS ARE UNVERIFIABLE ON-CHAIN — verify the deployed buffer\'s ' +
  'bytecode out-of-band before approving.';

/** Derive the canonical programData PDA for a program under the BPF loader. */
export function deriveProgramDataPda(program: PublicKey, loader: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([program.toBytes()], loader);
  return pda;
}

/**
 * Decode a single inner instruction. NEVER throws on bad data — it returns a
 * `known:false` result so the caller (show) can render a loud UNKNOWN warning
 * instead of crashing or, worse, silently presenting an undecodable ix as safe.
 *
 * Beyond decoding the args, it VERIFIES the labeled accounts against the
 * configured identities in `ctx` (vault, config PDAs, programData). A
 * decoded-but-unverified ix is returned with `verified:false` so the caller
 * applies the same index-echo friction as an UNKNOWN ix — it is never presented
 * as a clean, trusted instruction.
 */
export function decodeInstruction(
  programId: PublicKey,
  metas: AccountMeta[],
  data: Buffer,
  ctx: DecodeContext,
): DecodedInstruction {
  const hex = data.toString('hex');

  // --- EARN ---
  if (programId.equals(ctx.earn)) {
    const label = 'earn';
    const earnCfg = ctx.configPdas.earnConfig;
    try {
      if (discEquals(data, DISC_EARN_UPDATE)) {
        const feeBps = readU16(data, 8);
        const minMint = readU64(data, 10);
        const feeDest = readPubkey(data, 18);
        // basket_vault is appended last (Borsh order: u16, u64, [u8;32], [u8;32]).
        // Offset 50 = 8 disc + 2 fee + 8 min + 32 dao_fee_destination.
        const basketVault = readPubkey(data, 50);
        const { accounts, verified } = labelAndVerifyAccounts(
          metas,
          ['authority (vault)', 'earn_config'],
          [ctx.vault, earnCfg],
        );
        return {
          known: true,
          verified,
          program: label,
          programId,
          instructionName: 'update_config',
          args: [
            { name: 'mint_fee_bps', value: `${feeBps} (${(feeBps / 100).toFixed(2)}%)` },
            { name: 'min_mint_amount', value: minMint.toString() },
            { name: 'dao_fee_destination', value: feeDest.toBase58() },
            { name: 'basket_vault', value: basketVault.toBase58() },
          ],
          accounts,
          rawDataHex: hex,
          warnings: [],
        };
      }
      if (discEquals(data, DISC_EARN_WRITEDOWN)) {
        const amount = readU64(data, 8);
        const reason = data.readUInt8(16);
        const { accounts, verified } = labelAndVerifyAccounts(
          metas,
          ['authority (vault)', 'earn_config', 'rwt_mint'],
          [ctx.vault, earnCfg, undefined], // rwt_mint not pinned in DecodeContext
        );
        return {
          known: true,
          verified,
          program: label,
          programId,
          instructionName: 'writedown_capital',
          args: [
            { name: 'amount', value: amount.toString() },
            { name: 'reason_code', value: reason.toString() },
          ],
          accounts,
          rawDataHex: hex,
          warnings: [],
        };
      }
      if (discEquals(data, DISC_EARN_ACCEPT)) {
        const { accounts, verified } = labelAndVerifyAccounts(
          metas,
          ['new_authority (vault)', 'earn_config'],
          [ctx.vault, earnCfg],
        );
        return {
          known: true,
          verified,
          program: label,
          programId,
          instructionName: 'accept_authority_transfer',
          args: [],
          accounts,
          rawDataHex: hex,
          warnings: [],
        };
      }
    } catch (e) {
      return unknown(
        programId,
        metas,
        data,
        label,
        `earn ix data malformed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return unknown(programId, metas, data, label, 'unrecognized earn discriminator');
  }

  // --- STAKING ---
  if (programId.equals(ctx.staking)) {
    const label = 'staking';
    const stakingCfg = ctx.configPdas.stakingConfig;
    try {
      if (discEquals(data, DISC_STAKING_UPDATE)) {
        const rewardDepositor = readPubkey(data, 8);
        const minStake = readU64(data, 40);
        const cooldown = readI64(data, 48);
        const { accounts, verified } = labelAndVerifyAccounts(
          metas,
          ['authority (vault)', 'staking_config'],
          [ctx.vault, stakingCfg],
        );
        return {
          known: true,
          verified,
          program: label,
          programId,
          instructionName: 'update_config',
          args: [
            { name: 'reward_depositor', value: rewardDepositor.toBase58() },
            { name: 'min_stake_amount', value: minStake.toString() },
            { name: 'cooldown_seconds', value: cooldown.toString() },
          ],
          accounts,
          rawDataHex: hex,
          warnings: [],
        };
      }
      if (discEquals(data, DISC_STAKING_ACCEPT)) {
        const { accounts, verified } = labelAndVerifyAccounts(
          metas,
          ['new_authority (vault)', 'staking_config'],
          [ctx.vault, stakingCfg],
        );
        return {
          known: true,
          verified,
          program: label,
          programId,
          instructionName: 'accept_authority_transfer',
          args: [],
          accounts,
          rawDataHex: hex,
          warnings: [],
        };
      }
    } catch (e) {
      return unknown(
        programId,
        metas,
        data,
        label,
        `staking ix data malformed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return unknown(programId, metas, data, label, 'unrecognized staking discriminator');
  }

  // --- BPF UPGRADEABLE LOADER ---
  if (programId.equals(ctx.bpfUpgradeableLoader)) {
    const label = 'bpf-upgradeable-loader';
    if (data.length === 4 && data.readUInt32LE(0) === BPF_LOADER_UPGRADE_IX_INDEX) {
      return decodeUpgrade(programId, metas, hex, ctx);
    }
    return unknown(programId, metas, data, label, 'non-Upgrade loader instruction');
  }

  // --- Anything else ---
  return unknown(programId, metas, data, programId.toBase58(), 'unknown program');
}

/**
 * Decode + verify a BPF-loader Upgrade instruction (C1).
 *
 * Account order (loader): [programdata, program, buffer, spill, rent, clock,
 * authority]. We resolve the `program` account against the configured earn /
 * staking ids by NAME, derive the expected programData PDA for a recognized
 * program and verify the ix's `programdata` matches, and ALWAYS attach the
 * unverifiable-buffer caution. An upgrade is intentionally NEVER marked
 * `verified:true`: even with every account matching, the buffer bytecode cannot
 * be checked on-chain, so the caller must always apply index-echo friction.
 */
function decodeUpgrade(
  programId: PublicKey,
  metas: AccountMeta[],
  hex: string,
  ctx: DecodeContext,
): DecodedInstruction {
  const label = 'bpf-upgradeable-loader';
  const warnings: string[] = [BUFFER_UNVERIFIABLE_WARNING];

  // Account 1 is the target program. Resolve its identity by name.
  const programAcc = metas[1]?.pubkey;
  let programName: string;
  let expectedProgramData: PublicKey | undefined;
  if (programAcc && programAcc.equals(ctx.earn)) {
    programName = 'program (earn)';
    expectedProgramData = ctx.programData?.earn ?? deriveProgramDataPda(ctx.earn, programId);
  } else if (programAcc && programAcc.equals(ctx.staking)) {
    programName = 'program (staking)';
    expectedProgramData = ctx.programData?.staking ?? deriveProgramDataPda(ctx.staking, programId);
  } else {
    programName = 'program ⚠ UNKNOWN PROGRAM (not in config)';
    warnings.push(
      '⚠ UPGRADE TARGETS A PROGRAM NOT IN CONFIG — the `program` account is ' +
        'neither the configured earn nor staking program id.',
    );
  }

  // Verify programData (account 0) against the derived PDA when the program is known.
  const programDataAcc = metas[0]?.pubkey;
  let programDataName = 'programdata';
  if (expectedProgramData) {
    if (programDataAcc && programDataAcc.equals(expectedProgramData)) {
      programDataName = 'programdata ✓ matches';
    } else {
      programDataName = 'programdata ⚠ PROGRAMDATA MISMATCH';
      warnings.push(
        `⚠ PROGRAMDATA MISMATCH — expected ${expectedProgramData.toBase58()} ` +
          `(derived for the configured program) but the proposal uses ` +
          `${programDataAcc ? programDataAcc.toBase58() : '<missing>'}.`,
      );
    }
  }

  // Buffer (account 2) always gets the unverifiable caution baked into its label.
  const names = [
    programDataName,
    programName,
    'buffer ⚠ UNVERIFIABLE',
    'spill',
    'rent sysvar',
    'clock sysvar',
    'authority (vault)',
  ];
  // Verify the authority (account 6) is the vault; programData was verified above
  // via the warnings path so we do not double-flag it through labelAndVerify.
  const expected: (PublicKey | undefined)[] = [
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    ctx.vault,
  ];
  const { accounts } = labelAndVerifyAccounts(metas, names, expected);

  return {
    known: true,
    // Upgrades are ALWAYS unverified: the buffer bytecode is unverifiable, so
    // the index-echo confirmation must always apply regardless of cluster.
    verified: false,
    program: label,
    programId,
    instructionName: 'upgrade',
    args: [],
    accounts,
    rawDataHex: hex,
    warnings,
  };
}
