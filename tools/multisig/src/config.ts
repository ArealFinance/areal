/**
 * msig.config.json schema + load/validate helpers.
 *
 * The config file stores ONLY public data: the multisig address, the RPC url,
 * the cluster label, the vault authority index, the program ids, and the config
 * PDAs. It NEVER stores secret material — keys are read from keypair JSON files
 * passed explicitly on the command line (see `keypair.ts`).
 */
import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';

export type Cluster = 'devnet' | 'testnet' | 'mainnet-beta' | 'localnet';

export interface RawConfig {
  /** Human label for the target cluster. Drives the prominent banner. */
  cluster: Cluster;
  /** RPC HTTP endpoint. The ONLY network endpoint this tool ever talks to. */
  rpcUrl: string;
  /** Squads v4 multisig account address (base58). */
  multisig: string;
  /** Vault authority index (Squads "vault" PDA). Default 0. */
  vaultIndex: number;
  /** Program ids the proposer can target. */
  programs: {
    earn: string;
    staking: string;
    /** BPF Upgradeable Loader. Optional — defaults to the canonical id. */
    bpfUpgradeableLoader?: string;
  };
  /** Singleton config PDAs (the `authority`-gated accounts). */
  configPdas: {
    earnConfig: string;
    stakingConfig: string;
  };
  /** Optional: programData accounts for the `upgrade` command (BPF loader). */
  programData?: {
    earn?: string;
    staking?: string;
  };
  /** Optional: the earn-RWT mint, required by `earn-writedown` account list. */
  earnRwtMint?: string;
  /** Optional override of the Squads program id (defaults to mainnet id). */
  squadsProgramId?: string;
}

/** Resolved, validated config with PublicKey instances. */
export interface ResolvedConfig {
  cluster: Cluster;
  rpcUrl: string;
  multisig: PublicKey;
  vaultIndex: number;
  programs: {
    earn: PublicKey;
    staking: PublicKey;
    bpfUpgradeableLoader: PublicKey;
  };
  configPdas: {
    earnConfig: PublicKey;
    stakingConfig: PublicKey;
  };
  programData: {
    earn?: PublicKey;
    staking?: PublicKey;
  };
  earnRwtMint?: PublicKey;
  squadsProgramId?: PublicKey;
}

export const CONFIG_FILENAME = 'msig.config.json';

/** Canonical BPF Upgradeable Loader program id. */
export const BPF_UPGRADEABLE_LOADER_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);

/**
 * Genesis hashes for the public Solana clusters. The genesis hash is the
 * cryptographic identity of a chain — it cannot be spoofed by a relabeled RPC.
 * Used by `assertClusterIdentity` to catch a config whose `cluster` label
 * contradicts the chain the RPC actually serves.
 */
export const GENESIS_HASHES: Record<'mainnet-beta' | 'devnet' | 'testnet', string> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
};

/** Reverse map: genesis hash -> canonical cluster label (for diagnostics). */
const CLUSTER_BY_GENESIS: Record<string, string> = Object.fromEntries(
  Object.entries(GENESIS_HASHES).map(([cluster, hash]) => [hash, cluster]),
);

/** Substrings that, in an RPC url, strongly indicate a mainnet endpoint. */
const MAINNET_RPC_INDICATORS = ['api.mainnet-beta.solana.com', 'mainnet'];

/**
 * Best-effort synchronous guard: a non-mainnet cluster label pointing at an RPC
 * whose url advertises mainnet is almost certainly a mislabel and must be
 * rejected before any network call. Catches the inverse of the existing
 * "mainnet label on devnet RPC" check. Pure string heuristic — the authoritative
 * check is `assertClusterIdentity` (genesis hash) at command time.
 */
export function rpcLooksMainnet(rpcUrl: string): boolean {
  const lower = rpcUrl.toLowerCase();
  return MAINNET_RPC_INDICATORS.some((needle) => lower.includes(needle));
}

/**
 * Parse + validate a base58 pubkey, surfacing a clear, field-named error rather
 * than the opaque `Non-base58 character` thrown by web3.js.
 */
export function parsePubkey(value: string, field: string): PublicKey {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`config: ${field} must be a non-empty base58 string`);
  }
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`config: ${field} is not a valid base58 pubkey: "${value}"`);
  }
}

const VALID_CLUSTERS: Cluster[] = ['devnet', 'testnet', 'mainnet-beta', 'localnet'];

