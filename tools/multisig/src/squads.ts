/**
 * Squads v4 integration. Wraps the @sqds/multisig SDK for the operations this
 * CLI needs and reconstructs the inner instructions stored in a VaultTransaction
 * so the decoder can render them.
 *
 * Network calls go ONLY to the configured RPC. No other endpoints are contacted.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountMeta,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import type { ResolvedConfig } from './config.js';
import { reconstructInstructions, hasAddressTableLookups } from './message.js';

const { Multisig, VaultTransaction, Proposal } = multisig.accounts;
const { Permission } = multisig.types;

/** Permission helpers re-exported for readability. */
export const SquadsPermission = Permission;

export interface MemberInfo {
  key: PublicKey;
  canInitiate: boolean;
  canVote: boolean;
  canExecute: boolean;
}

export interface MultisigInfo {
  address: PublicKey;
  threshold: number;
  transactionIndex: bigint;
  members: MemberInfo[];
}

function permFlags(mask: number): { canInitiate: boolean; canVote: boolean; canExecute: boolean } {
  return {
    canInitiate: (mask & Permission.Initiate) !== 0,
    canVote: (mask & Permission.Vote) !== 0,
    canExecute: (mask & Permission.Execute) !== 0,
  };
}

/** Fetch + validate that the multisig account exists; return its decoded info. */
export async function fetchMultisig(
  connection: Connection,
  cfg: ResolvedConfig,
): Promise<MultisigInfo> {
  let acc;
  try {
    acc = await Multisig.fromAccountAddress(connection, cfg.multisig);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `multisig account ${cfg.multisig.toBase58()} not found or not a Squads v4 multisig (${msg})`,
    );
  }
  const members: MemberInfo[] = acc.members.map((m) => {
    const flags = permFlags(m.permissions.mask);
    return { key: m.key, ...flags };
  });
  return {
    address: cfg.multisig,
    threshold: acc.threshold,
    transactionIndex: toBigInt(acc.transactionIndex),
    members,
  };
}

/** Assert a member key is in the multisig with at least the given permission. */
export function assertMember(
  info: MultisigInfo,
  member: PublicKey,
  need: 'initiate' | 'vote' | 'execute',
): MemberInfo {
  const found = info.members.find((m) => m.key.equals(member));
  if (!found) {
    throw new Error(
      `${member.toBase58()} is not a member of multisig ${info.address.toBase58()}`,
    );
  }
  const ok =
    (need === 'initiate' && found.canInitiate) ||
    (need === 'vote' && found.canVote) ||
    (need === 'execute' && found.canExecute);
  if (!ok) {
    throw new Error(
      `${member.toBase58()} is a member but lacks the "${need}" permission required for this action`,
    );
  }
  return found;
}

/** Normalize the beet bignum type (number | BN | bigint) to bigint. */
export function toBigInt(v: number | bigint | { toString(): string }): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  return BigInt(v.toString());
}

/** Derive the vault PDA used as the protocol `authority`. */
export function vaultPda(cfg: ResolvedConfig): PublicKey {
  const [pda] = multisig.getVaultPda({
    multisigPda: cfg.multisig,
    index: cfg.vaultIndex,
    programId: cfg.squadsProgramId,
  });
  return pda;
}

export interface ProposalView {
  index: bigint;
  transactionPda: PublicKey;
  proposalPda: PublicKey;
  /** Reconstructed inner instructions (program, metas, data) for decoding. */
  innerInstructions: { programId: PublicKey; metas: AccountMeta[]; data: Buffer }[];
  /**
   * True when the stored message references Address Lookup Tables. In that case
   * `innerInstructions` CANNOT be trusted (some account keys live in external
   * tables we do not resolve) and the caller MUST treat the whole proposal as
   * UNKNOWN and force the index-echo step.
   */
  usesAddressTables: boolean;
  /** Proposal status + vote tallies, when a Proposal account exists. */
  status: string;
  approvedCount: number;
  rejectedCount: number;
  /** Whether a proposal account exists yet (vaultTransactionCreate w/o proposalCreate). */
  hasProposal: boolean;
}

function statusKind(status: { __kind: string }): string {
  return status.__kind;
}

/** Load one proposal (by index) and reconstruct it for display. */
export async function fetchProposal(
  connection: Connection,
  cfg: ResolvedConfig,
  index: bigint,
): Promise<ProposalView> {
  const [transactionPda] = multisig.getTransactionPda({
    multisigPda: cfg.multisig,
    index,
    programId: cfg.squadsProgramId,
  });
  const [proposalPda] = multisig.getProposalPda({
    multisigPda: cfg.multisig,
    transactionIndex: index,
    programId: cfg.squadsProgramId,
  });

  let vt;
  try {
    vt = await VaultTransaction.fromAccountAddress(connection, transactionPda);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`no vault transaction at index ${index.toString()} (${msg})`);
  }

  // If the message references Address Lookup Tables, some account keys are NOT
  // in the static `accountKeys` array — role/identity reconstruction would be
  // wrong or throw. Do NOT attempt it; the caller renders the whole proposal as
  // UNKNOWN-with-warning and forces the index-echo step.
  const usesAddressTables = hasAddressTableLookups(vt.message);
  const innerInstructions = usesAddressTables ? [] : reconstructInstructions(vt.message);

  let status = 'NoProposal';
  let approvedCount = 0;
  let rejectedCount = 0;
  let hasProposal = false;
  try {
    const proposal = await Proposal.fromAccountAddress(connection, proposalPda);
    hasProposal = true;
    status = statusKind(proposal.status as { __kind: string });
    approvedCount = proposal.approved.length;
    rejectedCount = proposal.rejected.length;
  } catch {
    // No proposal account yet — vaultTransactionCreate was sent without
    // proposalCreate, or the index is stale. Leave the defaults.
  }

  return {
    index,
    transactionPda,
    proposalPda,
    innerInstructions,
    usesAddressTables,
    status,
    approvedCount,
    rejectedCount,
    hasProposal,
  };
}

