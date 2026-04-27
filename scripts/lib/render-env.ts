#!/usr/bin/env tsx
/*
 * render-env.ts — Layer 9 Substep 12: render `.env` files for each bot from
 * `.env.example` templates, substituting placeholders with values from
 * data/e2e-bootstrap.json.
 *
 * Public-repo readiness: this script never modifies the `.env.example`
 * templates (committed); it only writes `.env` files (gitignored).
 *
 * Cranks land with SEND_TX=false so they stay decision-only by default.
 * Substep 13 wires the env var into each crank's EnvSchema; flip it to
 * `true` (in the rendered .env, after a fresh deploy) for live-submit.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

interface OtRecord {
  ot_mint: string;
  accumulator_usdc_ata?: string;
  yd_distributor_pda?: string;
}

interface Artifact {
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
    arl_ot_mint?: string;
    rwt_mint?: string;
  };
  pdas?: {
    master_pool?: string;
    rwt_vault?: string;
    liquidity_holding?: string;
    liquidity_nexus?: string;
    [k: string]: string | undefined;
  };
  ots?: OtRecord[];
  bots?: Record<
    string,
    {
      keypair_path: string;
      pubkey: string;
    }
  >;
}

function log(msg: string): void {
  console.log(`[render-env] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[render-env] WARN: ${msg}`);
}

function loadArtifact(path: string): Artifact {
  if (!existsSync(path)) {
    throw new Error(`artifact not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Artifact;
}

/**
 * Replace one var in env body. Matches `KEY=...` lines (whole-line replace,
 * preserving trailing comments stripped). Adds the var at end-of-file if not
 * present.
 */