/** Validate a raw config object (after JSON parse) into a ResolvedConfig. */
export function resolveConfig(raw: RawConfig): ResolvedConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('config: expected a JSON object');
  }
  if (!VALID_CLUSTERS.includes(raw.cluster)) {
    throw new Error(
      `config: cluster must be one of ${VALID_CLUSTERS.join(', ')} (got "${raw.cluster}")`,
    );
  }
  if (typeof raw.rpcUrl !== 'string' || !/^https?:\/\//.test(raw.rpcUrl)) {
    throw new Error('config: rpcUrl must be an http(s) URL');
  }
  // Cross-check: refuse a mainnet label on an obviously devnet RPC and vice
  // versa, so a stale label can't silently mislead the operator banner.
  if (raw.cluster === 'mainnet-beta' && /devnet|testnet/i.test(raw.rpcUrl)) {
    throw new Error(
      `config: cluster=mainnet-beta but rpcUrl looks non-mainnet ("${raw.rpcUrl}") — refusing ambiguous target`,
    );
  }
  // The dangerous inverse: a non-mainnet label pointing at a mainnet RPC would
  // evade the red banner and the index-echo friction on a real-money chain.
  if (raw.cluster !== 'mainnet-beta' && rpcLooksMainnet(raw.rpcUrl)) {
    throw new Error(
      `config: cluster=${raw.cluster} but rpcUrl looks like MAINNET ("${raw.rpcUrl}") — refusing ambiguous target (a mainnet RPC must be labeled mainnet-beta)`,
    );
  }
  const vaultIndex = raw.vaultIndex ?? 0;
  if (!Number.isInteger(vaultIndex) || vaultIndex < 0 || vaultIndex > 255) {
    throw new Error('config: vaultIndex must be an integer in [0, 255]');
  }

  return {
    cluster: raw.cluster,
    rpcUrl: raw.rpcUrl,
    multisig: parsePubkey(raw.multisig, 'multisig'),
    vaultIndex,
    programs: {
      earn: parsePubkey(raw.programs?.earn, 'programs.earn'),
      staking: parsePubkey(raw.programs?.staking, 'programs.staking'),
      bpfUpgradeableLoader: raw.programs?.bpfUpgradeableLoader
        ? parsePubkey(raw.programs.bpfUpgradeableLoader, 'programs.bpfUpgradeableLoader')
        : BPF_UPGRADEABLE_LOADER_ID,
    },
    configPdas: {
      earnConfig: parsePubkey(raw.configPdas?.earnConfig, 'configPdas.earnConfig'),
      stakingConfig: parsePubkey(raw.configPdas?.stakingConfig, 'configPdas.stakingConfig'),
    },
    programData: {
      earn: raw.programData?.earn
        ? parsePubkey(raw.programData.earn, 'programData.earn')
        : undefined,
      staking: raw.programData?.staking
        ? parsePubkey(raw.programData.staking, 'programData.staking')
        : undefined,
    },
    earnRwtMint: raw.earnRwtMint ? parsePubkey(raw.earnRwtMint, 'earnRwtMint') : undefined,
    squadsProgramId: raw.squadsProgramId
      ? parsePubkey(raw.squadsProgramId, 'squadsProgramId')
      : undefined,
  };
}

/** Read + resolve the config file at `path`. */
export function loadConfig(path: string): ResolvedConfig {
  let raw: RawConfig;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`config: failed to read ${path}: ${msg}`);
  }
  return resolveConfig(raw);
}

/** Minimal connection shape for the genesis-hash check (keeps `config` SDK-free). */
export interface GenesisHashSource {
  getGenesisHash(): Promise<string>;
}

export interface ClusterIdentity {
  /** The chain the RPC actually serves, by genesis hash, or 'unknown'. */
  resolvedCluster: string;
  genesisHash: string;
  /** Whether the resolved chain matches the configured `cluster` label. */
  matchesLabel: boolean;
}

/**
 * Authoritative cluster check: compare the configured `cluster` label against
 * the genesis hash the RPC actually serves.
 *
 * - On a genuine CONTRADICTION (the genesis hash maps to a known cluster that is
 *   NOT the configured label) → throws. This is fatal: a devnet-labeled config
 *   pointing at mainnet must never proceed.
 * - On a network error (RPC unreachable) → resolves with `resolvedCluster:
 *   'unreachable'` and `matchesLabel: true` (non-fatal: we cannot prove a
 *   contradiction, so we do not block offline/flaky usage).
 * - On an unrecognized genesis hash (e.g. localnet) → non-fatal; the label is
 *   trusted, `resolvedCluster: 'unknown'`.
 */
export async function assertClusterIdentity(
  cfg: ResolvedConfig,
  conn: GenesisHashSource,
): Promise<ClusterIdentity> {
  let genesisHash: string;
  try {
    genesisHash = await conn.getGenesisHash();
  } catch {
    // RPC unreachable — cannot prove a contradiction. Do not block.
    return { resolvedCluster: 'unreachable', genesisHash: '', matchesLabel: true };
  }

  const resolvedCluster = CLUSTER_BY_GENESIS[genesisHash];
  if (!resolvedCluster) {
    // Unknown chain (localnet / custom validator). Trust the label.
    return { resolvedCluster: 'unknown', genesisHash, matchesLabel: true };
  }
  if (resolvedCluster !== cfg.cluster) {
    throw new Error(
      `config: cluster label is "${cfg.cluster}" but the RPC's genesis hash ` +
        `(${genesisHash}) identifies it as "${resolvedCluster}". ` +
        `Refusing to operate against a mislabeled cluster.`,
    );
  }
  return { resolvedCluster, genesisHash, matchesLabel: true };
}
