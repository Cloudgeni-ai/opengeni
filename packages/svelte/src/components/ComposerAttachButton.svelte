<script lang="ts">
  import { getComposerContext } from "../composer-context";
  const { attachments } = getComposerContext();
  let fileInput = $state<HTMLInputElement>();
</script>

{#if attachments}
  <input class="og-visually-hidden" bind:this={fileInput} type="file" multiple aria-label="Attach files" onchange={(event) => event.currentTarget.files && attachments.addFiles(event.currentTarget.files)} />
  <button class="og-composer__attach" type="button" aria-label="Attach files" onclick={() => fileInput?.click()}>
    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" /></svg>
  </button>
{/if}
