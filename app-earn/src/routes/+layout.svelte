<script lang="ts">
	import '$lib/styles/tokens.css';
	import '$lib/styles/global.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>Areal Earn — Yield on RWT</title>
</svelte:head>

{@render children?.()}
