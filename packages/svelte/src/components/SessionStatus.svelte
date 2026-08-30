<script lang="ts">
  import { sessionStatusPresentation, type OpenGeniSessionStatus } from "@opengeni/ui";

  let {
    status,
    label,
  }: {
    status: OpenGeniSessionStatus;
    label?: string;
  } = $props();
  let presentation = $derived(sessionStatusPresentation(status));
</script>

<span
  class="og-status"
  data-og-component="status"
  data-og-state={status}
  data-og-tone={presentation.tone}
  data-og-live={presentation.live}
  role="status"
  aria-live="polite"
>{label ?? presentation.label}</span>