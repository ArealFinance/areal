/**
 * Wallet store — pure Svelte writable (not a rune) so it can be consumed
 * from `.ts` files (mock data layer, util fns) just as easily as `.svelte`
 * components via `$wallet`.
 *
 * Holds:
 *   - connected pubkey + adapter (so we can disconnect cleanly)
 *   - USDC balance (real, fetched from RPC after connect)
 *   - RWT balance (mocked — would be a real RPC read post-launch)
 */

import { writable, get } from 'svelte/store';
import {
	Connection,
	PublicKey,
	type Commitment
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
	connect as providerConnect,
	disconnect as providerDisconnect,
	type ConnectResult,
	type InjectedWallet,
	type WalletProviderId
} from './providers';
import { mockRwtBalance } from '$lib/earn/mock';

export const RPC_URL = 'https://rpc.areal.finance';
export const COMMITMENT: Commitment = 'confirmed';

// Mainnet USDC mint — matches the value used by the main app.
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

export interface WalletState {
	connected: boolean;
	connecting: boolean;
	providerId: WalletProviderId | null;
	publicKey: PublicKey | null;
	address: string | null;
	usdc: number;
	rwt: number;
	error: string | null;
}

const INITIAL: WalletState = {
	connected: false,
	connecting: false,
	providerId: null,
	publicKey: null,
	address: null,
	usdc: 0,
	rwt: 0,
	error: null
};

function createWalletStore() {
	const { subscribe, set, update } = writable<WalletState>(INITIAL);

	// We hold the adapter outside reactive state — it's an object reference with
	// no serializable identity. Keeping it in the store would force Svelte to
	// diff a non-plain object on every update.
	let adapter: InjectedWallet | null = null;
	const connection = new Connection(RPC_URL, COMMITMENT);

	async function fetchUsdcBalance(pubkey: PublicKey): Promise<number> {
		try {
			const ata = getAssociatedTokenAddressSync(USDC_MINT, pubkey);
			const res = await connection.getTokenAccountBalance(ata, COMMITMENT);
			return res.value.uiAmount ?? 0;
		} catch {
			// No ATA == zero balance. Any RPC error == surface zero, not crash.
			return 0;
		}
	}

	async function connectWallet(id: WalletProviderId): Promise<void> {
		update((s) => ({ ...s, connecting: true, error: null }));
		try {
			const result: ConnectResult = await providerConnect(id);
			adapter = result.adapter;

			update((s) => ({
				...s,
				connecting: false,
				connected: true,
				providerId: result.id,
				publicKey: result.publicKey,
				address: result.publicKey.toBase58(),
				rwt: mockRwtBalance(result.publicKey),
				error: null
			}));

			// Balance fetch happens asynchronously after the UI has flipped to
			// connected — keeps the connect transition snappy.
			const usdc = await fetchUsdcBalance(result.publicKey);
			update((s) => (s.connected ? { ...s, usdc } : s));
		} catch (err) {
			adapter = null;
			const message = err instanceof Error ? err.message : 'Connection failed';
			update((s) => ({ ...s, connecting: false, error: message }));
			throw err;
		}
	}

	async function disconnectWallet(): Promise<void> {
		await providerDisconnect(adapter);
		adapter = null;
		set(INITIAL);
	}

	async function refreshBalances(): Promise<void> {
		const current = get({ subscribe });
		if (!current.publicKey) return;
		const usdc = await fetchUsdcBalance(current.publicKey);
		update((s) => (s.connected ? { ...s, usdc } : s));
	}

	function mockSpendUsdc(amount: number, rwtMinted: number): void {
		// Local-only simulation for the demo mint flow. No tx is submitted.
		update((s) => ({
			...s,
			usdc: Math.max(0, s.usdc - amount),
			rwt: s.rwt + rwtMinted
		}));
	}

	return {
		subscribe,
		connect: connectWallet,
		disconnect: disconnectWallet,
		refreshBalances,
		mockSpendUsdc
	};
}

export const wallet = createWalletStore();
