<script lang="ts">
  import type { FileAttachmentStore, SessionComposerRuntimeStore } from "@opengeni/sdk/session";
  import type { LatencyMode, ReasoningEffort } from "@opengeni/sdk";
  import { readableFromController } from "../store";
  import AttachmentList from "./AttachmentList.svelte";
  import ComposerActions from "./ComposerActions.svelte";
  import ComposerAttachButton from "./ComposerAttachButton.svelte";
  import ComposerControls from "./ComposerControls.svelte";
  import ComposerFooter from "./ComposerFooter.svelte";
  import ComposerInput from "./ComposerInput.svelte";
  import ComposerRoot from "./ComposerRoot.svelte";
  import ComposerSendButton from "./ComposerSendButton.svelte";
  import ComposerSurface from "./ComposerSurface.svelte";
  import ModelPicker from "./ModelPicker.svelte";
  import ReasoningPicker from "./ReasoningPicker.svelte";
  import LatencyPicker from "./LatencyPicker.svelte";
  import ToolPolicyPicker from "./ToolPolicyPicker.svelte";
  import type { ToolPolicyOption } from "../picker-types";

  let {
    controller,
    attachments,
    models = [],
    placeholder = "Message OpenGeni…",
    autoFocus = true,
    reasoningOptions,
    latencyOptions,
    tools = [],
    selectedTools = [],
    onToolsChange,
  }: {
    controller: SessionComposerRuntimeStore;
    attachments?: FileAttachmentStore | undefined;
    models?: readonly string[];
    placeholder?: string;
    autoFocus?: boolean;
    reasoningOptions?: readonly ReasoningEffort[];
    latencyOptions?: readonly LatencyMode[];
    tools?: readonly ToolPolicyOption[];
    selectedTools?: readonly string[];
    onToolsChange?: ((ids: string[]) => unknown) | undefined;
  } = $props();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
</script>

<ComposerRoot {controller} {attachments}>
  <ComposerSurface>
      {#if attachments}<AttachmentList controller={attachments} />{/if}
      <ComposerInput {placeholder} {autoFocus} />
      <ComposerFooter>
        <ComposerControls>
          <ComposerAttachButton />
          {#if models.length > 0}
            <ModelPicker
              value={$snapshot.model}
              options={models.map((model) => ({ id: model, label: model }))}
              onChange={(model) => controller.setModel(model)}
            />
          {/if}
          {#if tools.length > 0}
            <ToolPolicyPicker {tools} selected={selectedTools} disabled={$snapshot.submitting || !onToolsChange} onChange={onToolsChange} />
          {/if}
          {#if reasoningOptions}
            <ReasoningPicker value={$snapshot.reasoningEffort} options={reasoningOptions} disabled={$snapshot.submitting} onChange={(effort) => controller.setReasoningEffort(effort)} />
          {:else}
            <ReasoningPicker value={$snapshot.reasoningEffort} disabled={$snapshot.submitting} onChange={(effort) => controller.setReasoningEffort(effort)} />
          {/if}
          {#if latencyOptions}
            <LatencyPicker value={$snapshot.latencyMode} options={latencyOptions} disabled={$snapshot.submitting} onChange={(mode) => controller.setLatencyMode(mode)} />
          {:else}
            <LatencyPicker value={$snapshot.latencyMode} disabled={$snapshot.submitting} onChange={(mode) => controller.setLatencyMode(mode)} />
          {/if}
        </ComposerControls>
        <ComposerActions><ComposerSendButton /></ComposerActions>
      </ComposerFooter>
  </ComposerSurface>
</ComposerRoot>
