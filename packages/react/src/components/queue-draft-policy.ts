import type { ComposerState } from "../hooks/use-composer";
import type { SessionTurn } from "@opengeni/sdk";
import type { UseTurnQueueResult } from "../hooks/use-turn-queue";

/** Creation order, not execution position: reordering must not change recall. */
export function latestEditableQueuedTurn(turns: readonly SessionTurn[]): SessionTurn | undefined {
  return turns.reduce<SessionTurn | undefined>((latest, turn) => {
    if (
      turn.status !== "queued" ||
      (turn.source !== "user" && turn.source !== "api") ||
      turn.personalResources?.mode === "once"
    )
      return latest;
    return !latest || turn.createdAt >= latest.createdAt ? turn : latest;
  }, undefined);
}

/** Shared atomic checkout for the queue menu and composer keyboard shortcut. */
export async function checkoutQueueDraft(
  composer: ComposerState,
  queue: UseTurnQueueResult,
  turnId: string,
  replaceDraft: boolean,
): Promise<boolean> {
  if (composer.draftPersistence === "disabled") return false;
  const applyCheckout = composer.prepareDraftCheckout?.() ?? composer.applyDraft;
  const restored = await queue.editTurn(turnId, {
    expectedDraftRevision: composer.draftRevision,
    replaceDraft,
  });
  if (!restored) return false;
  applyCheckout(restored);
  return true;
}

/**
 * Decide whether checking out a queued prompt would replace current composer
 * content. `hasDraftContent` reads the synchronous draft refs, so this stays
 * correct even when a controlled input update has not rendered yet.
 */
export function requestQueueDraftEdit(
  composer: Pick<ComposerState, "hasDraftContent">,
  confirmReplacement: () => void,
  editImmediately: () => void,
): void {
  if (composer.hasDraftContent()) {
    confirmReplacement();
  } else {
    editImmediately();
  }
}
