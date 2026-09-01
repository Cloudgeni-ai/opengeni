<script lang="ts">
  let {
    hasOlder = false,
    hasNewer = false,
    loadingOlder = false,
    loadingNewer = false,
    loadingLatest = false,
    onOlder,
    onNewer,
    onOldest,
    onLatest,
  }: {
    hasOlder?: boolean;
    hasNewer?: boolean;
    loadingOlder?: boolean;
    loadingNewer?: boolean;
    loadingLatest?: boolean;
    onOlder?: (() => unknown | Promise<unknown>) | undefined;
    onNewer?: (() => unknown | Promise<unknown>) | undefined;
    onOldest?: (() => unknown | Promise<unknown>) | undefined;
    onLatest?: (() => unknown | Promise<unknown>) | undefined;
  } = $props();
</script>

<nav class="og-history-controls" data-og-component="history" aria-label="Session history">
  {#if hasOlder}
    <button class="og-button" type="button" disabled={loadingOlder} onclick={() => void onOldest?.()}>Start</button>
    <button class="og-button" type="button" disabled={loadingOlder} onclick={() => void onOlder?.()}>{loadingOlder ? "Loading…" : "Older"}</button>
  {/if}
  {#if hasNewer}
    <button class="og-button" type="button" disabled={loadingNewer} onclick={() => void onNewer?.()}>{loadingNewer ? "Loading…" : "Newer"}</button>
    <button class="og-button" type="button" disabled={loadingLatest} onclick={() => void onLatest?.()}>{loadingLatest ? "Loading…" : "Latest"}</button>
  {/if}
</nav>