# vendor/

Vendored npm tarballs consumed by submodules via `file:` dependencies.

## Multiple versions during migration

During the Phase 3 → Phase 4 transition, **multiple versions of `@arlex/client` are intentionally retained side-by-side** in this directory. This lets each consumer migrate independently:

| Tarball | Consumed by | Migrated in |
|---|---|---|
| `arlex-client-0.1.0.tgz` | (no current consumers — retained as rollback artefact until Phase 4 close) | n/a |
| `arlex-client-0.2.1.tgz` | `dashboard/` | Phase 3 Step L (current) |

Older tarballs are removed only after **all consumers have moved off them** AND the integration plan marks the migration step closed. Do not delete a tarball just because it appears unreferenced — confirm in `plan/integration-plan.md` first.

## arlex-client-0.2.1.tgz

| Field | Value |
|---|---|
| Package | `@arlex/client@0.2.1` |
| Source repo | https://github.com/ArealFinance/arlex |
| Source path | `framework/client/` |
| Source SHA | `7585829fe8f6f20ce561513d3f36b04305f1ae07` |
| Branch | `main` (tag `v0.2.1`, Phase 2 regression fix merge) |
| Packed | 2026-05-06 |
| Build | `npm run build && npm pack` (in `framework/client/`) |
| Tarball SHA256 | `a116b967332c639bd8e428a267f30ef6454ee311d130f90a021d7c00cd066f9e` |
| Consumers | `dashboard/` (via `file:../vendor/arlex-client-0.2.1.tgz`) |

Verify with:
```bash
shasum -a 256 vendor/arlex-client-0.2.1.tgz
# expected: a116b967332c639bd8e428a267f30ef6454ee311d130f90a021d7c00cd066f9e
```

What 0.2.1 adds over 0.1.0:
- New `arlex codegen` CLI subcommand (and `dist/codegen-runtime.{js,mjs,d.ts,d.mts}`).
- Additive runtime — no breaking changes vs 0.1.0 (per Phase 2 acceptance).

What 0.2.1 fixes over 0.2.0:
- Removes accidental Node-only re-export from main entry — `src/index.ts` had `export * from './codegen'`, which pulled `fs`/`path` imports from `codegen/writer.ts` into the browser bundle. Vite/Rollup correctly refused to resolve `__vite-browser-external` for `promises`, breaking dashboard build.
- Codegen API remains exposed via `@arlex/client/codegen-runtime` (browser-safe) and the `arlex-cli` binary (Node-only build-time tool).
- 0.2.0 was never consumed by any committed state of the meta-repo — its tarball was a transient working-tree artefact and has been removed in the same change that adds 0.2.1.

## arlex-client-0.1.0.tgz

| Field | Value |
|---|---|
| Package | `@arlex/client@0.1.0` |
| Source repo | https://github.com/ArealFinance/arlex |
| Source path | `framework/client/` |
| Source SHA | `c28a43b5ad255904b904e38507eb158a1584bed8` |
| Branch | `main` |
| Packed | 2026-05-06 |
| Build | `npm run build && npm pack` (in `framework/client/`) |
| Tarball SHA256 | `2f350c257c007d89276341ace9e987ab5209664343ab8d5fa43aebfca56ac8cf` |
| Consumers | (none in-tree as of Phase 3 Step L — see "Multiple versions" above) |

Verify with:
```bash
shasum -a 256 vendor/arlex-client-0.1.0.tgz
# expected: 2f350c257c007d89276341ace9e987ab5209664343ab8d5fa43aebfca56ac8cf
```

## Why vendored

Pre-publish: `@arlex/client` will move to the npm registry after **Phase 6 GREEN** of the integration plan (`plan/integration-plan.md` §7 risks). Until then, the tarball lives here so any clone of the meta-repo gets a reproducible install with no external auth.

## Refresh procedure

See **`INFRASTRUCTURE.md` → "Updating @arlex/client"** for the full step-by-step flow.

Short version (for the current major version, e.g. 0.2.x):
1. Edit `framework/client/` (e.g., bug fix or feature).
2. `cd framework/client && npm test && npm run build && npm pack`.
3. `cp framework/client/arlex-client-0.2.1.tgz vendor/`.
4. `cd dashboard && rm -rf node_modules/@arlex package-lock.json && npm install`.
5. Commit framework, dashboard, and meta separately, in that order.

When introducing a **new major/minor** (e.g. 0.2.0 → 0.3.0), keep the previous tarball alongside the new one until every consumer is bumped, then prune in a dedicated cleanup commit referencing the integration-plan step that authorised it.
