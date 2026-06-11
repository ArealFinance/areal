#!/usr/bin/env node
/**
 * Local release gate for the earn + staking contract pair.
 *
 * This only checks repo-local configuration that can be verified without an
 * external audit or live chain access. It intentionally fails while non-devnet
 * deployment pins are left as zero placeholders.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
if (process.env.EARN_STAKING_RELEASE_ROOT && process.env.NODE_ENV !== 'test') {
  console.error(
    '[earn-staking-release-readiness] EARN_STAKING_RELEASE_ROOT is test-only; refusing override outside NODE_ENV=test',
  );
  process.exit(1);
}
const repoRoot = process.env.EARN_STAKING_RELEASE_ROOT
  ? resolve(process.env.EARN_STAKING_RELEASE_ROOT)
  : resolve(__dirname, '..');
const ZERO_PUBKEY_EXPR = /\[0u8;\s*32\]/;

const checks = [
  {
    file: 'contracts/earn/src/constants.rs',
    constName: 'BOOTSTRAP_AUTHORITY',
    reason: 'pins who may initialize EarnConfig on non-devnet builds',
  },
  {
    file: 'contracts/staking/src/constants.rs',
    constName: 'BOOTSTRAP_AUTHORITY',
    reason: 'pins who may initialize StakingConfig on non-devnet builds',
  },
  {
    file: 'contracts/staking/src/constants.rs',
    constName: 'EARN_RWT_MINT',
    reason: 'pins staking to the canonical earn-RWT mint on non-devnet builds',
  },
];

function findNonDevnetConst(source, constName) {
  const lines = source.split(/\r?\n/);
  const attrRe = /#\s*\[\s*cfg\s*\(\s*not\s*\(\s*feature\s*=\s*"devnet"\s*\)\s*\)\s*\]/;
  const constRe = new RegExp(`\\bpub\\s+const\\s+${constName}\\b`);

  for (let i = 0; i < lines.length; i++) {
    if (!attrRe.test(lines[i])) continue;

    let expr = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      expr += `${lines[j].trim()} `;
      if (constRe.test(lines[j]) && lines[j].includes(';')) return expr.trim();
      if (constRe.test(expr) && expr.includes(';')) return expr.trim();
      if (lines[j].trim().startsWith('#[')) break;
    }
  }

  return null;
}

const failures = [];

for (const check of checks) {
  const path = resolve(repoRoot, check.file);
  const source = readFileSync(path, 'utf8');
  const declaration = findNonDevnetConst(source, check.constName);

  if (!declaration) {
    failures.push(
      `${check.file}: missing non-devnet ${check.constName} declaration (${check.reason})`,
    );
    continue;
  }

  if (ZERO_PUBKEY_EXPR.test(declaration)) {
    failures.push(
      `${check.file}: non-devnet ${check.constName} is still [0u8; 32] (${check.reason})`,
    );
  }
}

if (failures.length > 0) {
  console.error('[earn-staking-release-readiness] FAILED');
  for (const failure of failures) console.error(` - ${failure}`);
  console.error(
    '[earn-staking-release-readiness] Set real production pins before a public/mainnet deploy. This local gate does not replace external audit.',
  );
  process.exit(1);
}

console.log('[earn-staking-release-readiness] OK');
for (const check of checks) {
  console.log(` - ${relative(repoRoot, resolve(repoRoot, check.file))}: ${check.constName}`);
}
