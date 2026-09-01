<script lang="ts">
  import { onMount } from "svelte";
  import type { HTMLTextareaAttributes } from "svelte/elements";
  import { getComposerContext } from "../composer-context";
  import { submitSessionComposer } from "../composer-submit";
  import { readableFromController } from "../store";

  type Props = Omit<HTMLTextareaAttributes, "value" | "children"> & { autoFocus?: boolean };
  let {
    placeholder = "Message OpenGeni…",
    autoFocus = false,
    class: className = "",
    "aria-label": ariaLabel = "Message the agent",
    rows = 1,
    oninput,
    onkeydown,
    ...rest
  }: Props = $props();
  const { controller, attachments } = getComposerContext();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
  let textarea = $state<HTMLTextAreaElement>();

  onMount(() => {
    if (autoFocus) requestAnimationFrame(() => textarea?.focus());
  });

  function onKeydown(
    event: KeyboardEvent & { currentTarget: EventTarget & HTMLTextAreaElement },
  ) {
    onkeydown?.(event);
    if (event.defaultPrevented || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void submitSessionComposer(controller, attachments, event.metaKey || event.ctrlKey ? "steer" : "send");
  }

  function onInput(event: Event & { currentTarget: HTMLTextAreaElement }) {
    controller.setText(event.currentTarget.value);
    oninput?.(event);
  }
</script>

<textarea {...rest} bind:this={textarea} class={`og-composer__input og-composer-input ${className}`.trim()} data-og-part="input" value={$snapshot.text} {placeholder} aria-label={ariaLabel} {rows} oninput={onInput} onkeydown={onKeydown}></textarea>
