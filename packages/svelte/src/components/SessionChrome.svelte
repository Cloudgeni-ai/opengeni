<script lang="ts">
  import { sessionStatusPresentation, type OpenGeniSessionStatus } from "@opengeni/ui";

  let {
    title,
    status,
    paused = false,
    controlling = false,
    queueCount = 0,
    approvalCount = 0,
    inputCount = 0,
    goalLabel,
    onPause,
    onResume,
  }: {
    title: string;
    status: OpenGeniSessionStatus;
    paused?: boolean;
    controlling?: boolean;
    queueCount?: number;
    approvalCount?: number;
    inputCount?: number;
    goalLabel?: string | undefined;
    onPause?: (() => unknown | Promise<unknown>) | undefined;
    onResume?: (() => unknown | Promise<unknown>) | undefined;
  } = $props();

  let presentation = $derived(sessionStatusPresentation(status));
</script>

<header class="og-chrome" data-og-component="chrome" data-og-state={paused ? "paused" : "ready"}>
  <div class="og-chrome__title" data-og-part="title" title={title}>{title}</div>
  <div class="og-chrome__actions" data-og-part="actions">
    {#if goalLabel}<span class="og-status" data-og-tone="neutral">{goalLabel}</span>{/if}
    {#if queueCount > 0}<span class="og-status" data-og-tone="neutral">Queue {queueCount}</span>{/if}
    {#if approvalCount > 0}<span class="og-status" data-og-tone="waiting">Approvals {approvalCount}</span>{/if}
    {#if inputCount > 0}<span class="og-status" data-og-tone="waiting">Questions {inputCount}</span>{/if}
    <span class="og-status" data-og-component="status" data-og-state={status} data-og-tone={presentation.tone} data-og-live={presentation.live} role="status" aria-live="polite" aria-atomic="true">{presentation.label}</span>
    {#if paused}
      <button class="og-button" type="button" disabled={controlling || !onResume} onclick={() => void onResume?.()}>Resume</button>
    {:else}
      <button class="og-button" type="button" disabled={controlling || !onPause} onclick={() => void onPause?.()}>Pause</button>
    {/if}
  </div>
</header>