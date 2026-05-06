# vendor/

Vendored npm tarballs consumed by submodules via `file:` dependencies.

## Multiple versions during migration

This directory may hold **multiple versions of `@arlex/client` side-by-side** during a migration window, so each consumer can move independently. Currently single-version (all consumers on 0.2.2 after Group A4 vendor refresh, 2026-05-06).

| Tarball | Consumed by | Migrated in |
|---|---|---|
| `arlex-client-0.2.2.tgz` | `dashboard/`, `sdk/`, `app/` | Group A4 (2026-05-06) |

Older tarballs are removed only after **all consumers have moved off them** AND the integration plan marks the migration step closed. Do not delete a tarball just because it appears unreferenced — confirm in `plan/integration-plan.md` first.

## arlex-client-0.2.2.tgz

| Field | Value |
|---|---|
| Package | `@arlex/client@0.2.2` |
| Source repo | https://github.com/ArealFinance/arlex |
| Source path | `framework/client/` |
| Source SHA | `7bf60f7083241c257b516a6cbdb67a75c4ead003` (Phase 0.2.2 merge) |
| Branch | `main` (tag `v0.2.2`) |
| Packed | 2026-05-06 |
| Build | `npm run build && npm pack` (in `framework/client/`) |
| Tarball SHA256 | `c9c3d2cb3a9dc6bcadf72a490b5c43f413383bc972e6e00cb6b38601be3f9b35` |
| Consumers | `dashboard/`, `sdk/`, `app/` (via `file:../vendor/arlex-client-0.2.2.tgz`) |

Verify with:
```bash
shasum -a 256 vendor/arlex-client-0.2.2.tgz
# expected: c9c3d2cb3a9dc6bcadf72a490b5c43f413383bc972e6e00cb6b38601be3f9b35
```

What 0.2.2 adds over 0.2.1:
- Codegen template `Buffer` import — generated client modules now self-import `Buffer` instead of relying on consumer's global polyfill.
- New CLI E2E test covering `arlex codegen` end-to-end.
- New browser-bundle smoke test guarding against accidental Node-only re-exports leaking into the browser entry (the regression class fixed in 0.2.1).
- No breaking API changes — semver-compatible with 0.2.x consumers.

## Why vendored

Pre-publish: `@arlex/client` will move to the npm registry after **Phase 6 GREEN** of the integration plan (`plan/integration-plan.md` §7 risks). Until then, the tarball lives here so any clone of the meta-repo gets a reproducible install with no external auth.

## Refresh procedure

See **`INFRASTRUCTURE.md` → "Updating @arlex/client"** for the full step-by-step flow.

Short version (for the current major version, e.g. 0.2.x):
1. Edit `framework/client/` (e.g., bug fix or feature).
2. `cd framework/client && npm test && npm run build && npm pack`.
3. `cp framework/client/arlex-client-0.2.2.tgz vendor/`.
4. For each consumer (`dashboard/`, `sdk/`, `app/`): `rm -rf node_modules/@arlex package-lock.json && npm install`.
5. Commit framework, consumers, and meta separately, in that order.

When introducing a **new major/minor** (e.g. 0.2.x → 0.3.0), keep the previous tarball alongside the new one until every consumer is bumped, then prune in a dedicated cleanup commit referencing the integration-plan step that authorised it.