function setEnvVar(body: string, key: string, value: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}=.*$`, 'm');
  if (re.test(body)) {
    return body.replace(re, `${key}=${value}`);
  }
  // Not present — append.
  const sep = body.endsWith('\n') ? '' : '\n';
  return `${body}${sep}${key}=${value}\n`;
}

interface BotSpec {
  dir: string;
  keypairEnvVar?: string; // env var that points at the bot keypair
  /** function returning per-bot vars to substitute */
  vars: (art: Artifact) => Record<string, string>;
}

function rpcTuple(art: Artifact): string {
  const ws = art.ws_url ?? 'ws://127.0.0.1:8900';
  return `${art.rpc_url}|${ws}|100`;
}

function otProjects(art: Artifact): string {
  return (art.ots ?? []).map((o) => o.ot_mint).join(',');
}

const BOTS: BotSpec[] = [
  {
    dir: 'revenue-crank',
    keypairEnvVar: 'REVENUE_CRANK_KEYPAIR_PATH',
    vars: (art) => ({
      NETWORK: art.bootstrap_target === 'localhost' ? 'localnet' : art.bootstrap_target,
      RPC_URLS: rpcTuple(art),
      OT_PROGRAM_ID: art.programs.ownership_token,
      OT_PROJECTS: otProjects(art),
      LOCK_DIR: './data/locks',
      DB_PATH: './data/checkpoint.db',
      CHECK_INTERVAL_SECS: '60',
      LOG_LEVEL: 'info',
      SEND_TX: 'false',
    }),
  },
  {
    dir: 'convert-and-fund-crank',
    keypairEnvVar: 'CONVERT_FUND_CRANK_KEYPAIR_PATH',
    vars: (art) => ({
      NETWORK: art.bootstrap_target === 'localhost' ? 'localnet' : art.bootstrap_target,
      RPC_URLS: rpcTuple(art),
      YD_PROGRAM_ID: art.programs.yield_distribution,
      DEX_PROGRAM_ID: art.programs.native_dex,
      RWT_ENGINE_PROGRAM_ID: art.programs.rwt_engine,
      OT_PROGRAM_ID: art.programs.ownership_token,
      USDC_MINT: art.mints?.usdc_test_mint ?? '',
      RWT_MINT: art.mints?.rwt_mint ?? '',
      RWT_USDC_POOL: art.pdas?.master_pool ?? '',
      OT_PROJECTS: otProjects(art),
      COMPUTE_UNIT_LIMIT: '300000',
      COMPUTE_UNIT_PRICE_MICROLAMPORTS: '10000',
      SLIPPAGE_BPS: '100',
      LOCK_DIR: './data/locks',
      DB_PATH: './data/checkpoint.db',
      CHECK_INTERVAL_SECS: '60',
      MIN_CONVERT_USDC: '1000000',
      LOG_LEVEL: 'info',
      SEND_TX: 'false',
    }),
  },
  {
    dir: 'yield-claim-crank',
    keypairEnvVar: 'YIELD_CLAIM_CRANK_KEYPAIR_PATH',
    vars: (art) => ({
      NETWORK: art.bootstrap_target === 'localhost' ? 'localnet' : art.bootstrap_target,
      RPC_URLS: rpcTuple(art),
      LOCK_DIR: './data/locks',
      YD_PROGRAM_ID: art.programs.yield_distribution,
      RWT_ENGINE_PROGRAM_ID: art.programs.rwt_engine,
      DEX_PROGRAM_ID: art.programs.native_dex,
      OT_PROGRAM_ID: art.programs.ownership_token,
      PROOF_DIR: '../merkle-publisher/data/proofs',
      OT_PROJECTS: otProjects(art),
      OT_RWT_POOLS: art.pdas?.master_pool ?? '',
      ARL_OT_MINT: art.mints?.arl_ot_mint ?? '',
      RWT_MINT: art.mints?.rwt_mint ?? '',
      CLAIM_INTERVAL_SECS: '60',
      COMPUTE_UNIT_LIMIT: '150000',
      COMPUTE_UNIT_PRICE_MICROLAMPORTS: '10000',
      DB_PATH: './data/checkpoint.db',
      LOG_LEVEL: 'info',
      SEND_TX: 'false',
    }),
  },
  {
    dir: 'nexus-manager',
    keypairEnvVar: 'MANAGER_KEYPAIR_PATH',
    vars: (art) => ({
      RPC_URLS: rpcTuple(art),
      NETWORK: art.bootstrap_target === 'localhost' ? 'localnet' : art.bootstrap_target,
      LOCK_DIR: './data/locks',
      CHECKPOINT_DB: './data/nexus-manager.db',
      POLL_INTERVAL_SEC: '60',
      MIN_REBALANCE_USDC: '1000000',
      LP_TARGET_RATIO_BPS: '5000',
      LP_REBALANCE_TRIGGER_BPS: '500',
      MAX_POOL_CONCENTRATION_BPS: '5000',
      DEX_PROGRAM_ID: art.programs.native_dex,
      USDC_MINT: art.mints?.usdc_test_mint ?? '',
      RWT_MINT: art.mints?.rwt_mint ?? '',
      NEXUS_MANAGED_POOLS: art.pdas?.master_pool ?? '',
      LOG_LEVEL: 'info',
      SEND_TX: 'false',
    }),
  },
  {
    dir: 'merkle-publisher',
    // KMS_KEY_ID is path-based for local mode; bootstrap keeps the existing
    // local-mock-keypair.json target.
    vars: (art) => ({
      NETWORK: art.bootstrap_target === 'localhost' ? 'localnet' : art.bootstrap_target,
      RPC_URL: art.rpc_url,
      RPC_WS_URL: art.ws_url ?? 'ws://127.0.0.1:8900',
      ARCHIVAL_RPC_URL: art.rpc_url,
      YD_PROGRAM_ID: art.programs.yield_distribution,
      OT_PROGRAM_ID: art.programs.ownership_token,
      DEX_PROGRAM_ID: art.programs.native_dex,
      MIN_HOLDING_OT_LAMPORTS: '100000000',
      ARL_OT_TREASURY: art.mints?.arl_ot_mint ?? '',
      PUBLISHER_PUBKEY: art.bots?.['merkle-publisher']?.pubkey ?? '',
      PUBLISH_INTERVAL_MS: '60000',
      KMS_PROVIDER: 'local',
      KMS_KEY_ID: './local-mock-keypair.json',
      AWS_REGION: 'us-east-1',
      DB_PATH: './data/merkle-publisher.db',
      PROOF_DIR: './data/proofs',
      LOG_LEVEL: 'info',
    }),
  },
];

function renderBot(art: Artifact, spec: BotSpec): { written: string; skipped?: string } {
  const botRoot = join(REPO_ROOT, 'bots', spec.dir);
  const examplePath = join(botRoot, '.env.example');
  const envPath = join(botRoot, '.env');

  if (!existsSync(examplePath)) {
    return { written: envPath, skipped: `no .env.example at ${examplePath}` };
  }

  let body = readFileSync(examplePath, 'utf8');
  const vars = spec.vars(art);

  for (const [k, v] of Object.entries(vars)) {
    body = setEnvVar(body, k, v);
  }

  // Bot keypair path — sourced from artifact bots[<dir>].keypair_path, falls
  // back to the .env.example default when no entry yet.
  if (spec.keypairEnvVar) {
    const kp = art.bots?.[spec.dir]?.keypair_path;
    if (kp) {
      body = setEnvVar(body, spec.keypairEnvVar, kp);
    }
  }

  writeFileSync(envPath, body, 'utf8');
  return { written: envPath };
}

function main(): void {
  const artifactPath =
    process.argv[2] ?? join(REPO_ROOT, 'data', 'e2e-bootstrap.json');
  log(`loading artifact ${artifactPath}`);
  const art = loadArtifact(artifactPath);

  for (const spec of BOTS) {
    const r = renderBot(art, spec);
    if (r.skipped) {
      warn(`${spec.dir}: ${r.skipped}`);
    } else {
      log(`wrote ${r.written}`);
    }
  }
}

main();
