/*
 * gate-resolver.test.ts — R-66 unit tests.
 *
 * Pin the byte-equivalent shape of the gate-resolver helpers extracted from
 * `e2e-runner.ts`. Run via:
 *   cd bots && npx vitest run --root ../scripts/lib gate-resolver.test.ts
 *
 * (The `--root` override is required because vitest's default include
 * pattern is anchored to its working dir; the test lives outside the
 * `bots/` workspace where the vitest binary resides.)
 */

import { describe, it, expect } from 'vitest';

import {
  resolveScenarioGate,
  shapeFlowEntry,
  type BootstrapArtifact,
} from './gate-resolver.js';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const happyPath: BootstrapArtifact = {
  init_skipped: [],
  init_failed: [],
  pdas: {
    liquidity_holding: '11111111111111111111111111111111',
    liquidity_nexus: '11111111111111111111111111111112',
  },
};

const nexusInitFailed: BootstrapArtifact = {
  init_skipped: [],
  init_failed: [{ phase: 'DEX::initialize_nexus', error: 'AccountAlreadyInitialized' }],
  pdas: {
    liquidity_holding: '11111111111111111111111111111111',
  },
};

const r20Placeholder: BootstrapArtifact = {
  rwt_mint_placeholder: true,
  init_skipped: [],
  init_failed: [],
  pdas: {
    liquidity_holding: '11111111111111111111111111111111',
    liquidity_nexus: '11111111111111111111111111111112',
  },
};

// --------------------------------------------------------------------------
// resolveScenarioGate
// --------------------------------------------------------------------------

describe('resolveScenarioGate', () => {
  it('allows scenario-1 on a clean happy-path bootstrap', () => {
    const verdict = resolveScenarioGate('scenario-1', happyPath);
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  it('blocks scenario-5 when initialize_nexus is in init_failed[]', () => {
    const verdict = resolveScenarioGate('scenario-5', nexusInitFailed);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('init_failed');
    expect(verdict.details).toContain('initialize_nexus');
  });

  it('blocks scenario-3 when rwt_mint_placeholder is set (R20)', () => {
    const verdict = resolveScenarioGate('scenario-3', r20Placeholder);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('r20');
  });

  it('blocks lh-drain when liquidity_holding PDA is missing (R20 fallback)', () => {
    const noLh: BootstrapArtifact = {
      init_skipped: [],
      init_failed: [],
      pdas: {
        liquidity_nexus: '11111111111111111111111111111112',
      },
    };
    const verdict = resolveScenarioGate('lh-drain', noLh);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('r20');
    expect(verdict.details).toContain('R20');
  });

  it('blocks nexus-only with the legacy "gated on R57" string', () => {
    const noNexus: BootstrapArtifact = {
      init_skipped: ['DEX::initialize_nexus (build skipped)'],
      init_failed: [],
      pdas: {},
    };
    const verdict = resolveScenarioGate('nexus-only', noNexus);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toBe('r57');
    expect(verdict.details).toBe('gated on R57 — Liquidity Nexus not initialized');
  });

  it('allows scenario-2 / scenario-4 / scenario-6 on any bootstrap (no top-level gate)', () => {
    expect(resolveScenarioGate('scenario-2', nexusInitFailed).allowed).toBe(true);
    expect(resolveScenarioGate('scenario-4', nexusInitFailed).allowed).toBe(true);
    expect(resolveScenarioGate('scenario-6', nexusInitFailed).allowed).toBe(true);
  });
});

// --------------------------------------------------------------------------
// shapeFlowEntry
// --------------------------------------------------------------------------

describe('shapeFlowEntry', () => {
  it('shapes a gated entry as status=skipped + gate_reason', () => {
    const entry = shapeFlowEntry('mintRwt', 'gated', { gateReason: 'r20' });
    expect(entry.flow).toBe('mintRwt');
    expect(entry.status).toBe('skipped');
    expect(entry.gate_reason).toBe('r20');
  });

  it('shapes a passing entry with duration_ms', () => {
    const entry = shapeFlowEntry('publishYield', 'pass', { durationMs: 1234 });
    expect(entry.flow).toBe('publishYield');
    expect(entry.status).toBe('pass');
    expect(entry.duration_ms).toBe(1234);
    expect(entry.gate_reason).toBeUndefined();
  });

  it('round-trips through JSON.stringify / JSON.parse', () => {
    const entry = shapeFlowEntry('claimYield', 'fail', {
      reason: 'simulation revert',
      error: 'InsufficientFunds',
      durationMs: 42,
    });
    const round = JSON.parse(JSON.stringify(entry));
    expect(round).toEqual(entry);
  });
});
