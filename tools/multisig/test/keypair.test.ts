/**
 * Keypair loader tests. Verifies file-only loading and clear errors. Uses temp
 * files; no network access. Asserts no secret bytes appear in thrown errors.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { loadKeypairFile, keypairPermissionWarning } from '../src/keypair.js';

const created: string[] = [];
function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'msig-test-'));
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  created.push(dir);
  return p;
}

afterEach(() => {
  for (const d of created.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('loadKeypairFile', () => {
  it('loads a valid 64-byte Solana CLI keypair', () => {
    const kp = Keypair.generate();
    const path = tmpFile('id.json', JSON.stringify(Array.from(kp.secretKey)));
    const loaded = loadKeypairFile(path);
    expect(loaded.publicKey.equals(kp.publicKey)).toBe(true);
  });

  it('throws a clear error for a missing file (no secret echo)', () => {
    expect(() => loadKeypairFile('/no/such/file.json')).toThrow(/not found/);
  });

  it('throws for invalid JSON without echoing file contents', () => {
    const secret = 'SUPER_SECRET_CONTENT_THAT_MUST_NOT_LEAK';
    const path = tmpFile('bad.json', secret);
    try {
      loadKeypairFile(path);
      throw new Error('should have thrown');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toMatch(/not valid JSON/);
      expect(msg).not.toContain(secret);
    }
  });

  it('rejects a JSON array of the wrong length', () => {
    const path = tmpFile('short.json', JSON.stringify([1, 2, 3]));
    expect(() => loadKeypairFile(path)).toThrow(/exactly 64 bytes/);
  });

  it('rejects a non-array JSON value', () => {
    const path = tmpFile('obj.json', JSON.stringify({ secret: [1, 2, 3] }));
    expect(() => loadKeypairFile(path)).toThrow(/array of byte numbers/);
  });
});

describe('keypairPermissionWarning (INFO: advisory perm check)', () => {
  it('warns for a group/world-readable file (0644)', () => {
    const path = tmpFile('loose.json', JSON.stringify(Array.from(Keypair.generate().secretKey)));
    chmodSync(path, 0o644);
    const warn = keypairPermissionWarning(statSync(path), path);
    expect(warn).toBeDefined();
    expect(warn).toMatch(/group\/world-accessible/);
    expect(warn).toMatch(/chmod 600/);
  });

  it('does not warn for an owner-only file (0600)', () => {
    const path = tmpFile('tight.json', JSON.stringify(Array.from(Keypair.generate().secretKey)));
    chmodSync(path, 0o600);
    expect(keypairPermissionWarning(statSync(path), path)).toBeUndefined();
  });

  it('warns for a world-writable file (0666)', () => {
    const path = tmpFile('wide.json', JSON.stringify(Array.from(Keypair.generate().secretKey)));
    chmodSync(path, 0o666);
    expect(keypairPermissionWarning(statSync(path), path)).toBeDefined();
  });
});
