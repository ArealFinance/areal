/**
 * Keypair loading. SECURITY: secret material comes ONLY from a keypair JSON file
 * passed by path. Never from CLI args, env, or the config file. The secret bytes
 * are never printed or logged — only the derived public key is ever surfaced.
 */
import { readFileSync, statSync, type Stats } from 'node:fs';
import { Keypair } from '@solana/web3.js';

/**
 * Inspect file permission bits and return a non-secret warning string when the
 * keypair file is group- or world-accessible (any of the lower 6 mode bits set).
 * Returns `undefined` when the permissions are safe. On platforms without POSIX
 * mode bits (e.g. Windows), `mode & 0o077` is typically 0, so no warning fires.
 * Exported for testing; the warning is advisory and never blocks loading.
 */
export function keypairPermissionWarning(stat: Stats, path: string): string | undefined {
  const groupOrWorld = stat.mode & 0o077;
  if (groupOrWorld === 0) return undefined;
  const modeStr = (stat.mode & 0o777).toString(8).padStart(3, '0');
  return (
    `keypair file ${path} is group/world-accessible (mode ${modeStr}). ` +
    `Restrict it with \`chmod 600 ${path}\` so only you can read the secret key.`
  );
}

/**
 * Load a Solana CLI-style keypair (a JSON array of 64 bytes) from `path`.
 * Throws a clear, non-secret error on any malformed input.
 */
export function loadKeypairFile(path: string): Keypair {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`keypair file not found: ${path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`keypair path is not a file: ${path}`);
  }

  // Advisory: warn (do NOT block) if the secret file is too permissive.
  const permWarning = keypairPermissionWarning(stat, path);
  if (permWarning) {
    console.warn(`warning: ${permWarning}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Deliberately do NOT echo file contents — they are secret.
    throw new Error(`keypair file is not valid JSON: ${path}`);
  }

  if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === 'number')) {
    throw new Error(
      `keypair file must be a JSON array of byte numbers (Solana CLI format): ${path}`,
    );
  }
  if (parsed.length !== 64) {
    throw new Error(
      `keypair file must contain exactly 64 bytes (got ${parsed.length}): ${path}`,
    );
  }

  try {
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  } catch {
    throw new Error(`keypair file does not contain a valid ed25519 secret key: ${path}`);
  }
}
