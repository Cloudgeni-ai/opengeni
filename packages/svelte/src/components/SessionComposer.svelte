<script lang="ts">
  import type { FileAttachmentStore, SessionComposerRuntimeStore } from "@opengeni/sdk/session";
  import { canSubmitSessionComposer, submitSessionComposer } from "../composer-submit";
  import { readableFromController } from "../store";
  import AttachmentList from "./AttachmentList.svelte";
  import ModelPicker from "./ModelPicker.svelte";

  let {
    controller,
    attachments,
    models = [],
    placeholder = "Message OpenGeni…",
  }: {
    controller: SessionComposerRuntimeStore;
    attachments?: FileAttachmentStore | undefined;
    models?: readonly string[];
    placeholder?: string;
  } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
  let attachmentSnapshot = $derived(attachments ? readableFromController(attachments, { owned: false }) : null);
  let attachmentState = $derived(attachmentSnapshot ? ($attachmentSnapshot ?? null) : null);
  let canSubmit = $derived(canSubmitSessionComposer($snapshot, attachmentState));
  let fileInput = $state<HTMLInputElement>();

  async function submit(delivery: "send" | "steer" = "send") {
    await submitSessionComposer(controller, attachments, delivery);
  }
  function onKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void submit(event.metaKey || event.ctrlKey ? "steer" : "send");
  }
  function addFiles(files: FileList | null) {
    if (files && attachments) attachments.addFiles(files);
  }
</script>

<section class="og-composer" data-og-component="composer" data-og-state={$snapshot.submitting ? "submitting" : $snapshot.loading ? "loading" : "ready"} role="group" aria-label="Message composer">
  {#if attachments}<AttachmentList controller={attachments} />{/if}
  <textarea
    class="og-composer__input og-composer-input"
    data-og-part="input"
    value={$snapshot.text}
    {placeholder}
    aria-label="Message"
    rows="1"
    oninput={(event) => controller.setText(event.currentTarget.value)}
    onkeydown={onKeydown}
  ></textarea>
  <footer class="og-composer__footer og-composer-footer" data-og-part="footer">
    <div class="og-composer__controls og-composer-controls" data-og-part="controls">
      {#if attachments}
        <input class="og-visually-hidden" bind:this={fileInput} type="file" multiple aria-label="Attach files" onchange={(event) => addFiles(event.currentTarget.files)} />
        <button class="og-icon-button" type="button" aria-label="Attach files" onclick={() => fileInput?.click()}>
          <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m7.5 10.5 4.9-4.9a2.1 2.1 0 0 1 3 3l-6.3 6.3a4 4 0 0 1-5.7-5.7l6.2-6.2" /></svg>
        </button>
      {/if}
      {#if models.length > 0}
        <ModelPicker
          value={$snapshot.model}
          options={models.map((model) => ({ id: model, label: model }))}
          onChange={(model) => controller.setModel(model)}
        />
      {/if}
    </div>
    <div class="og-composer__actions og-composer-actions" data-og-part="actions">
      <button class="og-button og-composer__send" data-og-variant="primary" type="button" disabled={!canSubmit} onclick={() => void submit("send")} aria-label="Send">
        <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 10 5-5 5 5M10 5v10" /></svg><span class="og-visually-hidden">Send</span>
      </button>
    </div>
  </footer>
  {#if $snapshot.mutationError}<div class="og-composer__error" role="alert">{$snapshot.mutationError.message}</div>{/if}
</section>
