/**
 * Config + pubkey validation tests. No filesystem or network access.
 */
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  parsePubkey,
  resolveConfig,
  assertClusterIdentity,
  rpcLooksMainnet,
  GENESIS_HASHES,
  BPF_UPGRADEABLE_LOADER_ID,
  type RawConfig,
  type ResolvedConfig,
} from '../src/config.js';

const VALID = {
  multisig: 'HGh7TcuqUbTRrFTYBUtsTctAEEmsANWnDxeWcbgqMg8b',
  earn: 'HGh7TcuqUbTRrFTYBUtsTctAEEmsANWnDxeWcbgqMg8b',
  staking: 'CmKXHk3u6pDUC6Q11Le6gmhCgENQSFvduisXb7guUGoL',
  earnConfig: 'H4DBeFKwZsVrhMmMFG7HSMEQckeCYdewuri28kQ3wT4p',
  stakingConfig: 'BWb75dNXbJbteLsmKy58sfHj8nYVa6CqaDzJrWo1mP1R',
};

function baseRaw(): RawConfig {
  return {
    cluster: 'devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    multisig: VALID.multisig,
    vaultIndex: 0,
    programs: { earn: VALID.earn, staking: VALID.staking },
    configPdas: { earnConfig: VALID.earnConfig, stakingConfig: VALID.stakingConfig },
  };
}

describe('parsePubkey', () => {
  it('accepts a valid base58 pubkey', () => {
    const pk = parsePubkey(VALID.multisig, 'multisig');
    expect(pk).toBeInstanceOf(PublicKey);
    expect(pk.toBase58()).toBe(VALID.multisig);
  });

  it('rejects an empty string with a field-named error', () => {
    expect(() => parsePubkey('', 'multisig')).toThrow(/multisig/);
  });

  it('rejects an invalid base58 string', () => {
    expect(() => parsePubkey('not-a-key-0OIl', 'programs.earn')).toThrow(/programs.earn/);
  });

  it('rejects a too-short/invalid-length key', () => {
    expect(() => parsePubkey('abc', 'x')).toThrow();
  });
});

describe('resolveConfig', () => {
  it('resolves a valid devnet config and defaults the loader id', () => {
    const cfg = resolveConfig(baseRaw());
    expect(cfg.cluster).toBe('devnet');
    expect(cfg.multisig.toBase58()).toBe(VALID.multisig);
    expect(cfg.vaultIndex).toBe(0);
    expect(cfg.programs.bpfUpgradeableLoader.equals(BPF_UPGRADEABLE_LOADER_ID)).toBe(true);
    expect(cfg.earnRwtMint).toBeUndefined();
  });

  it('rejects an invalid cluster', () => {
    const raw = { ...baseRaw(), cluster: 'prod' as RawConfig['cluster'] };
    expect(() => resolveConfig(raw)).toThrow(/cluster/);
  });

  it('rejects a non-http rpc url', () => {
    const raw = { ...baseRaw(), rpcUrl: 'ftp://nope' };
    expect(() => resolveConfig(raw)).toThrow(/rpcUrl/);
  });

  it('rejects a mainnet label on a devnet rpc (ambiguous target guard)', () => {
    const raw = { ...baseRaw(), cluster: 'mainnet-beta' as const, rpcUrl: 'https://api.devnet.solana.com' };
    expect(() => resolveConfig(raw)).toThrow(/ambiguous|non-mainnet/i);
  });

  it('rejects a devnet label on a mainnet rpc (M1 inverse guard)', () => {
    const raw = { ...baseRaw(), cluster: 'devnet' as const, rpcUrl: 'https://api.mainnet-beta.solana.com' };
    expect(() => resolveConfig(raw)).toThrow(/MAINNET|ambiguous/i);
  });

  it('rejects a localnet label on an rpc whose host contains "mainnet"', () => {
    const raw = { ...baseRaw(), cluster: 'localnet' as const, rpcUrl: 'https://my-mainnet-proxy.example.com' };
    expect(() => resolveConfig(raw)).toThrow(/MAINNET|ambiguous/i);
  });

  it('accepts a real mainnet rpc with mainnet cluster', () => {
    const raw = { ...baseRaw(), cluster: 'mainnet-beta' as const, rpcUrl: 'https://api.mainnet-beta.solana.com' };
    const cfg = resolveConfig(raw);
    expect(cfg.cluster).toBe('mainnet-beta');
  });

  it('rejects an out-of-range vault index', () => {
    expect(() => resolveConfig({ ...baseRaw(), vaultIndex: 999 })).toThrow(/vaultIndex/);
  });

  it('surfaces a bad nested program pubkey with its field name', () => {
    const raw = baseRaw();
    raw.programs.earn = 'bogus';
    expect(() => resolveConfig(raw)).toThrow(/programs\.earn/);
  });

  it('carries through optional earnRwtMint + programData when present', () => {
    const raw = baseRaw();
    raw.earnRwtMint = '8hJPUC4UNsiyBh5cosTA8RqY9TbBSmnxqkBb2sHJ5qzM';
    raw.programData = { earn: '4rmaAQZXQEjdEBcUhjxrAUu7dn1TWRFhby5wAwQQuMRE' };
    const cfg = resolveConfig(raw);
    expect(cfg.earnRwtMint?.toBase58()).toBe('8hJPUC4UNsiyBh5cosTA8RqY9TbBSmnxqkBb2sHJ5qzM');
    expect(cfg.programData.earn?.toBase58()).toBe('4rmaAQZXQEjdEBcUhjxrAUu7dn1TWRFhby5wAwQQuMRE');
  });
});

