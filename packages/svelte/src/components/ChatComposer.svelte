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
    placeholder?: string;
    autoFocus?: boolean;
  } = $props();
</script>

<SessionComposer {...props} />
