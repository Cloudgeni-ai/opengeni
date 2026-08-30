<script lang="ts">
  import type { TimelineGroup as TimelineGroupModel } from "@opengeni/sdk/session";
  import type { TimelineRendererRegistry } from "../renderers";
  import Fold from "./Fold.svelte";
  // oxlint-disable-next-line import/no-self-import -- recursive timeline groups are the component's canonical Svelte rendering boundary.
  import TimelineGroupSurface from "./TimelineGroup.svelte";
  import TimelineRow from "./TimelineRow.svelte";

  let {
    group,
    renderers,
  }: {
    group: TimelineGroupModel;
    renderers?: TimelineRendererRegistry | undefined;
  } = $props();
</script>

{#if group.kind === "item"}
  <TimelineRow item={group.item} {renderers} />
{:else if group.kind === "activity"}
  <section class="og-timeline-group" data-og-component="fold" data-og-kind="activity" data-og-outcome={group.outcome}>
    {#each group.items as item (item.id)}<TimelineRow {item} {renderers} />{/each}
    {#if group.failureText}<div class="og-error" role="alert">{group.failureText}</div>{/if}
  </section>
{:else}
  <Fold label={`Turn · ${group.outcome}`} open={false}>
    <div class="og-timeline-group" data-og-kind="turn" data-og-outcome={group.outcome}>
      {#each group.groups as nested (nested.kind === "item" ? nested.item.id : nested.id)}
        <TimelineGroupSurface group={nested} {renderers} />
      {/each}
      {#if group.failureText}<div class="og-error" role="alert">{group.failureText}</div>{/if}
    </div>
  </Fold>
{/if}