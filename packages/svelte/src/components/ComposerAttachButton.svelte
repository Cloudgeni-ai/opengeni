<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { getComposerContext } from "../composer-context";
  const { attachments } = getComposerContext();
  let {
    class: className = "",
    label = "Attach files",
    children,
    onclick,
    ...rest
  }: Omit<HTMLButtonAttributes, "children"> & { label?: string; children?: Snippet } = $props();
  let fileInput = $state<HTMLInputElement>();

  function selectFiles(event: Event & { currentTarget: HTMLInputElement }) {
    if (event.currentTarget.files) attachments?.addFiles(event.currentTarget.files);
    event.currentTarget.value = "";
  }

  function openPicker(event: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) {
    onclick?.(event);
    if (!event.defaultPrevented) fileInput?.click();
  }
</script>

{#if attachments}
  <input class="og-visually-hidden" bind:this={fileInput} type="file" multiple aria-label={label} onchange={selectFiles} />
  <button {...rest} class={`og-composer__attach ${className}`.trim()} type="button" aria-label={label} onclick={openPicker}>
    {#if children}{@render children()}{:else}<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" /></svg>{/if}
  </button>
{/if}
