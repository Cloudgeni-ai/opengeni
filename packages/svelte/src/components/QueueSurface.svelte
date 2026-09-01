<script lang="ts">
  import type { SessionComposerRuntimeStore, TurnQueueStore } from "@opengeni/sdk/session";
  import { projectOptimisticQueuedMessages } from "../optimistic-messages";
  import { readableFromController } from "../store";

  let { controller, composer, onEdit }: { controller: TurnQueueStore; composer?: SessionComposerRuntimeStore | undefined; onEdit?: ((turnId: string) => void | Promise<void>) | undefined } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
  let composerSnapshot = $derived(composer ? readableFromController(composer, { owned: false }) : null);
  let optimistic = $derived(projectOptimisticQueuedMessages(composerSnapshot ? ($composerSnapshot?.optimisticMessages ?? []) : [], $snapshot));
  let count = $derived($snapshot.queue.length + optimistic.length);
</script>

<section class="og-queue" data-og-component="queue" data-og-state={$snapshot.loading ? "loading" : count ? "ready" : "empty"}>
  <header class="og-queue__header"><strong>Queue</strong><span>{count}</span></header>
  {#if count === 0}
    <div class="og-empty">No queued prompts.</div>
  {:else}
    <ol class="og-queue__list">
      {#each $snapshot.queue as turn, index (turn.id)}
        <li class="og-queue-item" data-og-component="queue-item" data-og-state={controller.mutationFor(turn.id) ? "loading" : "ready"}>
          <span aria-label={`Queue position ${index + 1}`}>{index + 1}</span>
          <div class="og-queue-item__content">{turn.prompt}</div>
          <div class="og-queue-item__actions">
            <button class="og-button" type="button" disabled={index === 0} onclick={() => void controller.moveTurn(turn.id, $snapshot.queue[index - 1]?.id ?? null)}>Up</button>
            {#if onEdit}<button class="og-button" type="button" onclick={() => void onEdit(turn.id)}>Edit</button>{/if}
            <button class="og-button" type="button" onclick={() => void controller.steerTurn(turn.id)}>Steer</button>
            <button class="og-button" data-og-variant="danger" type="button" onclick={() => void controller.removeTurn(turn.id)}>Remove</button>
          </div>
        </li>
      {/each}
      {#each optimistic as message, index (message.clientEventId)}
        <li class="og-queue-item" data-og-component="queue-item" data-og-state={message.state} data-og-optimistic={message.clientEventId} aria-live="polite">
          <span aria-label={`Queue position ${$snapshot.queue.length + index + 1}`}>{$snapshot.queue.length + index + 1}</span>
          <div class="og-queue-item__content" data-og-part="message-text">{message.text}</div>
          <div class="og-queue-item__actions">
            <span class="og-visually-hidden">{message.state === "failed" ? "Not confirmed" : message.state === "sending" ? "Placing in queue" : "Queued"}</span>
            {#if message.state === "failed" && composer}
              <button class="og-button" type="button" onclick={() => composer?.retryOptimisticMessage(message.clientEventId)}>Retry</button>
              <button class="og-button" type="button" aria-label="Dismiss unconfirmed queued prompt" onclick={() => composer?.removeOptimisticMessage(message.clientEventId)}>Remove</button>
            {/if}
          </div>
        </li>
      {/each}
    </ol>
  {/if}
  {#if $snapshot.mutationError}<div class="og-error" role="alert">{$snapshot.mutationError.message}</div>{/if}
</section>