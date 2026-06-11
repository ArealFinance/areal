#!/usr/bin/env node
/**
 * msig — Areal Finance Squads v4 multisig operations CLI.
 *
 * Lets a local "proposer" key (Squads member, Initiate-only permission) create
 * fully-formed protocol proposals; members approve via this CLI or the Squads
 * web app; anyone executes. See README.md for the security model.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { Command, Option } from 'commander';
import {
  CONFIG_FILENAME,
  loadConfig,
  parsePubkey,
  resolveConfig,
  assertClusterIdentity,
  type RawConfig,
  type ResolvedConfig,
} from './config.js';
import { loadKeypairFile } from './keypair.js';
import {
  buildEarnUpdateConfig,
  buildEarnUnpause,
  buildEarnWritedown,
  buildEarnAuthorityAccept,
  buildStakingUpdateConfig,
  buildStakingUnpause,
  buildStakingAuthorityAccept,
  buildBpfUpgrade,
  decodeInstruction,
  type DecodeContext,
  type DecodedInstruction,
} from './protocol.js';
import {
  fetchMultisig,
  fetchProposal,
  listProposals,
  proposeVaultTransaction,
  approveProposal,
  rejectProposal,
  executeProposal,
  vaultPda,
} from './squads.js';
import { c, printClusterBanner, renderProposal, voteSummary, confirmSign, prompt } from './ui.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function fail(message: string): never {
  console.error(c.red(`error: ${message}`));
  process.exit(1);
}

function resolveConfigPath(opts: { config?: string }): string {
  return resolve(opts.config ?? CONFIG_FILENAME);
}

function loadCfgOrFail(opts: { config?: string }): ResolvedConfig {
  const path = resolveConfigPath(opts);
  if (!existsSync(path)) {
    fail(`config not found at ${path}. Run \`msig init\` first or pass --config <path>.`);
  }
  try {
    return loadConfig(path);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

function connect(cfg: ResolvedConfig): Connection {
  return new Connection(cfg.rpcUrl, 'confirmed');
}

/** Build the full decode context: program ids + vault + config PDAs + programData. */
function decodeContext(cfg: ResolvedConfig): DecodeContext {
  return {
    earn: cfg.programs.earn,
    staking: cfg.programs.staking,
    bpfUpgradeableLoader: cfg.programs.bpfUpgradeableLoader,
    vault: vaultPda(cfg),
    configPdas: {
      earnConfig: cfg.configPdas.earnConfig,
      stakingConfig: cfg.configPdas.stakingConfig,
    },
    programData: cfg.programData,
  };
}

/**
 * Verify the configured cluster label against the RPC's genesis hash. Fatal on a
 * proven contradiction (e.g. a "devnet"-labeled config pointing at mainnet);
 * non-fatal if the RPC is unreachable. Prints the resolved identity.
 */
