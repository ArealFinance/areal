# app-earn

Retail-friendly SvelteKit frontend for `earn.areal.finance` — a "deposit USDC, get RWT, NAV grows automatically" product.

V1 is **mint-only** and runs on mocked data (contract not yet deployed).

## Stack

- SvelteKit 2 + Svelte 5 (runes mode)
- TypeScript strict
- `@sveltejs/adapter-static` with SPA fallback (CF Pages ready)
- `@solana/web3.js` + `@solana/spl-token` for wallet/balance reads
- Direct wallet injections (Phantom / Solflare / Backpack) — no wallet adapter lib
- `lucide-svelte` icons
- Vanilla CSS + design tokens (no Tailwind, no UI library)

## Develop

```bash
npm install
npm run dev
```

Serves at http://localhost:5173.

## Build

```bash
npm run build
```

Output goes to `build/`. Static SPA, ready for Cloudflare Pages.

## Type check

```bash
npm run check
```

## Cloudflare Pages deploy

- **Root directory:** `app-earn`
- **Build command:** `npm run build`
- **Build output directory:** `build`

`+layout.ts` sets `ssr = false` and `prerender = true`. `adapter-static` with `fallback: 'index.html'` makes the build a true SPA.

## Mock data

The whole NAV/APR/balance layer is mocked in `src/lib/earn/mock.ts`. A small "Demo data" badge is visible in every state so reviewers know the numbers aren't live.

When the earn contract is deployed:

1. Replace `simulateLiveNav()` / `MOCK_*` with calls to the on-chain program.
2. Replace `mockMintQuote()` with the real swap-via-Areal quote.
3. Replace the mock mint flow in `MintModal.svelte` with `connection.sendTransaction(...)`.
