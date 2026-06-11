/**
 * Terminal UI helpers: cluster banner, ANSI colors, the decoded-proposal
 * renderer, and the interactive confirmation prompt.
 *
 * Colors degrade gracefully when stdout is not a TTY or NO_COLOR is set.
 */
import { createInterface } from 'node:readline';
import type { Cluster, ResolvedConfig } from './config.js';
import type { DecodedInstruction } from './protocol.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code: string, s: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  red: (s: string) => wrap('31', s),
  green: (s: string) => wrap('32', s),
  yellow: (s: string) => wrap('33', s),
  cyan: (s: string) => wrap('36', s),
  bold: (s: string) => wrap('1', s),
  redBold: (s: string) => wrap('1;31', s),
  dim: (s: string) => wrap('2', s),
};

/**
 * Print a prominent cluster banner. Mainnet is rendered red + bold so an
 * operator can never miss that a real-money cluster is the target.
 */
export function printClusterBanner(cfg: ResolvedConfig): void {
  const isMainnet = cfg.cluster === 'mainnet-beta';
  const tag = isMainnet
    ? c.redBold(`  ⚠  CLUSTER: MAINNET-BETA  ⚠  `)
    : c.cyan(`  CLUSTER: ${cfg.cluster.toUpperCase()}  `);
  const line = isMainnet ? c.redBold('━'.repeat(60)) : c.dim('─'.repeat(60));
  console.log(line);
  console.log(tag);
  console.log(`  RPC:      ${redactRpc(cfg.rpcUrl)}`);
  console.log(`  Multisig: ${cfg.multisig.toBase58()}`);
  console.log(line);
}

/** Strip query string (may contain an API key) from an RPC url for display. */
export function redactRpc(url: string): string {
  try {
    const u = new URL(url);
    return u.search ? `${u.origin}${u.pathname}?<redacted>` : url;
  } catch {
    return url;
  }
}

/** Format a vote-count summary line for `list`. */
export function voteSummary(
  approved: number,
  rejected: number,
  threshold: number,
  status: string,
): string {
  const approvedTag = approved >= threshold ? c.green(`${approved}`) : `${approved}`;
  return `approved ${approvedTag}/${threshold}  rejected ${rejected}  [${status}]`;
}

/**
 * Render a decoded proposal: program, instruction name, decoded args, and the
 * full account list with roles. Undecodable instructions are rendered with a
 * loud UNKNOWN INSTRUCTION warning + raw hex + program id — never as "safe".
 * A decoded-but-UNVERIFIED instruction (an account that does not match the
 * configured identity, or any upgrade) is rendered with a loud caution and is
 * treated the same as UNKNOWN for confirmation-friction purposes.
 *
 * Returns `true` only if EVERY inner instruction decoded cleanly AND verified
 * (the caller uses this to decide the confirmation friction level). Returns
 * `false` if any was unknown OR unverified.
 */
export function renderProposal(
  index: bigint,
  decoded: DecodedInstruction[],
): boolean {
  console.log('');
  console.log(c.bold(`PROPOSAL #${index.toString()}`));
  console.log(c.dim(`  ${decoded.length} inner instruction(s)`));
  let allClean = true;
  decoded.forEach((d, i) => {
    console.log('');
    if (!d.known) {
      allClean = false;
      console.log(c.redBold(`  [${i}] ⚠  UNKNOWN INSTRUCTION — DO NOT APPROVE BLINDLY  ⚠`));
      console.log(c.redBold(`      program:     ${d.programId.toBase58()} (${d.program})`));
      console.log(c.redBold(`      detail:      ${d.instructionName}`));
      console.log(c.red(`      raw data:    ${d.rawDataHex || '<empty>'}`));
    } else if (!d.verified) {
      // Decoded, but an identity check failed (or it is an upgrade). Render the
      // instruction details but flag it loudly and force the index-echo step.
      allClean = false;
      console.log(c.redBold(`  [${i}] ⚠  ${d.program} :: ${d.instructionName} — UNVERIFIED, REVIEW CAREFULLY  ⚠`));
      console.log(c.dim(`      program:     ${d.programId.toBase58()}`));
    } else {
      console.log(c.bold(`  [${i}] ${d.program} :: ${d.instructionName}`));
      console.log(c.dim(`      program:     ${d.programId.toBase58()}`));
    }
    for (const w of d.warnings) {
      console.log(c.redBold(`      ${w}`));
    }
    if (d.args.length > 0) {
      console.log('      args:');
      for (const a of d.args) {
        console.log(`        ${a.name} = ${a.value}`);
      }
    }
    console.log('      accounts:');
    for (const acc of d.accounts) {
      const roles: string[] = [];
      if (acc.isSigner) roles.push('signer');
      if (acc.isWritable) roles.push('writable');
      else roles.push('readonly');
      const roleStr = roles.join(',');
      // A mismatch marker is embedded in the account name; color the whole line
      // red so it cannot be skimmed past.
      const mismatch = acc.name.includes('⚠');
      const line = `        ${acc.name}  ${acc.pubkey.toBase58()}  [${roleStr}]`;
      console.log(mismatch ? c.redBold(line) : `        ${acc.name.padEnd(22)} ${acc.pubkey.toBase58()}  ${c.dim(`[${roleStr}]`)}`);
    }
  });
  console.log('');
  return allClean;
}

/** Prompt for a single line of input. Resolves to the trimmed answer. */
export function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Interactive confirmation before signing. When `requireIndexEcho` is true
 * (used for UNKNOWN instructions and mainnet), the operator must type the exact
 * proposal index — a deliberate friction step that defeats reflexive "y".
 */
export async function confirmSign(
  index: bigint,
  requireIndexEcho: boolean,
  cluster: Cluster,
): Promise<boolean> {
  if (requireIndexEcho) {
    const want = index.toString();
    const reason =
      cluster === 'mainnet-beta'
        ? 'MAINNET + unknown/unverified content'
        : 'unknown/unverified content';
    console.log(c.redBold(`Extra confirmation required (${reason}).`));
    const echo = await prompt(
      c.yellow(`Type the proposal index (${want}) to confirm signing, anything else to abort: `),
    );
    if (echo !== want) {
      console.log(c.dim('Aborted — index did not match.'));
      return false;
    }
    return true;
  }
  const answer = await prompt(c.yellow('Sign this proposal? [y/N]: '));
  const ok = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
  if (!ok) console.log(c.dim('Aborted.'));
  return ok;
}
