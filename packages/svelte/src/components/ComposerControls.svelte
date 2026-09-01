<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  let { children, class: className = "", ...rest }: HTMLAttributes<HTMLDivElement> & { children?: Snippet } = $props();
</script>
<div {...rest} class={`og-composer__controls og-composer-controls ${className}`.trim()} data-og-part="controls">{@render children?.()}</div>
