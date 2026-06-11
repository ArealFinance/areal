/**
 * Tests for the v0-message inner-instruction reconstruction (signer/writable
 * role derivation). Security-relevant: `show` relies on these roles being
 * faithful to what the Squads program executes. No network access.
 */
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  reconstructInstructions,
  isSignerIndex,
  isWritableIndex,
  hasAddressTableLookups,
  type CompiledMessage,
} from '../src/message.js';

// 6 distinct keys. Layout we model:
//   [0] writable signer    (vault)
//   [1] readonly signer
//   [2] writable non-signer (config)
//   [3] writable non-signer (mint? — here just a 2nd writable)
//   [4] readonly non-signer (program id)
//   [5] readonly non-signer (sysvar)
const keys = [
  new PublicKey('11111111111111111111111111111112'),
  new PublicKey('11111111111111111111111111111113'),
  new PublicKey('H4DBeFKwZsVrhMmMFG7HSMEQckeCYdewuri28kQ3wT4p'),
  new PublicKey('8hJPUC4UNsiyBh5cosTA8RqY9TbBSmnxqkBb2sHJ5qzM'),
  new PublicKey('HGh7TcuqUbTRrFTYBUtsTctAEEmsANWnDxeWcbgqMg8b'),
  new PublicKey('SysvarRent111111111111111111111111111111111'),
];

const msg: CompiledMessage = {
  numSigners: 2,
  numWritableSigners: 1,
  numWritableNonSigners: 2,
  accountKeys: keys,
  instructions: [
    {
      programIdIndex: 4, // earn program
      accountIndexes: [0, 2], // vault (signer/writable), config (writable non-signer)
      data: [0x1d, 0x9e, 0xfc, 0xbf, 0x0a, 0x53, 0xdb, 0x63],
    },
  ],
};

describe('account role derivation', () => {
  it('classifies signers correctly', () => {
    expect(isSignerIndex(msg, 0)).toBe(true);
    expect(isSignerIndex(msg, 1)).toBe(true);
    expect(isSignerIndex(msg, 2)).toBe(false);
    expect(isSignerIndex(msg, 5)).toBe(false);
  });

  it('classifies writability correctly across all four blocks', () => {
    expect(isWritableIndex(msg, 0)).toBe(true); // writable signer
    expect(isWritableIndex(msg, 1)).toBe(false); // readonly signer
    expect(isWritableIndex(msg, 2)).toBe(true); // writable non-signer
    expect(isWritableIndex(msg, 3)).toBe(true); // writable non-signer
    expect(isWritableIndex(msg, 4)).toBe(false); // readonly non-signer
    expect(isWritableIndex(msg, 5)).toBe(false); // readonly non-signer
  });

  it('treats an out-of-range index (past static keys, i.e. ALT-resolved) as readonly', () => {
    // accountKeys.length === 6; index 6 and beyond resolve through a lookup
    // table and must never be reported writable here (matches the SDK).
    expect(isWritableIndex(msg, 6)).toBe(false);
    expect(isWritableIndex(msg, 99)).toBe(false);
  });
});

describe('hasAddressTableLookups (architect note #1)', () => {
  it('is false when there are no lookups', () => {
    expect(hasAddressTableLookups(msg)).toBe(false);
  });

  it('is false when the array is explicitly empty', () => {
    expect(hasAddressTableLookups({ ...msg, addressTableLookups: [] })).toBe(false);
  });

  it('is true when at least one lookup is present', () => {
    expect(
      hasAddressTableLookups({ ...msg, addressTableLookups: [{ accountKey: 'x' }] }),
    ).toBe(true);
  });
});

describe('reconstructInstructions', () => {
  it('rebuilds program id, account metas, and data', () => {
    const out = reconstructInstructions(msg);
    expect(out).toHaveLength(1);
    const ix = out[0];
    expect(ix.programId.equals(keys[4])).toBe(true);
    expect(ix.metas).toHaveLength(2);
    // vault: signer + writable
    expect(ix.metas[0].pubkey.equals(keys[0])).toBe(true);
    expect(ix.metas[0].isSigner).toBe(true);
    expect(ix.metas[0].isWritable).toBe(true);
    // config: non-signer + writable
    expect(ix.metas[1].pubkey.equals(keys[2])).toBe(true);
    expect(ix.metas[1].isSigner).toBe(false);
    expect(ix.metas[1].isWritable).toBe(true);
    expect(ix.data.toString('hex')).toBe('1d9efcbf0a53db63');
  });

  it('throws on an out-of-range account index', () => {
    const bad: CompiledMessage = {
      ...msg,
      instructions: [{ programIdIndex: 4, accountIndexes: [99], data: [] }],
    };
    expect(() => reconstructInstructions(bad)).toThrow(/out of range/);
  });
});
