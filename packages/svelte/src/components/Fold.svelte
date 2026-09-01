<script lang="ts">
  import type { Snippet } from "svelte";
  let { label, open = false, children }: { label: string; open?: boolean; children?: Snippet } = $props();
</script>

<section class="og-fold" data-og-component="fold" data-og-state={open ? "open" : "closed"}>
  <button class="og-fold__trigger" type="button" aria-expanded={open} onclick={() => (open = !open)}>
    <span>{label}</span><span aria-hidden="true">{open ? "−" : "+"}</span>
  </button>
  {#if open}<div class="og-fold__body">{@render children?.()}</div>{/if}
</section>