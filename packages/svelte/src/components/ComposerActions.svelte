<script lang="ts">
  import type { Snippet } from "svelte";
  let { children }: { children?: Snippet } = $props();
</script>
<div class="og-composer__actions og-composer-actions" data-og-part="actions">{@render children?.()}</div>
