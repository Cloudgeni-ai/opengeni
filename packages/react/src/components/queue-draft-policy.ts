import type { ComposerState } from "../hooks/use-composer";

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
