<script lang="ts">
  import type {
    FileAttachmentStore,
    SessionComposerRuntimeStore,
  } from "@opengeni/sdk/session";
  import { canSubmitSessionComposer, submitSessionComposer } from "../composer-submit";
  import { readableFromController } from "../store";
  import AttachmentList from "./AttachmentList.svelte";

  let {
    controller,
    attachments,
    models = [],
    tools = [],
    selectedTools = [],
    onToolsChange,
    placeholder = "Message OpenGeni…",
  }: {
    controller: SessionComposerRuntimeStore;
    attachments?: FileAttachmentStore | undefined;
    models?: readonly string[];
    tools?: readonly { id: string; label: string }[];
    selectedTools?: readonly string[];
    onToolsChange?: ((ids: string[]) => void) | undefined;
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
  function toggleTool(id: string) {
    const next = selectedTools.includes(id)
      ? selectedTools.filter((candidate) => candidate !== id)
      : [...selectedTools, id];
    onToolsChange?.(next);
  }
</script>

<section class="og-composer" data-og-component="composer" data-og-state={$snapshot.submitting ? "submitting" : $snapshot.loading ? "loading" : "ready"}>
  {#if attachments}<AttachmentList controller={attachments} />{/if}
  <textarea
    class="og-composer__input og-composer-input"
    data-og-part="input"
    value={$snapshot.text}
    {placeholder}
    aria-label="Message"
    oninput={(event) => controller.setText(event.currentTarget.value)}
    onkeydown={onKeydown}
  ></textarea>
  <footer class="og-composer__footer og-composer-footer" data-og-part="footer">
    <div class="og-composer__controls og-composer-controls" data-og-part="controls">
      {#if attachments}
        <input class="og-visually-hidden" bind:this={fileInput} type="file" multiple aria-label="Attach files" onchange={(event) => addFiles(event.currentTarget.files)} />
        <button class="og-icon-button" type="button" aria-label="Attach files" onclick={() => fileInput?.click()}>＋</button>
      {/if}
      {#if models.length > 0}
        <select aria-label="Model" value={$snapshot.model} onchange={(event) => controller.setModel(event.currentTarget.value)}>
          {#each models as model}<option value={model}>{model}</option>{/each}
        </select>
      {/if}
      <select aria-label="Reasoning effort" value={$snapshot.reasoningEffort} onchange={(event) => controller.setReasoningEffort(event.currentTarget.value as never)}>
        {#each ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as effort}<option value={effort}>{effort}</option>{/each}
      </select>
      <select aria-label="Latency" value={$snapshot.latencyMode} onchange={(event) => controller.setLatencyMode(event.currentTarget.value as never)}>
        <option value="standard">Standard</option><option value="priority">Priority</option><option value="fast">Fast</option>
      </select>
      {#each tools as tool}
        <label><input type="checkbox" checked={selectedTools.includes(tool.id)} onchange={() => toggleTool(tool.id)} /> {tool.label}</label>
      {/each}
    </div>
    <div class="og-composer__actions og-composer-actions" data-og-part="actions">
      <button class="og-button" data-og-variant="primary" type="button" disabled={!canSubmit} onclick={() => void submit("send")}>
        Send
      </button>
    </div>
  </footer>
  {#if $snapshot.mutationError}<div class="og-composer__error" role="alert">{$snapshot.mutationError.message}</div>{/if}
</section>