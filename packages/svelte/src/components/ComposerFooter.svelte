<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  let { children, class: className = "", ...rest }: HTMLAttributes<HTMLElement> & { children?: Snippet } = $props();
</script>
<footer {...rest} class={`og-composer__footer og-composer-footer ${className}`.trim()} data-og-part="footer">{@render children?.()}</footer>
