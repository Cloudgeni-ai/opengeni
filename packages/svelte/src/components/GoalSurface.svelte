<script lang="ts">
  import type { GoalStore } from "@opengeni/sdk/session";
  import { readableFromController } from "../store";
  let { controller }: { controller: GoalStore } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
</script>

{#if $snapshot.value}
  <section class="og-goal" data-og-component="goal" data-og-state={$snapshot.value.status === "active" ? "ready" : $snapshot.value.status}>
    <header class="og-goal__header"><strong>Goal</strong><span>{$snapshot.value.status}</span></header>
    <div>{$snapshot.value.text}</div>
    {#if $snapshot.value.successCriteria}<small>{$snapshot.value.successCriteria}</small>{/if}
    <div class="og-goal__actions">
      {#if $snapshot.isPaused}<button class="og-button" type="button" disabled={$snapshot.updating} onclick={() => void controller.resume()}>Resume goal</button>{/if}
      {#if $snapshot.isActive}<button class="og-button" type="button" disabled={$snapshot.updating} onclick={() => void controller.pause("Paused from the embedded session UI")}>Pause goal</button>{/if}
      <button class="og-button" data-og-variant="danger" type="button" disabled={$snapshot.updating} onclick={() => void controller.clearGoal()}>Clear goal</button>
    </div>
    {#if $snapshot.mutationError}<div class="og-error" role="alert">{$snapshot.mutationError.message}</div>{/if}
  </section>
{/if}