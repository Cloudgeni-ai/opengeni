<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  let { children, class: className = "", ...rest }: HTMLAttributes<HTMLDivElement> & { children?: Snippet } = $props();
</script>

<div class="og-composer__frame" data-og-part="body"><div {...rest} class={`og-composer__surface ${className}`.trim()} data-og-part="content">{@render children?.()}</div></div>
