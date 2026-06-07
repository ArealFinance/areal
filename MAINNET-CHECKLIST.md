# Areal Earn — Mainnet Cutover Checklist

Living checklist for moving **app-earn** (`earn.areal.finance`) and its on-chain /
off-chain dependencies from devnet to mainnet-beta.

> Status legend: ✅ done · ☐ to do · 🔍 to verify · ⚠️ blocker / needs review
>
> Nothing here flips automatically. Treat every ☐/🔍 as a deliberate, reviewed step.
> The main app (`app.areal.finance`) is out of scope unless noted.

---

## 0. Pre-flight reviews (MANDATORY before cutover)

- ☐ Architect review of the full cutover diff (config, addresses, deploy scripts)
- ☐ Security review of contracts + keeper + any access-control / authority changes
- ☐ Sign-off that this checklist's blockers (⚠️) are all resolved

---

## 1. Token program / p-token compatibility

Context: SIMD-0266 (p-token) went live on **mainnet ~14 May 2026** as an **in-place,
feature-gated replacement** of the canonical SPL Token program (`TokenkegQ…`). Our
RWT/stRWT are classic SPL mints on that canonical address, so they inherit p-token's
~96% compute savings on token instructions automatically — no migration.

- ✅ **SDK / indexing compatibility audited (2026-06-07)** — no changes required.
  - All JS on `@solana/web3.js` 1.x + `@solana/spl-token` 0.4.x (no `@solana/kit` /
    `@solana-program/token`, no `spl-token-client`).
  - Verified surfaces:
    - `backend` holders.service `getProgramAccounts` filter (`dataSize 165`,
      `memcmp@0` mint, `dataSlice@64 len 8`) → p-token preserved account layout → OK.
    - `dashboard` layer8/layer9 `getParsedTransaction` reads `meta.logMessages` (our
      program logs), not token-instruction decoding → unaffected.
    - app-earn / sdk reads (`getAccount`/`getMint`/`AccountLayout`) → layout-compatible.
    - New p-token instructions (`batch`, `withdraw_excess_lamports`,
      `unwrap_lamports`) are neither built nor parsed by us → irrelevant.
  - Anza's "move to `@solana-program/token` 0.13 / `spl-token-client` 0.19" guidance
    targets indexers that decode token *instructions* — not our pattern (we read
    account state + own logs).
  - Empirical: devnet already runs p-token; our devnet reads work → proven in practice.
- 🔍 Re-confirm after any future SDK bump that we still don't decode raw token instructions.

---

## 2. On-chain: contracts & addresses

- ☐ Deploy contracts to mainnet (earn, staking, native-dex, rwt-engine,
  yield-distribution, futarchy, ownership-token — as required by earn scope)
- ☐ Record mainnet program IDs + mint/config/vault PDAs
- ☐ Set production authorities (upgrade authority, config authority) — multisig?
- 🔍 Confirm DLMM program ID is identical devnet↔mainnet (it is, per `config.ts`);
  only pool addresses differ
- ☐ Create / verify the Meteora DLMM pool (RWT/USDC) on mainnet; capture pool address
- ☐ Seed initial liquidity / NAV bootstrap per launch plan

## 3. app-earn (frontend) config

- ☐ `src/lib/chain/config.ts`: `CLUSTER = 'mainnet-beta'`, `RPC_URL` → production RPC
  (Helius mainnet — not the public rate-limited endpoint)
- ☐ Update all mint / program / pool addresses to mainnet values
- 🔍 Faucet (`FaucetButton`) auto-hides on mainnet via `IS_DEVNET` gate — verify it
  disappears once `CLUSTER` flips (and `FAUCET_API_BASE` unset in prod env)
- ✅ Devnet/demo UI labels removed (`9271722`) — header badge, modal copy, CTA, faucet hint
- 🔍 Wallet adapters point at mainnet; signed-tx path lands on mainnet connection
- 🔍 `app.html` `theme-color` is the mono near-black (not the legacy blue) — cosmetic

## 4. Backend & bots

- ☐ Backend `DATABASE_URL` / `REDIS_URL` / RPC env → production
- ☐ All bots/cranks RPC + cluster env → mainnet; secrets rotated for prod
- ☐ Keeper / yield distributor pointed at mainnet config
- ⚠️ **Keeper safety**: re-verify the fail-closed gates and host-allowlist work with
  the **mainnet** RPC apex host; ensure gate failures stay inert (log, never crash the
  app) and the keeper cannot run with a devnet/mainnet config mismatch
- ☐ `merkle-publisher` snapshot-taker validated against mainnet token program

## 5. Infra / deploy

- ☐ Cloudflare Pages env for app-earn (prod RPC, addresses) — no devnet leftovers
- ☐ CF → nginx → VPS routing for earn.areal.finance confirmed
- ☐ Monitoring / alerts on keeper + RPC health for mainnet

## 6. Post-cutover smoke test (mainnet, small amounts)

- ☐ Buy RWT (mint path) — confirms NAV, fee, mint CPI
- ☐ Stake → stRWT, then initiate + complete unstake (cooldown)
- ☐ Sell RWT on the DEX (Meteora) — small size
- ☐ Header rates (NAV / stRWT USD) render correct on-chain values
- ☐ Earn-stats (APY/earned) accumulate; no fabricated values
- ☐ No console errors; network requests hit prod endpoints only

---

_Last updated: 2026-06-07 — added p-token/SDK compatibility audit result (§1)._
