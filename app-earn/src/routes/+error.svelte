<script lang="ts">
	import { page } from '$app/state';
</script>

<main class="err">
	<h1>{page.status}</h1>
	<p>{page.error?.message ?? 'Something went wrong.'}</p>
	<a href="/">← Back to earn</a>
</main>

<style>
	.err {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-3);
		min-height: 100vh;
		padding: var(--space-6);
		text-align: center;
	}

	h1 {
		font-family: var(--font-sans);
		font-size: var(--text-4xl);
		font-weight: var(--font-weight-bold);
		color: var(--color-primary);
	}

	p {
		color: var(--color-text-muted);
	}

	a {
		margin-top: var(--space-4);
	}
</style>
