<script lang="ts">
  import type { FileAttachmentStore, SessionComposerRuntimeStore } from "@opengeni/sdk/session";
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

  let {
    controller,
    attachments,
    models = [],
    placeholder = "Message OpenGeni…",
    autoFocus = true,
  }: {
    controller: SessionComposerRuntimeStore;
    attachments?: FileAttachmentStore | undefined;
    models?: readonly string[];
    placeholder?: string;
    autoFocus?: boolean;
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
        </ComposerControls>
        <ComposerActions><ComposerSendButton /></ComposerActions>
      </ComposerFooter>
  </ComposerSurface>
</ComposerRoot>
