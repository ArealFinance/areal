/**
 * SPA mode — no SSR, full prerender for the static adapter.
 * Cloudflare Pages serves the prerendered index.html for every route via
 * the `fallback: 'index.html'` setting in svelte.config.js.
 */
export const ssr = false;
export const prerender = true;
