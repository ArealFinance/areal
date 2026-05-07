# vendor/

Vendored npm tarballs consumed by submodules via `file:` dependencies.

## Multiple versions during migration

This directory may hold **multiple versions of `@arlex/client` side-by-side** during a migration window, so each consumer can move independently. Currently single-version (all consumers on 0.3.1 after Phase 3.5 C.3 vendor refresh, 2026-05-07; previous 0.3.0 tarball pruned in the same step).

| Tarball | Consumed by | Migrated in |
|---|---|---|
| `arlex-client-0.3.1.tgz` | `dashboard/`, `sdk/`, `app/` | Phase 3.5 C.3 (2026-05-07) |

Older tarballs are removed only after **all consumers have moved off them** AND the integration plan marks the migration step closed. Do not delete a tarball just because it appears unreferenced — confirm in `plan/integration-plan.md` first.

## arlex-client-0.3.1.tgz

| Field | Value |
|---|---|
| Package | `@arlex/client@0.3.1` |
| Source repo | https://github.com/ArealFinance/arlex |
| Source path | `framework/client/` |
| Source SHA | `v0.3.1` (framework PR #7) |
| Branch | `main` (tag `v0.3.1`) |
| Packed | 2026-05-07 |
| Build | `npm run build && npm pack` (in `framework/client/`) |
| Tarball SHA256 | `90ffc9dc96fb73d43a510b93c641deca3fda4a431fd0b80d321d96e0d725205b` |
| Consumers | `dashboard/`, `sdk/`, `app/` (via `file:../vendor/arlex-client-0.3.1.tgz`) |

Verify with:
```bash
shasum -a 256 vendor/arlex-client-0.3.1.tgz
# expected: 90ffc9dc96fb73d43a510b93c641deca3fda4a431fd0b80d321d96e0d725205b
```

What 0.3.1 adds over 0.3.0 (non-breaking runtime extension):
- Runtime now applies pubkey overrides at decode time: `[u8;32]` fields listed in the per-account `PUBKEY_<NAME>_FIELDS` constants are wrapped as `PublicKey` instances by generated parsers, instead of returning raw `number[]` and requiring consumer-side adapters.
- Codegen emits the per-account `PUBKEY_<NAME>_FIELDS` constant arrays and threads them into the runtime parsers.
- Consumer-side `toPublicKey` adapters (e.g., `bots/nexus-manager/src/nexus-state-reader.ts`) were removed in C.3 (now redundant).
- No public API surface changes; consumer `peerDependencies` range `^0.3.0` continues to satisfy.

## Why vendored

Pre-publish: `@arlex/client` will move to the npm registry after **Phase 6 GREEN** of the integration plan (`plan/integration-plan.md` §7 risks). Until then, the tarball lives here so any clone of the meta-repo gets a reproducible install with no external auth.

## Refresh procedure

See **`INFRASTRUCTURE.md` → "Updating @arlex/client"** for the full step-by-step flow.

Short version (for the current major version, e.g. 0.3.x):
1. Edit `framework/client/` (e.g., bug fix or feature).
2. `cd framework/client && npm test && npm run build && npm pack`.
3. `cp framework/client/arlex-client-<version>.tgz vendor/`.
4. For each consumer (`dashboard/`, `sdk/`, `app/`): `rm -rf node_modules/@arlex package-lock.json && npm install`.
5. Commit framework, consumers, and meta separately, in that order.

When introducing a **new major/minor** (e.g. 0.3.x → 0.4.0), keep the previous tarball alongside the new one until every consumer is bumped, then prune in a dedicated cleanup commit referencing the integration-plan step that authorised it.
