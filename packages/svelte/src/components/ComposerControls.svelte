<script lang="ts">
  import type { Snippet } from "svelte";
  let { children }: { children?: Snippet } = $props();
</script>
<div class="og-composer__controls og-composer-controls" data-og-part="controls">{@render children?.()}</div>
