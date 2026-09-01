<script lang="ts">
  import {
    buildTimeline,
    groupTimeline,
    type SessionComposerRuntimeStore,
    type SessionEventStore,
  } from "@opengeni/sdk/session";
  import { projectOptimisticChatMessages } from "../optimistic-messages";
  import type { TimelineRendererRegistry } from "../renderers";
  import { readableFromController } from "../store";
  import HistoryControls from "./HistoryControls.svelte";
  import TimelineGroup from "./TimelineGroup.svelte";

  let {
    controller,
    composer,
    label = "Session timeline",
    renderers,
  }: {
    controller: SessionEventStore;
    composer?: SessionComposerRuntimeStore | undefined;
    label?: string;
    renderers?: TimelineRendererRegistry | undefined;
  } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
  let composerSnapshot = $derived(
    composer ? readableFromController(composer, { owned: false }) : null,
  );
  let groups = $derived(
    groupTimeline(
      projectOptimisticChatMessages(
        buildTimeline([...$snapshot.events]),
        composerSnapshot ? ($composerSnapshot?.optimisticMessages ?? []) : [],
        {
          retry: (clientEventId) => composer?.retryOptimisticMessage(clientEventId),
          remove: (clientEventId) => composer?.removeOptimisticMessage(clientEventId),
        },
      ),
    ),
  );
  let timeline = $state<HTMLElement>();
  let followLatest = true;

  $effect(() => {
    groups.length;
    if ($snapshot.viewMode !== "live") return;
    queueMicrotask(() => {
      if (timeline && followLatest) timeline.scrollTop = timeline.scrollHeight;
    });
  });

  function onScroll() {
    if (!timeline) return;
    followLatest = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 48;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<section class="og-root og-timeline" data-og-component="timeline" data-og-state={$snapshot.initialLoading ? "loading" : $snapshot.connectionState} aria-label={label} aria-busy={$snapshot.initialLoading}>
  {#if $snapshot.hasOlder || $snapshot.hasNewer}
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
  {/if}
  <div bind:this={timeline} class="og-timeline__scroller" data-og-part="content" tabindex="-1" onscroll={onScroll}>
  <div class="og-timeline__content" aria-live="polite">
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
  </div>
</section>
