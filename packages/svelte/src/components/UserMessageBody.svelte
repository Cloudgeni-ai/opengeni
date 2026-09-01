<script lang="ts">
  let { text, threshold = 720 }: { text: string; threshold?: number } = $props();
  let expanded = $state(false);
  let needsDisclosure = $derived(text.length > threshold || text.split("\n").length > 12);
  let visible = $derived(!needsDisclosure || expanded ? text : `${text.slice(0, threshold).trimEnd()}…`);
</script>

<div class="og-user-message" data-og-component="user-message" data-og-state={expanded ? "open" : "closed"}>
  <div class="og-user-message__text" data-og-part="message-text">{visible}</div>
  {#if needsDisclosure}
    <button class="og-button" type="button" aria-expanded={expanded} onclick={() => (expanded = !expanded)}>
      {expanded ? "Show less" : "Show more"}
    </button>
  {/if}
</div>