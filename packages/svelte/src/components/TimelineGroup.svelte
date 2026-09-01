<script lang="ts">
  import type { TimelineGroup as TimelineGroupModel } from "@opengeni/sdk/session";
  import type { AuthReconnectHandler, TimelineRendererRegistry } from "../renderers";
  import Fold from "./Fold.svelte";
  // oxlint-disable-next-line import/no-self-import -- recursive timeline groups are the component's canonical Svelte rendering boundary.
  import TimelineGroupSurface from "./TimelineGroup.svelte";
  import TimelineRow from "./TimelineRow.svelte";

  let {
    group,
    renderers,
    onReconnect,
  }: {
    group: TimelineGroupModel;
    renderers?: TimelineRendererRegistry | undefined;
    onReconnect?: AuthReconnectHandler | undefined;
  } = $props();
</script>

{#if group.kind === "item"}
  <TimelineRow item={group.item} {renderers} {onReconnect} />
{:else if group.kind === "activity"}
  <div class="og-timeline-activity">
    <Fold label={`${group.items.length} step${group.items.length === 1 ? "" : "s"}`} open={true}>
      <section class="og-timeline-group" data-og-kind="activity" data-og-outcome={group.outcome}>
        {#each group.items as item (item.id)}<TimelineRow {item} {renderers} {onReconnect} />{/each}
        {#if group.failureText}<div class="og-error" role="alert">{group.failureText}</div>{/if}
      </section>
    </Fold>
  </div>
{:else}
  <Fold label={`Turn · ${group.outcome}`} open={false}>
    <div class="og-timeline-group" data-og-kind="turn" data-og-outcome={group.outcome}>
      {#each group.groups as nested (nested.kind === "item" ? nested.item.id : nested.id)}
        <TimelineGroupSurface group={nested} {renderers} {onReconnect} />
      {/each}
      {#if group.failureText}<div class="og-error" role="alert">{group.failureText}</div>{/if}
    </div>
  </Fold>
{/if}