/** Summary entry for `list`. */
export interface ProposalSummary {
  index: bigint;
  status: string;
  approvedCount: number;
  rejectedCount: number;
}

/**
 * List proposals by scanning indices from `transactionIndex` down to 1 (or a
 * bounded window). Squads stores transactions at deterministic PDAs keyed by a
 * monotonic index, so we walk the range and report what exists.
 */
export async function listProposals(
  connection: Connection,
  cfg: ResolvedConfig,
  info: MultisigInfo,
  limit = 25,
): Promise<ProposalSummary[]> {
  const top = info.transactionIndex;
  const out: ProposalSummary[] = [];
  for (let i = top; i >= 1n && out.length < limit; i -= 1n) {
    const [proposalPda] = multisig.getProposalPda({
      multisigPda: cfg.multisig,
      transactionIndex: i,
      programId: cfg.squadsProgramId,
    });
    try {
      const proposal = await Proposal.fromAccountAddress(connection, proposalPda);
      out.push({
        index: i,
        status: statusKind(proposal.status as { __kind: string }),
        approvedCount: proposal.approved.length,
        rejectedCount: proposal.rejected.length,
      });
    } catch {
      // No proposal at this index; skip.
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Transaction builders + senders
// --------------------------------------------------------------------------

async function sendV0(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: Keypair,
  extraSigners: Keypair[] = [],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer, ...extraSigners]);
  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

/**
 * Create a vault transaction + its proposal in a single transaction.
 *
 * The inner protocol instruction(s) are wrapped into the multisig transaction
 * message; their signer requirement on the vault PDA is satisfied by the Squads
 * program (the vault PDA signs via CPI when the proposal is executed).
 */
export async function proposeVaultTransaction(
  connection: Connection,
  cfg: ResolvedConfig,
  proposer: Keypair,
  innerInstructions: TransactionInstruction[],
  memo: string,
): Promise<{ index: bigint; signature: string; transactionPda: PublicKey }> {
  const info = await fetchMultisig(connection, cfg);
  assertMember(info, proposer.publicKey, 'initiate');

  const newIndex = info.transactionIndex + 1n;
  const vault = vaultPda(cfg);

  const innerMessage = new TransactionMessage({
    payerKey: vault, // the vault is the fee payer / authority of the inner tx
    recentBlockhash: PublicKey.default.toBase58(), // placeholder; Squads ignores it
    instructions: innerInstructions,
  });

  const createIx = multisig.instructions.vaultTransactionCreate({
    multisigPda: cfg.multisig,
    transactionIndex: newIndex,
    creator: proposer.publicKey,
    vaultIndex: cfg.vaultIndex,
    ephemeralSigners: 0,
    transactionMessage: innerMessage,
    memo,
    programId: cfg.squadsProgramId,
  });
  const proposalIx = multisig.instructions.proposalCreate({
    multisigPda: cfg.multisig,
    creator: proposer.publicKey,
    transactionIndex: newIndex,
    programId: cfg.squadsProgramId,
  });

  const signature = await sendV0(connection, [createIx, proposalIx], proposer);
  const [transactionPda] = multisig.getTransactionPda({
    multisigPda: cfg.multisig,
    index: newIndex,
    programId: cfg.squadsProgramId,
  });
  return { index: newIndex, signature, transactionPda };
}

export async function approveProposal(
  connection: Connection,
  cfg: ResolvedConfig,
  member: Keypair,
  index: bigint,
): Promise<string> {
  const info = await fetchMultisig(connection, cfg);
  assertMember(info, member.publicKey, 'vote');
  const ix = multisig.instructions.proposalApprove({
    multisigPda: cfg.multisig,
    transactionIndex: index,
    member: member.publicKey,
    programId: cfg.squadsProgramId,
  });
  return sendV0(connection, [ix], member);
}

export async function rejectProposal(
  connection: Connection,
  cfg: ResolvedConfig,
  member: Keypair,
  index: bigint,
): Promise<string> {
  const info = await fetchMultisig(connection, cfg);
  assertMember(info, member.publicKey, 'vote');
  const ix = multisig.instructions.proposalReject({
    multisigPda: cfg.multisig,
    transactionIndex: index,
    member: member.publicKey,
    programId: cfg.squadsProgramId,
  });
  return sendV0(connection, [ix], member);
}

export async function executeProposal(
  connection: Connection,
  cfg: ResolvedConfig,
  member: Keypair,
  index: bigint,
): Promise<string> {
  const info = await fetchMultisig(connection, cfg);
  assertMember(info, member.publicKey, 'execute');
  const { instruction } = await multisig.instructions.vaultTransactionExecute({
    connection,
    multisigPda: cfg.multisig,
    transactionIndex: index,
    member: member.publicKey,
    programId: cfg.squadsProgramId,
  });
  return sendV0(connection, [instruction], member);
}
