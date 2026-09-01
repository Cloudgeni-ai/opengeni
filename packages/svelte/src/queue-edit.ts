import type { SessionComposerRuntimeStore, TurnQueueStore } from "@opengeni/sdk/session";

export async function editQueuedTurnIntoComposer(options: {
  queue: TurnQueueStore;
  composer: SessionComposerRuntimeStore;
  turnId: string;
  confirmReplace: () => boolean | Promise<boolean>;
}): Promise<boolean> {
  const replaceDraft = options.composer.hasDraftContent();
  if (replaceDraft && !(await options.confirmReplace())) return false;
  const restored = await options.queue.editTurn(options.turnId, {
    expectedDraftRevision: options.composer.getSnapshot().draftRevision,
    replaceDraft,
  });
  if (!restored) return false;
  options.composer.applyDraft(restored);
  return true;
}
