/**
 * Direct wallet-provider integration — Phantom / Solflare / Backpack.
 *
 * We intentionally do NOT use `@solana/wallet-adapter-*` here. The earn
 * surface only needs three providers and a single `connect()` call; a full
 * adapter brings React and a multi-MB dependency tree.
 *
 * The injected providers expose almost-identical shapes:
 *   - `connect()` returns `{ publicKey: PublicKey }` (or an object exposing it)
 *   - `disconnect()` returns void
 *   - `publicKey` is available after a successful connect
 *
 * We narrow each shape just enough to compile.
 */

import type { PublicKey } from '@solana/web3.js';

export type WalletProviderId = 'phantom' | 'solflare' | 'backpack';

export interface WalletProviderInfo {
	id: WalletProviderId;
	name: string;
	installUrl: string;
}

export interface InjectedWallet {
	publicKey?: PublicKey | null;
	connect: () => Promise<{ publicKey: PublicKey }>;
	disconnect: () => Promise<void>;
}

export interface ConnectResult {
	id: WalletProviderId;
	publicKey: PublicKey;
	adapter: InjectedWallet;
}

interface PhantomLike {
	isPhantom?: boolean;
	publicKey?: PublicKey | null;
	connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>;
	disconnect: () => Promise<void>;
}

interface SolflareLike {
	isSolflare?: boolean;
	publicKey?: PublicKey | null;
	connect: () => Promise<boolean | { publicKey: PublicKey }>;
	disconnect: () => Promise<void>;
}

interface BackpackLike {
	isBackpack?: boolean;
	publicKey?: PublicKey | null;
	connect: () => Promise<{ publicKey: PublicKey }>;
	disconnect: () => Promise<void>;
}

declare global {
	interface Window {
		solana?: PhantomLike;
		solflare?: SolflareLike;
		backpack?: BackpackLike;
	}
}

export const ALL_PROVIDERS: WalletProviderInfo[] = [
	{ id: 'phantom', name: 'Phantom', installUrl: 'https://phantom.app/download' },
	{ id: 'solflare', name: 'Solflare', installUrl: 'https://solflare.com/download' },
	{ id: 'backpack', name: 'Backpack', installUrl: 'https://backpack.app/download' }
];

/** Returns the providers that appear to be installed in this browser. */
export function getAvailableProviders(): WalletProviderInfo[] {
	if (typeof window === 'undefined') return [];
	return ALL_PROVIDERS.filter((p) => isInstalled(p.id));
}

/** Returns ALL providers, with a flag for whether each is installed. */
export function listProviders(): Array<WalletProviderInfo & { installed: boolean }> {
	if (typeof window === 'undefined') {
		return ALL_PROVIDERS.map((p) => ({ ...p, installed: false }));
	}
	return ALL_PROVIDERS.map((p) => ({ ...p, installed: isInstalled(p.id) }));
}

function isInstalled(id: WalletProviderId): boolean {
	if (typeof window === 'undefined') return false;
	switch (id) {
		case 'phantom':
			return Boolean(window.solana?.isPhantom);
		case 'solflare':
			return Boolean(window.solflare?.isSolflare);
		case 'backpack':
			return Boolean(window.backpack?.isBackpack);
	}
}

function getInjected(id: WalletProviderId): InjectedWallet | null {
	if (typeof window === 'undefined') return null;
	switch (id) {
		case 'phantom':
			return window.solana
				? {
						publicKey: window.solana.publicKey ?? null,
						connect: () => window.solana!.connect(),
						disconnect: () => window.solana!.disconnect()
					}
				: null;
		case 'solflare':
			return window.solflare
				? {
						publicKey: window.solflare.publicKey ?? null,
						connect: async () => {
							const r = await window.solflare!.connect();
							// Solflare may return `true` on success rather than the publicKey;
							// fall back to reading `publicKey` off the injected provider.
							if (r && typeof r === 'object' && 'publicKey' in r) {
								return { publicKey: (r as { publicKey: PublicKey }).publicKey };
							}
							if (!window.solflare!.publicKey) {
								throw new Error('Solflare did not return a publicKey');
							}
							return { publicKey: window.solflare!.publicKey };
						},
						disconnect: () => window.solflare!.disconnect()
					}
				: null;
		case 'backpack':
			return window.backpack
				? {
						publicKey: window.backpack.publicKey ?? null,
						connect: () => window.backpack!.connect(),
						disconnect: () => window.backpack!.disconnect()
					}
				: null;
	}
}

/** Triggers the provider's connect prompt. Throws if not installed or rejected. */
export async function connect(id: WalletProviderId): Promise<ConnectResult> {
	const adapter = getInjected(id);
	if (!adapter) {
		throw new Error(`${id} wallet is not installed`);
	}
	const { publicKey } = await adapter.connect();
	return { id, publicKey, adapter };
}

/** Best-effort disconnect — never throws. */
export async function disconnect(adapter: InjectedWallet | null): Promise<void> {
	if (!adapter) return;
	try {
		await adapter.disconnect();
	} catch {
		// Some providers throw if already disconnected; ignore.
	}
}
