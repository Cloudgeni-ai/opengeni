<script lang="ts">
  import type { FileAttachmentStore, SessionComposerRuntimeStore } from "@opengeni/sdk/session";
  import type { Snippet } from "svelte";
  import { setComposerContext } from "../composer-context";
  import { readableFromController } from "../store";

  let {
    controller,
    attachments,
    children,
    class: className = "",
  }: {
    controller: SessionComposerRuntimeStore;
    attachments?: FileAttachmentStore | undefined;
    children?: Snippet;
    class?: string;
  } = $props();
  setComposerContext({
    get controller() { return controller; },
    get attachments() { return attachments; },
  });
  let snapshot = $derived.by(() => readableFromController(controller, { owned: false }));
</script>

<section class={`og-root og-composer ${className}`.trim()} data-og-component="composer" data-og-state={$snapshot.submitting ? "submitting" : $snapshot.loading ? "loading" : "ready"} role="group" aria-label="Message composer">
  {@render children?.()}
  {#if $snapshot.mutationError}<div class="og-composer__error" data-og-part="error" role="alert">{$snapshot.mutationError.message}</div>{/if}
</section>
