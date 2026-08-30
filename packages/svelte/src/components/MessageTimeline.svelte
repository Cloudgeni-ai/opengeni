<script lang="ts">
  import { buildTimeline, groupTimeline, type SessionEventStore } from "@opengeni/sdk/session";
  import type { TimelineRendererRegistry } from "../renderers";
  import { readableFromController } from "../store";
  import HistoryControls from "./HistoryControls.svelte";
  import TimelineGroup from "./TimelineGroup.svelte";

  let {
    controller,
    label = "Session timeline",
    renderers,
  }: {
    controller: SessionEventStore;
    label?: string;
    renderers?: TimelineRendererRegistry | undefined;
  } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
  let groups = $derived(groupTimeline(buildTimeline([...$snapshot.events])));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<section class="og-timeline" data-og-component="timeline" data-og-state={$snapshot.initialLoading ? "loading" : $snapshot.connectionState} aria-label={label} aria-busy={$snapshot.initialLoading} tabindex="0">
  <HistoryControls
    hasOlder={$snapshot.hasOlder}
    hasNewer={$snapshot.hasNewer}
    loadingOlder={$snapshot.loadingOlder}
    loadingNewer={$snapshot.loadingNewer}
    loadingLatest={$snapshot.loadingLatest}
    onOlder={controller.loadOlder}
    onNewer={controller.loadNewer}
    onOldest={controller.loadOldest}
    onLatest={controller.jumpToLatest}
  />
  <div class="og-timeline__content" data-og-part="content" aria-live="polite">
    {#if $snapshot.initialLoading}
      <div class="og-empty">Loading session activity…</div>
    {:else if groups.length === 0}
      <div class="og-timeline__empty">No session activity yet.</div>
    {:else}
      {#each groups as group (group.kind === "item" ? group.item.id : group.id)}
        <TimelineGroup {group} {renderers} />
      {/each}
    {/if}
    {#if $snapshot.error}<div class="og-error" role="alert">{$snapshot.error.message}</div>{/if}
  </div>
</section>