describe('rpcLooksMainnet (M1 heuristic)', () => {
  it('detects the canonical mainnet rpc host', () => {
    expect(rpcLooksMainnet('https://api.mainnet-beta.solana.com')).toBe(true);
  });

  it('detects any url containing the mainnet substring', () => {
    expect(rpcLooksMainnet('https://my-mainnet.helius-rpc.com/?api-key=x')).toBe(true);
  });

  it('does not flag a devnet rpc', () => {
    expect(rpcLooksMainnet('https://api.devnet.solana.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(rpcLooksMainnet('https://API.MAINNET-BETA.solana.com')).toBe(true);
  });
});

describe('assertClusterIdentity (M1 genesis-hash check, no network)', () => {
  // Fake connection that returns a fixed genesis hash — keeps the test offline.
  const fakeConn = (hash: string) => ({ getGenesisHash: async () => hash });
  const failingConn = () => ({
    getGenesisHash: async () => {
      throw new Error('fetch failed');
    },
  });

  function cfg(cluster: ResolvedConfig['cluster']): ResolvedConfig {
    const base = resolveConfig(baseRaw());
    return { ...base, cluster };
  }

  it('passes when the genesis hash matches the configured label', async () => {
    const id = await assertClusterIdentity(cfg('devnet'), fakeConn(GENESIS_HASHES.devnet));
    expect(id.resolvedCluster).toBe('devnet');
    expect(id.matchesLabel).toBe(true);
  });

  it('THROWS when a devnet label faces a mainnet genesis hash (contradiction is fatal)', async () => {
    await expect(
      assertClusterIdentity(cfg('devnet'), fakeConn(GENESIS_HASHES['mainnet-beta'])),
    ).rejects.toThrow(/mislabeled|genesis/i);
  });

  it('THROWS when a mainnet label faces a devnet genesis hash', async () => {
    // A mainnet-labeled config must be on a real mainnet RPC; resolveConfig blocks
    // an obvious devnet url, but genesis hash is the authoritative cross-check.
    const mainnetCfg = resolveConfig({
      ...baseRaw(),
      cluster: 'mainnet-beta',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
    });
    await expect(
      assertClusterIdentity(mainnetCfg, fakeConn(GENESIS_HASHES.devnet)),
    ).rejects.toThrow(/mislabeled|genesis/i);
  });

  it('is non-fatal (label trusted) when the RPC is unreachable', async () => {
    const id = await assertClusterIdentity(cfg('devnet'), failingConn());
    expect(id.resolvedCluster).toBe('unreachable');
    expect(id.matchesLabel).toBe(true);
  });

  it('trusts the label for an unrecognized genesis hash (localnet/custom)', async () => {
    const id = await assertClusterIdentity(cfg('localnet'), fakeConn('SomeUnknownGenesisHash1111111111111111111111'));
    expect(id.resolvedCluster).toBe('unknown');
    expect(id.matchesLabel).toBe(true);
  });
});
