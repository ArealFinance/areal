/**
 * Encoder/decoder + discriminator tests. Byte-exact against the discriminators
 * and Borsh arg layouts derived from the Rust source (contracts/{earn,staking}).
 * No network access.
 */
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  instructionDiscriminator,
  buildEarnUpdateConfig,
  buildEarnWritedown,
  buildEarnAuthorityAccept,
  buildStakingUpdateConfig,
  buildStakingAuthorityAccept,
  buildBpfUpgrade,
  decodeInstruction,
  deriveProgramDataPda,
  BUFFER_UNVERIFIABLE_WARNING,
  type DecodeContext,
} from '../src/protocol.js';

// Fixed test pubkeys.
const EARN = new PublicKey('HGh7TcuqUbTRrFTYBUtsTctAEEmsANWnDxeWcbgqMg8b');
const STAKING = new PublicKey('CmKXHk3u6pDUC6Q11Le6gmhCgENQSFvduisXb7guUGoL');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const VAULT = new PublicKey('11111111111111111111111111111112');
const EARN_CONFIG = new PublicKey('H4DBeFKwZsVrhMmMFG7HSMEQckeCYdewuri28kQ3wT4p');
const STAKING_CONFIG = new PublicKey('BWb75dNXbJbteLsmKy58sfHj8nYVa6CqaDzJrWo1mP1R');
const RWT_MINT = new PublicKey('8hJPUC4UNsiyBh5cosTA8RqY9TbBSmnxqkBb2sHJ5qzM');
const FEE_DEST = new PublicKey('DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK');
const BASKET_VAULT = new PublicKey('Ew8GFA29zsUXzf8dmDmesbHVCSfXVAVnPWYtr9nF3sqo');
const REWARD_DEP = new PublicKey('5rrpFYYVkwGMeTTCox3EE4VBNvkYMCQmxkYJhS9TA4Wx');

// Full decode context: program ids + the configured identities the decoder
// verifies against. The encoders above build instructions targeting exactly
// these (VAULT as authority, EARN_CONFIG / STAKING_CONFIG as the config PDAs),
// so a clean round-trip yields verified:true.
const known: DecodeContext = {
  earn: EARN,
  staking: STAKING,
  bpfUpgradeableLoader: LOADER,
  vault: VAULT,
  configPdas: { earnConfig: EARN_CONFIG, stakingConfig: STAKING_CONFIG },
};

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// ---------------------------------------------------------------------------
// Discriminators — golden values. These MUST equal sha256("global:<name>")[0..8]
// and must match the bootstrap-earn.ts `initialize` baseline + Arlex's client.
// ---------------------------------------------------------------------------
describe('instruction discriminators (Anchor/Arlex global: scheme)', () => {
  const cases: [string, string][] = [
    // name -> first 8 bytes hex (sha256("global:"+name)[0..8])
    ['initialize', 'afaf6d1f0d989bed'], // baseline from bootstrap-earn.ts
    ['update_config', '1d9efcbf0a53db63'],
    ['writedown_capital', 'de0bbd7ca7464e8f'],
    ['accept_authority_transfer', 'eff8b102ce612eff'],
  ];
  for (const [name, want] of cases) {
    it(`global:${name} = ${want}`, () => {
      expect(hex(instructionDiscriminator(name))).toBe(want);
    });
  }
});

