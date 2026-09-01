<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";
  import { getComposerContext } from "../composer-context";
  import { canSubmitSessionComposer, submitSessionComposer } from "../composer-submit";
  import { readableFromController } from "../store";
  const { controller, attachments } = getComposerContext();
  let {
    class: className = "",
    label = "Send message",
    children,
    onclick,
    disabled = false,
    ...rest
  }: Omit<HTMLButtonAttributes, "children"> & { label?: string; children?: Snippet } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
  let attachmentSnapshot = $derived(attachments ? readableFromController(attachments, { owned: false }) : null);
  let canSubmit = $derived(canSubmitSessionComposer($snapshot, attachmentSnapshot ? ($attachmentSnapshot ?? null) : null));

  function submit(event: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) {
    onclick?.(event);
    if (!event.defaultPrevented) void submitSessionComposer(controller, attachments, "send");
  }
</script>

<button {...rest} class={`og-composer__send ${className}`.trim()} type="button" disabled={disabled || !canSubmit} onclick={submit} aria-label={label}>
  {#if children}{@render children()}{:else}<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 7-7 7 7"/><path d="m 12 19V5"/></svg><span class="og-visually-hidden">{label}</span>{/if}
</button>
