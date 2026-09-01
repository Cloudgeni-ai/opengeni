<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  let { children, class: className = "", ...rest }: HTMLAttributes<HTMLDivElement> & { children?: Snippet } = $props();
</script>
<div {...rest} class={`og-composer__actions og-composer-actions ${className}`.trim()} data-og-part="actions">{@render children?.()}</div>
