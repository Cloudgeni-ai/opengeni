<script lang="ts">
  import type {
    FileAttachmentStore,
    SessionComposerRuntimeStore,
  } from "@opengeni/sdk/session";
  import SessionComposer from "./SessionComposer.svelte";

  let props: {
    controller: SessionComposerRuntimeStore;
    attachments?: FileAttachmentStore;
    models?: readonly string[];
    tools?: readonly { id: string; label: string }[];
    selectedTools?: readonly string[];
    onToolsChange?: (ids: string[]) => void;
    placeholder?: string;
  } = $props();
</script>

<SessionComposer {...props} />