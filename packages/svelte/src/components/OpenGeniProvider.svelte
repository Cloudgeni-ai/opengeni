<script lang="ts">
  import type { Snippet } from "svelte";
  import { setOpenGeniContext, type OpenGeniSvelteContext } from "../context";

  let { context, children }: { context: OpenGeniSvelteContext; children?: Snippet } = $props();
  // svelte-ignore state_referenced_locally
  setOpenGeniContext(context);
</script>

<div class="og-root" data-og-component="session">
  {@render children?.()}
</div>