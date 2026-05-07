# vendor/

Vendored npm tarballs consumed by submodules via `file:` dependencies.

## Multiple versions during migration

This directory may hold **multiple versions of `@arlex/client` side-by-side** during a migration window, so each consumer can move independently. Currently single-version (all consumers on 0.3.0 after Phase 3.5 C.2 vendor refresh, 2026-05-07).

| Tarball | Consumed by | Migrated in |
|---|---|---|
| `arlex-client-0.3.0.tgz` | `dashboard/`, `sdk/`, `app/` | Phase 3.5 C.2 (2026-05-07) |

Older tarballs are removed only after **all consumers have moved off them** AND the integration plan marks the migration step closed. Do not delete a tarball just because it appears unreferenced — confirm in `plan/integration-plan.md` first.

## arlex-client-0.3.0.tgz

| Field | Value |
|---|---|
| Package | `@arlex/client@0.3.0` |
| Source repo | https://github.com/ArealFinance/arlex |
| Source path | `framework/client/` |
| Source SHA | `bf349ca` (Phase 3.5 codegen K merge, PR #6) |
| Branch | `main` (tag `v0.3.0`) |
| Packed | 2026-05-07 |
| Build | `npm run build && npm pack` (in `framework/client/`) |
| Tarball SHA256 | `6e98e6e2411bfd9c10398ce0ed8fdc6cbbd2a38edfb2b7cabc52f0d86af1e431` |
| Consumers | `dashboard/`, `sdk/`, `app/` (via `file:../vendor/arlex-client-0.3.0.tgz`) |

Verify with:
```bash
shasum -a 256 vendor/arlex-client-0.3.0.tgz
# expected: 6e98e6e2411bfd9c10398ce0ed8fdc6cbbd2a38edfb2b7cabc52f0d86af1e431
```

What 0.3.0 adds over 0.2.2 (BREAKING for codegen output layout):
- Codegen K: shared defined types (structs/enums referenced from multiple accounts/instructions) are now extracted into a separate file `defined-types.generated.ts` per program, instead of being duplicated in `accounts.generated.ts` and `instructions.generated.ts`.
- 4 generated files per program now: `accounts.generated.ts`, `instructions.generated.ts`, `defined-types.generated.ts`, plus the program index re-export.
- Generated runtime API surface unchanged for consumers that only use the program index re-export. Consumers that imported defined types directly from `accounts.generated` / `instructions.generated` need to update import paths.
- Consumer `package.json` peerDependency range bumped to `^0.3.0`.

## Why vendored

Pre-publish: `@arlex/client` will move to the npm registry after **Phase 6 GREEN** of the integration plan (`plan/integration-plan.md` §7 risks). Until then, the tarball lives here so any clone of the meta-repo gets a reproducible install with no external auth.

## Refresh procedure

See **`INFRASTRUCTURE.md` → "Updating @arlex/client"** for the full step-by-step flow.

Short version (for the current major version, e.g. 0.3.x):
1. Edit `framework/client/` (e.g., bug fix or feature).
2. `cd framework/client && npm test && npm run build && npm pack`.
3. `cp framework/client/arlex-client-0.3.0.tgz vendor/`.
4. For each consumer (`dashboard/`, `sdk/`, `app/`): `rm -rf node_modules/@arlex package-lock.json && npm install`.
5. Commit framework, consumers, and meta separately, in that order.

When introducing a **new major/minor** (e.g. 0.3.x → 0.4.0), keep the previous tarball alongside the new one until every consumer is bumped, then prune in a dedicated cleanup commit referencing the integration-plan step that authorised it.
