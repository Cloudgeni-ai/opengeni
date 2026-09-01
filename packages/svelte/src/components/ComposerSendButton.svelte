<script lang="ts">
  import { getComposerContext } from "../composer-context";
  import { canSubmitSessionComposer, submitSessionComposer } from "../composer-submit";
  import { readableFromController } from "../store";
  const { controller, attachments } = getComposerContext();
  let snapshot = $derived(readableFromController(controller, { owned: false }));
  let attachmentSnapshot = $derived(attachments ? readableFromController(attachments, { owned: false }) : null);
  let canSubmit = $derived(canSubmitSessionComposer($snapshot, attachmentSnapshot ? ($attachmentSnapshot ?? null) : null));
</script>

<button class="og-composer__send" type="button" disabled={!canSubmit} onclick={() => void submitSessionComposer(controller, attachments, "send")} aria-label="Send message">
  <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg><span class="og-visually-hidden">Send message</span>
</button>