// ---------------------------------------------------------------------------
// EARN encoders — byte-exact.
// ---------------------------------------------------------------------------
describe('earn encoders', () => {
  it('update_config packs disc + u16 + u64 + pubkey + pubkey, correct account roles', () => {
    const ix = buildEarnUpdateConfig(EARN, VAULT, EARN_CONFIG, {
      feeBps: 100,
      minMint: 1_000_000n,
      feeDestination: FEE_DEST,
      basketVault: BASKET_VAULT,
    });
    // data = 8 (disc) + 2 (u16) + 8 (u64) + 32 (dao_fee) + 32 (basket_vault) = 82 bytes
    expect(ix.data.length).toBe(82);
    expect(hex(ix.data.subarray(0, 8))).toBe('1d9efcbf0a53db63');
    expect(ix.data.readUInt16LE(8)).toBe(100);
    expect(ix.data.readBigUInt64LE(10)).toBe(1_000_000n);
    expect(new PublicKey(ix.data.subarray(18, 50)).equals(FEE_DEST)).toBe(true);
    // basket_vault appended last, offset 50.
    expect(new PublicKey(ix.data.subarray(50, 82)).equals(BASKET_VAULT)).toBe(true);
    expect(ix.programId.equals(EARN)).toBe(true);
    // account 0 = authority (vault), signer, readonly; account 1 = earn_config, writable
    expect(ix.keys[0].pubkey.equals(VAULT)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[0].isWritable).toBe(false);
    expect(ix.keys[1].pubkey.equals(EARN_CONFIG)).toBe(true);
    expect(ix.keys[1].isSigner).toBe(false);
    expect(ix.keys[1].isWritable).toBe(true);
  });

  it('writedown packs disc + u64 + u8 and includes rwt_mint readonly', () => {
    const ix = buildEarnWritedown(EARN, VAULT, EARN_CONFIG, RWT_MINT, {
      amount: 500_000n,
      reason: 7,
    });
    // 8 + 8 + 1 = 17
    expect(ix.data.length).toBe(17);
    expect(hex(ix.data.subarray(0, 8))).toBe('de0bbd7ca7464e8f');
    expect(ix.data.readBigUInt64LE(8)).toBe(500_000n);
    expect(ix.data.readUInt8(16)).toBe(7);
    expect(ix.keys).toHaveLength(3);
    expect(ix.keys[2].pubkey.equals(RWT_MINT)).toBe(true);
    expect(ix.keys[2].isWritable).toBe(false);
  });

  it('authority-accept is disc-only', () => {
    const ix = buildEarnAuthorityAccept(EARN, VAULT, EARN_CONFIG);
    expect(hex(ix.data)).toBe('eff8b102ce612eff');
    expect(ix.keys[0].isSigner).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// STAKING encoders — byte-exact.
// ---------------------------------------------------------------------------
describe('staking encoders', () => {
  it('update_config packs disc + pubkey + u64 + i64', () => {
    const ix = buildStakingUpdateConfig(STAKING, VAULT, STAKING_CONFIG, {
      rewardDepositor: REWARD_DEP,
      minStake: 1_000_000n,
      cooldown: 1_814_400n,
    });
    // 8 + 32 + 8 + 8 = 56
    expect(ix.data.length).toBe(56);
    expect(hex(ix.data.subarray(0, 8))).toBe('1d9efcbf0a53db63');
    expect(new PublicKey(ix.data.subarray(8, 40)).equals(REWARD_DEP)).toBe(true);
    expect(ix.data.readBigUInt64LE(40)).toBe(1_000_000n);
    expect(ix.data.readBigInt64LE(48)).toBe(1_814_400n);
  });

  it('update_config accepts negative cooldown (i64) without overflow', () => {
    const ix = buildStakingUpdateConfig(STAKING, VAULT, STAKING_CONFIG, {
      rewardDepositor: REWARD_DEP,
      minStake: 0n,
      cooldown: -1n,
    });
    expect(ix.data.readBigInt64LE(48)).toBe(-1n);
  });

  it('authority-accept is disc-only', () => {
    const ix = buildStakingAuthorityAccept(STAKING, VAULT, STAKING_CONFIG);
    expect(hex(ix.data)).toBe('eff8b102ce612eff');
  });
});

// ---------------------------------------------------------------------------
// BPF Upgradeable Loader Upgrade.
// ---------------------------------------------------------------------------
describe('bpf upgrade encoder', () => {
  it('encodes Upgrade as u32 LE = 3 with 7 accounts in loader order', () => {
    const PROGRAMDATA = new PublicKey('4rmaAQZXQEjdEBcUhjxrAUu7dn1TWRFhby5wAwQQuMRE');
    const PROGRAM = EARN;
    const BUFFER = new PublicKey('11111111111111111111111111111113');
    const ix = buildBpfUpgrade({
      loader: LOADER,
      programData: PROGRAMDATA,
      program: PROGRAM,
      buffer: BUFFER,
      spill: VAULT,
      authority: VAULT,
    });
    expect(ix.data.length).toBe(4);
    expect(ix.data.readUInt32LE(0)).toBe(3);
    expect(ix.keys).toHaveLength(7);
    // 0 programdata(w) 1 program(w) 2 buffer(w) 3 spill(w) 4 rent(r) 5 clock(r) 6 authority(signer)
    expect(ix.keys[0].pubkey.equals(PROGRAMDATA)).toBe(true);
    expect(ix.keys[0].isWritable).toBe(true);
    expect(ix.keys[1].pubkey.equals(PROGRAM)).toBe(true);
    expect(ix.keys[2].pubkey.equals(BUFFER)).toBe(true);
    expect(ix.keys[6].pubkey.equals(VAULT)).toBe(true);
    expect(ix.keys[6].isSigner).toBe(true);
    expect(ix.keys[4].isWritable).toBe(false); // rent sysvar readonly
    expect(ix.keys[5].isWritable).toBe(false); // clock sysvar readonly
  });
});

// ---------------------------------------------------------------------------
// Decoder round-trips: encode -> decode -> assert semantic equivalence.
// ---------------------------------------------------------------------------
describe('decoder round-trips', () => {
  it('earn.update_config', () => {
    const ix = buildEarnUpdateConfig(EARN, VAULT, EARN_CONFIG, {
      feeBps: 250,
      minMint: 2_000_000n,
      feeDestination: FEE_DEST,
      basketVault: BASKET_VAULT,
    });
    const d = decodeInstruction(ix.programId, ix.keys, Buffer.from(ix.data), known);
    expect(d.known).toBe(true);
    expect(d.program).toBe('earn');
    expect(d.instructionName).toBe('update_config');
    expect(d.args.find((a) => a.name === 'mint_fee_bps')?.value).toContain('250');
    expect(d.args.find((a) => a.name === 'min_mint_amount')?.value).toBe('2000000');
    expect(d.args.find((a) => a.name === 'dao_fee_destination')?.value).toBe(FEE_DEST.toBase58());
    expect(d.args.find((a) => a.name === 'basket_vault')?.value).toBe(BASKET_VAULT.toBase58());
    expect(d.accounts[0].name).toContain('vault');
    expect(d.accounts[0].isSigner).toBe(true);
  });

  it('earn.writedown_capital', () => {
    const ix = buildEarnWritedown(EARN, VAULT, EARN_CONFIG, RWT_MINT, {
      amount: 123n,
      reason: 42,
    });
    const d = decodeInstruction(ix.programId, ix.keys, Buffer.from(ix.data), known);
    expect(d.known).toBe(true);
    expect(d.instructionName).toBe('writedown_capital');
    expect(d.args.find((a) => a.name === 'amount')?.value).toBe('123');
    expect(d.args.find((a) => a.name === 'reason_code')?.value).toBe('42');
    expect(d.accounts[2].name).toBe('rwt_mint');
  });

  it('old earn.unpause discriminator is unknown after pause removal', () => {
    const d = decodeInstruction(EARN, [], instructionDiscriminator('unpause'), known);
    expect(d.known).toBe(false);
    expect(d.instructionName).toContain('UNKNOWN');
  });

  it('earn.accept_authority_transfer', () => {
    const a = buildEarnAuthorityAccept(EARN, VAULT, EARN_CONFIG);
    expect(decodeInstruction(a.programId, a.keys, Buffer.from(a.data), known).instructionName).toBe('accept_authority_transfer');
  });

  it('staking.update_config preserves i64 cooldown and pubkey', () => {
    const ix = buildStakingUpdateConfig(STAKING, VAULT, STAKING_CONFIG, {
      rewardDepositor: REWARD_DEP,
      minStake: 9_999n,
      cooldown: 2_000_000n,
    });
    const d = decodeInstruction(ix.programId, ix.keys, Buffer.from(ix.data), known);
    expect(d.known).toBe(true);
    expect(d.program).toBe('staking');
    expect(d.instructionName).toBe('update_config');
    expect(d.args.find((a) => a.name === 'reward_depositor')?.value).toBe(REWARD_DEP.toBase58());
    expect(d.args.find((a) => a.name === 'min_stake_amount')?.value).toBe('9999');
    expect(d.args.find((a) => a.name === 'cooldown_seconds')?.value).toBe('2000000');
  });

  it('bpf upgrade', () => {
    const ix = buildBpfUpgrade({
      loader: LOADER,
      programData: new PublicKey('4rmaAQZXQEjdEBcUhjxrAUu7dn1TWRFhby5wAwQQuMRE'),
      program: EARN,
      buffer: new PublicKey('11111111111111111111111111111113'),
      spill: VAULT,
      authority: VAULT,
    });
    const d = decodeInstruction(ix.programId, ix.keys, Buffer.from(ix.data), known);
    expect(d.known).toBe(true);
    expect(d.program).toBe('bpf-upgradeable-loader');
    expect(d.instructionName).toBe('upgrade');
    expect(d.accounts[6].name).toContain('authority');
  });
});

// ---------------------------------------------------------------------------
// Decoder safety: unknown program / unknown discriminator / malformed data
// MUST be flagged as UNKNOWN, never silently presented as a known instruction.
// ---------------------------------------------------------------------------
describe('decoder rejects undecodable input as UNKNOWN', () => {
  it('flags an unknown program', () => {
    const random = new PublicKey('Vote111111111111111111111111111111111111111');
    const d = decodeInstruction(random, [], Buffer.from([1, 2, 3, 4]), known);
    expect(d.known).toBe(false);
    expect(d.instructionName).toContain('UNKNOWN');
    expect(d.rawDataHex).toBe('01020304');
  });

  it('flags an unknown earn discriminator', () => {
    const data = Buffer.concat([Buffer.from([0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0])]);
    const d = decodeInstruction(EARN, [], data, known);
    expect(d.known).toBe(false);
    expect(d.instructionName).toContain('UNKNOWN');
  });

  it('flags a known earn discriminator with truncated args as UNKNOWN (malformed)', () => {
    // correct update_config disc but only 9 bytes total — reading the u64 overruns.
    const disc = instructionDiscriminator('update_config');
    const data = Buffer.concat([disc, Buffer.from([0x01])]);
    const d = decodeInstruction(EARN, [], data, known);
    expect(d.known).toBe(false);
    expect(d.instructionName).toContain('UNKNOWN');
  });

  it('flags a non-Upgrade loader instruction', () => {
    const d = decodeInstruction(LOADER, [], Buffer.from([0, 0, 0, 0]), known); // index 0 != 3
    expect(d.known).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H1 — account identity verification. A decoded ix whose labeled accounts do
// NOT match the configured identities must set verified:false and flag the
// mismatch, so the approve flow applies the same friction as UNKNOWN.
// ---------------------------------------------------------------------------
describe('H1: account identity verification', () => {
  // A valid base58 pubkey that is distinct from every configured identity, used
  // to stand in for a malicious look-alike account slipped into a proposal.
  const REAL_FAKE = new PublicKey('5rrpFYYVkwGMeTTCox3EE4VBNvkYMCQmxkYJhS9TA4Wx');

  it('verified:true when authority and config match the configured PDAs', () => {
    const ix = buildEarnUpdateConfig(EARN, VAULT, EARN_CONFIG, {
      feeBps: 100,
      minMint: 1_000_000n,
      feeDestination: FEE_DEST,
      basketVault: BASKET_VAULT,
    });
    const d = decodeInstruction(ix.programId, ix.keys, Buffer.from(ix.data), known);
    expect(d.known).toBe(true);
    expect(d.verified).toBe(true);
    expect(d.accounts.every((a) => !a.name.includes('⚠'))).toBe(true);
  });

  it('verified:false + loud suffix when earn_config does NOT match configured', () => {
    const ix = buildEarnUpdateConfig(EARN, VAULT, REAL_FAKE, {
      feeBps: 100,
      minMint: 1_000_000n,
      feeDestination: FEE_DEST,
      basketVault: BASKET_VAULT,
    });
    const d = decodeInstruction(ix.programId, ix.keys, Buffer.from(ix.data), known);
    expect(d.known).toBe(true); // still decodes the ix shape...
    expect(d.verified).toBe(false); // ...but the identity check failed
    const cfgAcc = d.accounts[1];
    expect(cfgAcc.name).toContain('DOES NOT MATCH CONFIGURED');
    expect(cfgAcc.name).toContain('earn_config');
  });

  it('verified:false when the authority is not the configured vault', () => {
    const ix = buildEarnUpdateConfig(EARN, REAL_FAKE, EARN_CONFIG, {
      feeBps: 100,
      minMint: 1_000_000n,
      feeDestination: FEE_DEST,
      basketVault: BASKET_VAULT,
    });
    const d = decodeInstruction(ix.programId, ix.keys, Buffer.from(ix.data), known);
    expect(d.verified).toBe(false);
    expect(d.accounts[0].name).toContain('DOES NOT MATCH CONFIGURED');
  });

  it('staking_config mismatch is flagged on staking.update_config', () => {
    const ix = buildStakingUpdateConfig(STAKING, VAULT, EARN_CONFIG, {
      rewardDepositor: REWARD_DEP,
      minStake: 1_000_000n,
      cooldown: 1_814_400n,
    });
    const d = decodeInstruction(ix.programId, ix.keys, Buffer.from(ix.data), known);
    expect(d.verified).toBe(false);
    expect(d.accounts[1].name).toContain('DOES NOT MATCH CONFIGURED');
    expect(d.accounts[1].name).toContain('staking_config');
  });
});

// ---------------------------------------------------------------------------
// C1 — upgrade proposals: resolve program identity, derive + verify
// programData, always attach the unverifiable-buffer caution, never verified.
// ---------------------------------------------------------------------------
describe('C1: upgrade program identity + programData verification', () => {
  function ctxWith(programData?: { earn?: PublicKey; staking?: PublicKey }): DecodeContext {
    return { ...known, programData };
  }

  it('resolves a configured earn program by NAME and matches derived programData', () => {
    const expectedPd = deriveProgramDataPda(EARN, LOADER);
    const ix = buildBpfUpgrade({
      loader: LOADER,
      programData: expectedPd,
      program: EARN,
      buffer: new PublicKey('11111111111111111111111111111113'),
      spill: VAULT,
      authority: VAULT,
    });
    const d = decodeInstruction(ix.programId, ix.keys, Buffer.from(ix.data), ctxWith());
    expect(d.known).toBe(true);
    expect(d.verified).toBe(false); // upgrades are NEVER verified (buffer unverifiable)
    expect(d.accounts[1].name).toContain('program (earn)');
    expect(d.accounts[0].name).toContain('programdata ✓ matches');
    expect(d.warnings).toContain(BUFFER_UNVERIFIABLE_WARNING);
  });

  it('resolves staking by name and matches programData from config when provided', () => {
    const configuredPd = new PublicKey('4rmaAQZXQEjdEBcUhjxrAUu7dn1TWRFhby5wAwQQuMRE');
    const ix = buildBpfUpgrade({
      loader: LOADER,
      programData: configuredPd,
      program: STAKING,
      buffer: new PublicKey('11111111111111111111111111111113'),
      spill: VAULT,
      authority: VAULT,
    });
    const d = decodeInstruction(
      ix.programId,
      ix.keys,
      Buffer.from(ix.data),
      ctxWith({ staking: configuredPd }),
    );
    expect(d.accounts[1].name).toContain('program (staking)');
    expect(d.accounts[0].name).toContain('programdata ✓ matches');
  });

  it('flags a PROGRAMDATA MISMATCH when programdata is not the derived/configured PDA', () => {
    // Use STAKING's derived programData as the "wrong" value for an EARN upgrade —
    // guaranteed distinct from deriveProgramDataPda(EARN, LOADER).
    const wrongPd = deriveProgramDataPda(STAKING, LOADER);
    expect(wrongPd.equals(deriveProgramDataPda(EARN, LOADER))).toBe(false); // sanity
    const ix = buildBpfUpgrade({
      loader: LOADER,
      programData: wrongPd,
      program: EARN,
      buffer: new PublicKey('11111111111111111111111111111113'),
      spill: VAULT,
      authority: VAULT,
    });
    const d = decodeInstruction(ix.programId, ix.keys, Buffer.from(ix.data), ctxWith());
    expect(d.accounts[0].name).toContain('PROGRAMDATA MISMATCH');
    expect(d.warnings.some((w) => w.includes('PROGRAMDATA MISMATCH'))).toBe(true);
    expect(d.verified).toBe(false);
  });

  it('labels an UNKNOWN PROGRAM when the target is neither earn nor staking', () => {
    const other = new PublicKey('Vote111111111111111111111111111111111111111');
    const ix = buildBpfUpgrade({
      loader: LOADER,
      programData: deriveProgramDataPda(other, LOADER),
      program: other,
      buffer: new PublicKey('11111111111111111111111111111113'),
      spill: VAULT,
      authority: VAULT,
    });
    const d = decodeInstruction(ix.programId, ix.keys, Buffer.from(ix.data), ctxWith());
    expect(d.accounts[1].name).toContain('UNKNOWN PROGRAM (not in config)');
    expect(d.warnings.some((w) => w.includes('NOT IN CONFIG'))).toBe(true);
    expect(d.verified).toBe(false);
  });

  it('always attaches the unverifiable-buffer caution and marks the buffer account', () => {
    const ix = buildBpfUpgrade({
      loader: LOADER,
      programData: deriveProgramDataPda(EARN, LOADER),
      program: EARN,
      buffer: new PublicKey('11111111111111111111111111111113'),
      spill: VAULT,
      authority: VAULT,
    });
    const d = decodeInstruction(ix.programId, ix.keys, Buffer.from(ix.data), ctxWith());
    expect(d.warnings).toContain(BUFFER_UNVERIFIABLE_WARNING);
    expect(d.accounts[2].name).toContain('buffer');
    expect(d.accounts[2].name).toContain('⚠');
  });
});
