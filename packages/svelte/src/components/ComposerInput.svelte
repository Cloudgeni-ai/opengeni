<script lang="ts">
  import { onMount } from "svelte";
  import { getComposerContext } from "../composer-context";
  import { submitSessionComposer } from "../composer-submit";
  import { readableFromController } from "../store";

  let { placeholder = "Message OpenGeni…", autoFocus = false }: { placeholder?: string; autoFocus?: boolean } = $props();
  const { controller, attachments } = getComposerContext();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
  let textarea = $state<HTMLTextAreaElement>();

  onMount(() => {
    if (autoFocus) requestAnimationFrame(() => textarea?.focus());
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void submitSessionComposer(controller, attachments, event.metaKey || event.ctrlKey ? "steer" : "send");
  }
</script>

<textarea bind:this={textarea} class="og-composer__input og-composer-input" data-og-part="input" value={$snapshot.text} {placeholder} aria-label="Message the agent" rows="1" oninput={(event) => controller.setText(event.currentTarget.value)} onkeydown={onKeydown}></textarea>
