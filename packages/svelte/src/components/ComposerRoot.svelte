<script lang="ts">
  import type { FileAttachmentStore, SessionComposerRuntimeStore } from "@opengeni/sdk/session";
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { setComposerContext } from "../composer-context";
  import { readableFromController } from "../store";

  let {
    controller,
    attachments,
    children,
    class: className = "",
    "aria-label": ariaLabel = "Message composer",
    ondragover,
    ondragleave,
    ondrop,
    onpaste,
    ...rest
  }: Omit<HTMLAttributes<HTMLElement>, "children"> & {
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
  let dragging = $state(false);

  type SectionDragEvent = DragEvent & { currentTarget: EventTarget & HTMLElement };
  type SectionClipboardEvent = ClipboardEvent & { currentTarget: EventTarget & HTMLElement };

  function dragOver(event: SectionDragEvent) {
    ondragover?.(event);
    if (event.defaultPrevented || !attachments || !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dragging = true;
  }

  function dragLeave(event: SectionDragEvent) {
    ondragleave?.(event);
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) dragging = false;
  }

  function drop(event: SectionDragEvent) {
    ondrop?.(event);
    dragging = false;
    if (event.defaultPrevented || !attachments || !event.dataTransfer?.files.length) return;
    event.preventDefault();
    attachments.addFiles(event.dataTransfer.files);
  }

  function paste(event: SectionClipboardEvent) {
    onpaste?.(event);
    if (event.defaultPrevented || !attachments || !event.clipboardData) return;
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    attachments.addFiles(images);
  }
</script>

<section {...rest} class={`og-root og-composer ${className}`.trim()} data-og-component="composer" data-og-state={$snapshot.submitting ? "submitting" : $snapshot.loading ? "loading" : dragging ? "dragging" : "ready"} role="group" aria-label={ariaLabel} ondragover={dragOver} ondragleave={dragLeave} ondrop={drop} onpaste={paste}>
  {@render children?.()}
  {#if $snapshot.mutationError}<div class="og-composer__error" data-og-part="error" role="alert">{$snapshot.mutationError.message}</div>{/if}
</section>
