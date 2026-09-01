<script lang="ts">
  import type { Snippet } from "svelte";
  let { children }: { children?: Snippet } = $props();
</script>

<div class="og-composer__frame" data-og-part="body"><div class="og-composer__surface" data-og-part="content">{@render children?.()}</div></div>
