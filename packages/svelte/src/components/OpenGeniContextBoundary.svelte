<script lang="ts">
  import type { Snippet } from "svelte";
  import { setOpenGeniContext, type OpenGeniSvelteContext } from "../context";

  let {
    context,
    children,
  }: { context: OpenGeniSvelteContext; children: Snippet | undefined } = $props();
  // This component is recreated whenever an authority-bearing context field
  // changes, so descendants cannot retain controllers from the prior context.
  // svelte-ignore state_referenced_locally
  setOpenGeniContext(context);
</script>

{@render children?.()}
