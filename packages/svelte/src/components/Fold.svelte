<script lang="ts">
  import type { Snippet } from "svelte";
  let { label, open = false, children }: { label: string; open?: boolean; children?: Snippet } = $props();
</script>

<section class="og-fold" data-og-component="fold" data-og-state={open ? "open" : "closed"}>
  <button class="og-fold__trigger" type="button" aria-expanded={open} onclick={() => (open = !open)}>
    <span>{label}</span><svg aria-hidden="true" viewBox="0 0 20 20"><path d={open ? "m6 8 4 4 4-4" : "m8 6 4 4-4 4"} /></svg>
  </button>
  {#if open}<div class="og-fold__body">{@render children?.()}</div>{/if}
</section>
