/**
 * Reconstruction of inner instructions from a Squads VaultTransaction message.
 *
 * The stored message is the compiled (v0) form: a flat `accountKeys` array,
 * per-instruction `programIdIndex` / `accountIndexes` / `data`, plus three
 * counts that define the signer/writable partition of the account keys. This
 * module rebuilds the per-instruction AccountMeta roles from those counts
 * EXACTLY as the Squads program does on execute — kept pure (no SDK / network
 * dependency) so the role-derivation logic can be unit-tested in isolation.
 */
import { PublicKey, type AccountMeta } from '@solana/web3.js';

/** Minimal shape we need from a Squads VaultTransactionMessage. */
export interface CompiledMessage {
  numSigners: number;
  numWritableSigners: number;
  numWritableNonSigners: number;
  accountKeys: PublicKey[];
  instructions: {
    programIdIndex: number;
    accountIndexes: Uint8Array | number[];
    data: Uint8Array | number[];
  }[];
  /**
   * Address Lookup Table entries. When present, some account keys live in
   * external lookup tables NOT in `accountKeys`, so role reconstruction here is
   * impossible/unsafe. The caller MUST treat such a message as UNKNOWN.
   */
  addressTableLookups?: unknown[];
}

/** True when the message references Address Lookup Tables we cannot resolve. */
export function hasAddressTableLookups(msg: CompiledMessage): boolean {
  return Array.isArray(msg.addressTableLookups) && msg.addressTableLookups.length > 0;
}

export interface ReconstructedInstruction {
  programId: PublicKey;
  metas: AccountMeta[];
  data: Buffer;
}

/**
 * Solana account-key ordering invariant (v0 message header):
 *   [ writable signers | readonly signers | writable non-signers | readonly non-signers ]
 * `numSigners` splits signers from non-signers; `numWritableSigners` and
 * `numWritableNonSigners` mark how many of each leading block are writable.
 */
export function isSignerIndex(msg: CompiledMessage, i: number): boolean {
  return i < msg.numSigners;
}

export function isWritableIndex(msg: CompiledMessage, i: number): boolean {
  // Match the Squads SDK exactly: an index past the static account-key array
  // (i.e. one that resolves through an Address Lookup Table) is never treated as
  // a static writable here. Without this guard, a large index would wrongly fall
  // through the non-signer arithmetic below and could be mislabeled writable.
  if (i >= msg.accountKeys.length) return false;
  if (i < msg.numWritableSigners) return true; // writable signers (front block)
  if (i < msg.numSigners) return false; // remaining signers are readonly
  const nonSignerPos = i - msg.numSigners;
  return nonSignerPos < msg.numWritableNonSigners; // writable non-signers next
}

export function reconstructInstructions(msg: CompiledMessage): ReconstructedInstruction[] {
  return msg.instructions.map((ix) => {
    const programId = msg.accountKeys[ix.programIdIndex];
    if (!programId) {
      throw new Error(`programIdIndex ${ix.programIdIndex} out of range`);
    }
    const metas: AccountMeta[] = Array.from(ix.accountIndexes).map((accIdx) => {
      const pubkey = msg.accountKeys[accIdx];
      if (!pubkey) {
        throw new Error(`account index ${accIdx} out of range`);
      }
      return {
        pubkey,
        isSigner: isSignerIndex(msg, accIdx),
        isWritable: isWritableIndex(msg, accIdx),
      };
    });
    return { programId, metas, data: Buffer.from(ix.data) };
  });
}
