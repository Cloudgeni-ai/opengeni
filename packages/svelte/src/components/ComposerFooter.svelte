<script lang="ts">
  import type { Snippet } from "svelte";
  let { children }: { children?: Snippet } = $props();
</script>
<footer class="og-composer__footer og-composer-footer" data-og-part="footer">{@render children?.()}</footer>
