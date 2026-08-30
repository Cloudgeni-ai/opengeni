<script lang="ts">
  import type { FileAttachmentStore } from "@opengeni/sdk/session";
  import { readableFromController } from "../store";

  let { controller }: { controller: FileAttachmentStore } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
</script>

{#if $snapshot.attachments.length > 0}
  <div class="og-attachments" data-og-component="attachments" aria-label="Attachments">
    {#each $snapshot.attachments as attachment (attachment.id)}
      <article class="og-attachment" data-og-component="attachment" data-og-state={attachment.status}>
        {#if attachment.previewUrl}
          <img class="og-attachment__preview" src={attachment.previewUrl} alt="" />
        {:else}
          <span class="og-attachment__preview" aria-hidden="true">↥</span>
        {/if}
        <div class="og-attachment__label">
          <div>{attachment.name}</div>
          <small>{attachment.status}{attachment.error ? ` · ${attachment.error}` : ""}</small>
        </div>
        <div class="og-toolbar">
          {#if attachment.status === "failed"}
            <button class="og-button" type="button" onclick={() => controller.retry(attachment.id)}>Retry</button>
          {/if}
          <button class="og-icon-button" type="button" aria-label={`Remove ${attachment.name}`} onclick={() => controller.remove(attachment.id)}>×</button>
        </div>
      </article>
    {/each}
  </div>
{/if}