async function assertCluster(cfg: ResolvedConfig, conn: Connection): Promise<void> {
  let identity;
  try {
    identity = await assertClusterIdentity(cfg, conn);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (identity.resolvedCluster === 'unreachable') {
    console.log(c.yellow('  Cluster identity: RPC unreachable — label trusted (could not verify genesis hash).'));
  } else if (identity.resolvedCluster === 'unknown') {
    console.log(c.dim(`  Cluster identity: unrecognized genesis hash ${identity.genesisHash} — label trusted (custom/localnet).`));
  } else {
    console.log(c.dim(`  Cluster identity: ${identity.resolvedCluster} (genesis ${identity.genesisHash}) ✓ matches label`));
  }
}

/** Parse a required base58 pubkey CLI option, failing clearly. */
function reqPubkey(value: string | undefined, flag: string): PublicKey {
  if (!value) fail(`${flag} is required`);
  try {
    return parsePubkey(value, flag);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/** Parse a required non-negative integer/bigint CLI option. */
function reqU64(value: string | undefined, flag: string): bigint {
  if (value === undefined) fail(`${flag} is required`);
  if (!/^\d+$/.test(value)) fail(`${flag} must be a non-negative integer`);
  return BigInt(value);
}

function reqU16(value: string | undefined, flag: string): number {
  if (value === undefined) fail(`${flag} is required`);
  if (!/^\d+$/.test(value)) fail(`${flag} must be a non-negative integer`);
  const n = Number(value);
  if (n > 0xffff) fail(`${flag} must fit in u16 (<= 65535)`);
  return n;
}

function reqI64(value: string | undefined, flag: string): bigint {
  if (value === undefined) fail(`${flag} is required`);
  if (!/^-?\d+$/.test(value)) fail(`${flag} must be an integer`);
  return BigInt(value);
}

async function proposeAndReport(
  cfg: ResolvedConfig,
  conn: Connection,
  keypairPath: string,
  buildInner: (vault: PublicKey) => import('@solana/web3.js').TransactionInstruction[],
  memo: string,
): Promise<void> {
  const proposer = loadKeypairFile(keypairPath);
  const vault = vaultPda(cfg);
  const inner = buildInner(vault);
  const { index, signature, transactionPda } = await proposeVaultTransaction(
    conn,
    cfg,
    proposer,
    inner,
    memo,
  );
  console.log(c.green(`\nProposal created.`));
  console.log(`  index:           ${index.toString()}`);
  console.log(`  transaction PDA: ${transactionPda.toBase58()}`);
  console.log(`  signature:       ${signature}`);
  console.log(c.dim(`\nNext: members approve via \`msig approve ${index} --keypair <path>\` or the Squads web app.`));
}

// --------------------------------------------------------------------------
// CLI definition
// --------------------------------------------------------------------------

const program = new Command();
program
  .name('msig')
  .description('Areal Finance Squads v4 multisig operations CLI')
  .option('--config <path>', `path to ${CONFIG_FILENAME}`, CONFIG_FILENAME);

// ---- init ----
program
  .command('init')
  .description(`write ${CONFIG_FILENAME} (interactive, or supply flags)`)
  .option('--cluster <cluster>', 'devnet | testnet | mainnet-beta | localnet')
  .option('--rpc <url>', 'RPC http url')
  .option('--multisig <pubkey>', 'Squads multisig address')
  .option('--vault-index <n>', 'vault authority index', '0')
  .option('--earn <pubkey>', 'earn program id')
  .option('--staking <pubkey>', 'staking program id')
  .option('--earn-config <pubkey>', 'earn config PDA')
  .option('--staking-config <pubkey>', 'staking config PDA')
  .option('--earn-rwt-mint <pubkey>', 'earn-RWT mint (for earn-writedown)')
  .option('--earn-programdata <pubkey>', 'earn programData account (for upgrade)')
  .option('--staking-programdata <pubkey>', 'staking programData account (for upgrade)')
  .option('--force', 'overwrite existing config')
  .action(async (opts) => {
    const globalOpts = program.opts<{ config?: string }>();
    const path = resolveConfigPath(globalOpts);
    if (existsSync(path) && !opts.force) {
      fail(`${path} already exists. Pass --force to overwrite.`);
    }
    // When stdin is not a TTY (CI / piped / fully-flagged invocation) we never
    // prompt — a missing flag simply yields an empty string. Required-field
    // validation in resolveConfig then surfaces any genuine omission.
    const interactive = process.stdin.isTTY;
    const ask = async (flagVal: string | undefined, question: string): Promise<string> => {
      if (flagVal !== undefined) return flagVal;
      if (!interactive) return '';
      return (await prompt(c.yellow(question))).trim();
    };

    const cluster = (await ask(opts.cluster, 'cluster (devnet/testnet/mainnet-beta/localnet): ')) || 'devnet';
    const rpcUrl = await ask(opts.rpc, 'RPC http url: ');
    const multisig = await ask(opts.multisig, 'multisig address: ');
    const earn = await ask(opts.earn, 'earn program id: ');
    const staking = await ask(opts.staking, 'staking program id: ');
    const earnConfig = await ask(opts.earnConfig, 'earn config PDA: ');
    const stakingConfig = await ask(opts.stakingConfig, 'staking config PDA: ');
    const earnRwtMint = await ask(opts.earnRwtMint, 'earn-RWT mint (optional, blank to skip): ');
    const earnProgramData = await ask(opts.earnProgramdata, 'earn programData (optional, blank to skip): ');
    const stakingProgramData = await ask(opts.stakingProgramdata, 'staking programData (optional, blank to skip): ');

    const raw: RawConfig = {
      cluster: cluster as RawConfig['cluster'],
      rpcUrl,
      multisig,
      vaultIndex: Number(opts.vaultIndex ?? 0),
      programs: { earn, staking },
      configPdas: { earnConfig, stakingConfig },
    };
    if (earnRwtMint) raw.earnRwtMint = earnRwtMint;
    if (earnProgramData || stakingProgramData) {
      raw.programData = {};
      if (earnProgramData) raw.programData.earn = earnProgramData;
      if (stakingProgramData) raw.programData.staking = stakingProgramData;
    }

    // Validate before writing — surfaces bad pubkeys / cluster immediately.
    let resolved: ResolvedConfig;
    try {
      resolved = resolveConfig(raw);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    writeFileSync(path, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    console.log(c.green(`\nWrote ${path}`));
    printClusterBanner(resolved);
  });

// ---- propose (parent) ----
const propose = program.command('propose').description('create a new proposal');

async function withProposeContext(): Promise<{ cfg: ResolvedConfig; conn: Connection }> {
  const globalOpts = program.opts<{ config?: string }>();
  const cfg = loadCfgOrFail(globalOpts);
  printClusterBanner(cfg);
  const conn = connect(cfg);
  await assertCluster(cfg, conn);
  return { cfg, conn };
}

propose
  .command('earn-update-config')
  .description('earn.update_config(fee_bps, min_mint, fee_destination)')
  .requiredOption('--keypair <path>', 'proposer keypair file (Initiate permission)')
  .requiredOption('--fee-bps <n>', 'mint_fee_bps (u16, <=1000 enforced on-chain)')
  .requiredOption('--min-mint <n>', 'min_mint_amount (u64, USDC base units)')
  .requiredOption('--fee-destination <pubkey>', 'dao_fee_destination')
  .action(async (opts) => {
    const { cfg, conn } = await withProposeContext();
    const feeBps = reqU16(opts.feeBps, '--fee-bps');
    const minMint = reqU64(opts.minMint, '--min-mint');
    const feeDestination = reqPubkey(opts.feeDestination, '--fee-destination');
    await proposeAndReport(
      cfg,
      conn,
      opts.keypair,
      (vault) => [buildEarnUpdateConfig(cfg.programs.earn, vault, cfg.configPdas.earnConfig, { feeBps, minMint, feeDestination })],
      'earn-update-config',
    );
  });

propose
  .command('staking-update-config')
  .description('staking.update_config(reward_depositor, min_stake, cooldown)')
  .requiredOption('--keypair <path>', 'proposer keypair file')
  .requiredOption('--reward-depositor <pubkey>', 'reward_depositor')
  .requiredOption('--min-stake <n>', 'min_stake_amount (u64)')
  .requiredOption('--cooldown <secs>', 'cooldown_seconds (i64)')
  .action(async (opts) => {
    const { cfg, conn } = await withProposeContext();
    const rewardDepositor = reqPubkey(opts.rewardDepositor, '--reward-depositor');
    const minStake = reqU64(opts.minStake, '--min-stake');
    const cooldown = reqI64(opts.cooldown, '--cooldown');
    await proposeAndReport(
      cfg,
      conn,
      opts.keypair,
      (vault) => [buildStakingUpdateConfig(cfg.programs.staking, vault, cfg.configPdas.stakingConfig, { rewardDepositor, minStake, cooldown })],
      'staking-update-config',
    );
  });

propose
  .command('earn-unpause')
  .description('earn.unpause()')
  .requiredOption('--keypair <path>', 'proposer keypair file')
  .action(async (opts) => {
    const { cfg, conn } = await withProposeContext();
    await proposeAndReport(
      cfg,
      conn,
      opts.keypair,
      (vault) => [buildEarnUnpause(cfg.programs.earn, vault, cfg.configPdas.earnConfig)],
      'earn-unpause',
    );
  });

propose
  .command('staking-unpause')
  .description('staking.unpause()')
  .requiredOption('--keypair <path>', 'proposer keypair file')
  .action(async (opts) => {
    const { cfg, conn } = await withProposeContext();
    await proposeAndReport(
      cfg,
      conn,
      opts.keypair,
      (vault) => [buildStakingUnpause(cfg.programs.staking, vault, cfg.configPdas.stakingConfig)],
      'staking-unpause',
    );
  });

propose
  .command('earn-writedown')
  .description('earn.writedown_capital(amount, reason)')
  .requiredOption('--keypair <path>', 'proposer keypair file')
  .requiredOption('--amount <n>', 'amount (u64)')
  .requiredOption('--reason <code>', 'reason_code (u8)')
  .action(async (opts) => {
    const { cfg, conn } = await withProposeContext();
    if (!cfg.earnRwtMint) {
      fail('earn-writedown requires `earnRwtMint` in config (the earn-RWT mint account). Re-run `msig init` with --earn-rwt-mint.');
    }
    const amount = reqU64(opts.amount, '--amount');
    const reasonN = Number(opts.reason);
    if (!Number.isInteger(reasonN) || reasonN < 0 || reasonN > 255) {
      fail('--reason must be a u8 (0..255)');
    }
    const rwtMint = cfg.earnRwtMint;
    await proposeAndReport(
      cfg,
      conn,
      opts.keypair,
      (vault) => [buildEarnWritedown(cfg.programs.earn, vault, cfg.configPdas.earnConfig, rwtMint, { amount, reason: reasonN })],
      'earn-writedown',
    );
  });

propose
  .command('earn-authority-accept')
  .description('earn.accept_authority_transfer() — vault accepts becoming earn authority')
  .requiredOption('--keypair <path>', 'proposer keypair file')
  .action(async (opts) => {
    const { cfg, conn } = await withProposeContext();
    await proposeAndReport(
      cfg,
      conn,
      opts.keypair,
      (vault) => [buildEarnAuthorityAccept(cfg.programs.earn, vault, cfg.configPdas.earnConfig)],
      'earn-authority-accept',
    );
  });

propose
  .command('staking-authority-accept')
  .description('staking.accept_authority_transfer() — vault accepts becoming staking authority')
  .requiredOption('--keypair <path>', 'proposer keypair file')
  .action(async (opts) => {
    const { cfg, conn } = await withProposeContext();
    await proposeAndReport(
      cfg,
      conn,
      opts.keypair,
      (vault) => [buildStakingAuthorityAccept(cfg.programs.staking, vault, cfg.configPdas.stakingConfig)],
      'staking-authority-accept',
    );
  });

propose
  .command('upgrade')
  .description('BPF Upgradeable Loader Upgrade — vault is the upgrade authority')
  .requiredOption('--keypair <path>', 'proposer keypair file')
  .requiredOption('--program <earn|staking|pubkey>', 'target program')
  .requiredOption('--buffer <pubkey>', 'buffer account holding the new program bytes')
  .option('--programdata <pubkey>', 'override programData account (else derived/config)')
  .option('--spill <pubkey>', 'lamport recipient (default: vault)')
  .action(async (opts) => {
    const { cfg, conn } = await withProposeContext();
    const buffer = reqPubkey(opts.buffer, '--buffer');

    // Resolve target program + its programData account.
    let program: PublicKey;
    let programData: PublicKey | undefined;
    if (opts.program === 'earn') {
      program = cfg.programs.earn;
      programData = cfg.programData.earn;
    } else if (opts.program === 'staking') {
      program = cfg.programs.staking;
      programData = cfg.programData.staking;
    } else {
      program = reqPubkey(opts.program, '--program');
    }
    if (opts.programdata) programData = reqPubkey(opts.programdata, '--programdata');
    if (!programData) {
      // Derive the canonical programData PDA: [program] under the loader.
      [programData] = PublicKey.findProgramAddressSync(
        [program.toBytes()],
        cfg.programs.bpfUpgradeableLoader,
      );
      console.log(c.dim(`derived programData PDA: ${programData.toBase58()}`));
    }
    const spill = opts.spill ? reqPubkey(opts.spill, '--spill') : vaultPda(cfg);

    await proposeAndReport(
      cfg,
      conn,
      opts.keypair,
      (vault) => [
        buildBpfUpgrade({
          loader: cfg.programs.bpfUpgradeableLoader,
          program,
          programData: programData!,
          buffer,
          spill,
          authority: vault,
        }),
      ],
      `upgrade ${opts.program}`,
    );
  });

// ---- list ----
program
  .command('list')
  .description('list pending proposals with status + vote counts')
  .option('--limit <n>', 'max proposals to scan', '25')
  .action(async (opts) => {
    const globalOpts = program.opts<{ config?: string }>();
    const cfg = loadCfgOrFail(globalOpts);
    printClusterBanner(cfg);
    const conn = connect(cfg);
    await assertCluster(cfg, conn);
    const info = await fetchMultisig(conn, cfg);
    console.log(c.dim(`threshold ${info.threshold}, top index ${info.transactionIndex.toString()}, ${info.members.length} members`));
    const limit = Number(opts.limit) || 25;
    const summaries = await listProposals(conn, cfg, info, limit);
    if (summaries.length === 0) {
      console.log(c.dim('\nNo proposals found.'));
      return;
    }
    console.log('');
    for (const s of summaries) {
      console.log(
        `  #${s.index.toString().padStart(4)}  ${voteSummary(s.approvedCount, s.rejectedCount, info.threshold, s.status)}`,
      );
    }
  });

// ---- show ----
/**
 * Synthetic UNKNOWN entry used when a proposal references Address Lookup Tables
 * we do not resolve (architect note #1). The whole proposal is treated as
 * unknown — no role reconstruction is attempted — and the index-echo step is
 * forced downstream because `known:false`.
 */
function addressTableUnknown(): DecodedInstruction {
  return {
    known: false,
    verified: false,
    program: 'address-lookup-table',
    programId: PublicKey.default,
    instructionName:
      'UNKNOWN (proposal uses Address Lookup Tables — account roles cannot be reconstructed offline; review in the Squads web app)',
    args: [],
    accounts: [],
    rawDataHex: '',
    warnings: [
      '⚠ THIS PROPOSAL USES ADDRESS LOOKUP TABLES. This CLI cannot resolve the ' +
        'looked-up accounts, so it will NOT label or verify them. Do NOT approve ' +
        'unless you independently verify every account (e.g. in the Squads web app).',
    ],
  };
}

function decodeProposalView(
  view: Awaited<ReturnType<typeof fetchProposal>>,
  cfg: ResolvedConfig,
): DecodedInstruction[] {
  if (view.usesAddressTables) {
    return [addressTableUnknown()];
  }
  const ctx = decodeContext(cfg);
  return view.innerInstructions.map((ix) => decodeInstruction(ix.programId, ix.metas, ix.data, ctx));
}

program
  .command('show <index>')
  .description('decode a proposal: program, instruction, args, accounts')
  .action(async (indexArg) => {
    const globalOpts = program.opts<{ config?: string }>();
    const cfg = loadCfgOrFail(globalOpts);
    printClusterBanner(cfg);
    const conn = connect(cfg);
    await assertCluster(cfg, conn);
    if (!/^\d+$/.test(indexArg)) fail('index must be a non-negative integer');
    const index = BigInt(indexArg);
    const view = await fetchProposal(conn, cfg, index);
    console.log(c.dim(`status: ${view.status}  approved ${view.approvedCount}  rejected ${view.rejectedCount}`));
    const decoded = decodeProposalView(view, cfg);
    const allClean = renderProposal(index, decoded);
    if (!allClean) {
      console.log(c.redBold('WARNING: this proposal contains at least one UNDECODABLE or UNVERIFIED instruction. Do NOT approve unless you independently verify the raw bytes and account identities.'));
    }
  });

// ---- approve ----
program
  .command('approve <index>')
  .description('show the decoded proposal, then approve after explicit confirmation')
  .requiredOption('--keypair <path>', 'member keypair file (Vote permission)')
  .option('--yes', 'skip prompt ONLY for fully-decoded proposals (never for unknown ix)')
  .action(async (indexArg, opts) => {
    const globalOpts = program.opts<{ config?: string }>();
    const cfg = loadCfgOrFail(globalOpts);
    printClusterBanner(cfg);
    const conn = connect(cfg);
    await assertCluster(cfg, conn);
    if (!/^\d+$/.test(indexArg)) fail('index must be a non-negative integer');
    const index = BigInt(indexArg);

    // 1) Render the decoded proposal FIRST.
    const view = await fetchProposal(conn, cfg, index);
    const decoded = decodeProposalView(view, cfg);
    const allClean = renderProposal(index, decoded);

    // 2) Confirmation. Unknown/unverified ix OR mainnet forces the index-echo
    //    friction step; --yes is honored only for a fully-decoded-AND-verified,
    //    non-mainnet proposal.
    const isMainnet = cfg.cluster === 'mainnet-beta';
    const needEcho = !allClean || isMainnet;
    let confirmed: boolean;
    if (opts.yes && allClean && !isMainnet) {
      confirmed = true;
    } else {
      confirmed = await confirmSign(index, needEcho, cfg.cluster);
    }
    if (!confirmed) {
      console.log(c.dim('No signature sent.'));
      return;
    }

    // 3) Sign + send. Keypair is loaded ONLY now, from the file path.
    const member = loadKeypairFile(opts.keypair);
    const sig = await approveProposal(conn, cfg, member, index);
    console.log(c.green(`\nApproved. signature: ${sig}`));
  });

// ---- reject ----
program
  .command('reject <index>')
  .description('show the decoded proposal, then reject after confirmation')
  .requiredOption('--keypair <path>', 'member keypair file (Vote permission)')
  .action(async (indexArg, opts) => {
    const globalOpts = program.opts<{ config?: string }>();
    const cfg = loadCfgOrFail(globalOpts);
    printClusterBanner(cfg);
    const conn = connect(cfg);
    await assertCluster(cfg, conn);
    if (!/^\d+$/.test(indexArg)) fail('index must be a non-negative integer');
    const index = BigInt(indexArg);
    const view = await fetchProposal(conn, cfg, index);
    const decoded = decodeProposalView(view, cfg);
    renderProposal(index, decoded);
    const answer = await prompt(c.yellow(`Reject proposal #${index.toString()}? [y/N]: `));
    if (!(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes')) {
      console.log(c.dim('Aborted.'));
      return;
    }
    const member = loadKeypairFile(opts.keypair);
    const sig = await rejectProposal(conn, cfg, member, index);
    console.log(c.green(`\nRejected. signature: ${sig}`));
  });

// ---- execute ----
program
  .command('execute <index>')
  .description('execute an approved proposal')
  .requiredOption('--keypair <path>', 'member keypair file (Execute permission)')
  .action(async (indexArg, opts) => {
    const globalOpts = program.opts<{ config?: string }>();
    const cfg = loadCfgOrFail(globalOpts);
    printClusterBanner(cfg);
    const conn = connect(cfg);
    await assertCluster(cfg, conn);
    if (!/^\d+$/.test(indexArg)) fail('index must be a non-negative integer');
    const index = BigInt(indexArg);
    // Show what is about to execute (defense in depth).
    const view = await fetchProposal(conn, cfg, index);
    const decoded = decodeProposalView(view, cfg);
    const allClean = renderProposal(index, decoded);

    // Execution applies the on-chain effect. On mainnet — or whenever the
    // proposal is unknown/unverified — require the index-echo confirmation so a
    // real-money execute can never happen on a reflexive Enter.
    const isMainnet = cfg.cluster === 'mainnet-beta';
    if (isMainnet || !allClean) {
      const confirmed = await confirmSign(index, true, cfg.cluster);
      if (!confirmed) {
        console.log(c.dim('Execution aborted.'));
        return;
      }
    }

    const member = loadKeypairFile(opts.keypair);
    const sig = await executeProposal(conn, cfg, member, index);
    console.log(c.green(`\nExecuted. signature: ${sig}`));
  });

// Unknown Option import kept for potential future use; silence unused.
void Option;

program.parseAsync(process.argv).catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
});
