<script lang="ts">
  import type { TurnQueueStore } from "@opengeni/sdk/session";
  import { readableFromController } from "../store";

  let { controller, onEdit }: { controller: TurnQueueStore; onEdit?: ((turnId: string) => void | Promise<void>) | undefined } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
</script>

<section class="og-queue" data-og-component="queue" data-og-state={$snapshot.loading ? "loading" : $snapshot.queue.length ? "ready" : "empty"}>
  <header class="og-queue__header"><strong>Queue</strong><span>{$snapshot.queue.length}</span></header>
  {#if $snapshot.queue.length === 0}
    <div class="og-empty">No queued prompts.</div>
  {:else}
    <ol class="og-queue__list">
      {#each $snapshot.queue as turn, index (turn.id)}
        <li class="og-queue-item" data-og-component="queue-item" data-og-state={controller.mutationFor(turn.id) ? "loading" : "ready"}>
          <span aria-label={`Queue position ${index + 1}`}>{index + 1}</span>
          <div class="og-queue-item__content">{turn.prompt}</div>
          <div class="og-queue-item__actions">
            <button class="og-button" type="button" disabled={index === 0} onclick={() => void controller.moveTurn(turn.id, $snapshot.queue[index - 1]?.id ?? null)}>Up</button>
            <button class="og-button" type="button" onclick={() => void onEdit?.(turn.id)}>Edit</button>
            <button class="og-button" type="button" onclick={() => void controller.steerTurn(turn.id)}>Steer</button>
            <button class="og-button" data-og-variant="danger" type="button" onclick={() => void controller.removeTurn(turn.id)}>Remove</button>
          </div>
        </li>
      {/each}
    </ol>
  {/if}
  {#if $snapshot.mutationError}<div class="og-error" role="alert">{$snapshot.mutationError.message}</div>{/if}
</section>