# vendor/

Vendored npm tarballs consumed by submodules via `file:` dependencies.

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
| Consumers | `dashboard/` (via `file:../vendor/arlex-client-0.1.0.tgz`) |

Verify with:
```bash
shasum -a 256 vendor/arlex-client-0.1.0.tgz
# expected: 2f350c257c007d89276341ace9e987ab5209664343ab8d5fa43aebfca56ac8cf
```

### Why vendored

Pre-publish: `@arlex/client` will move to the npm registry after **Phase 6 GREEN** of the integration plan (`plan/integration-plan.md` §7 risks). Until then, the tarball lives here so any clone of the meta-repo gets a reproducible install with no external auth.

### Refresh procedure

See **`INFRASTRUCTURE.md` → "Updating @arlex/client"** for the full step-by-step flow.

Short version:
1. Edit `framework/client/` (e.g., bug fix or feature).
2. `cd framework/client && npm test && npm run build && npm pack`.
3. `cp framework/client/arlex-client-0.1.0.tgz vendor/`.
4. `cd dashboard && rm -rf node_modules/@arlex package-lock.json && npm install`.
5. Commit framework, dashboard, and meta separately, in that order.
