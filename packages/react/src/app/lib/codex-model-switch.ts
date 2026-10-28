import type { Session, SessionEvent, SessionEventType } from "@opengeni/sdk";

import { isCodexProductModel } from "./session-model";

/** Events that say whether a chat's live context is a compaction checkpoint. */
export const CONTEXT_CHECKPOINT_EVENT_TYPES: SessionEventType[] = [
  "session.context.compacted",
  "session.context.cleared",
];

/**
 * Whether the newest context checkpoint among `events` is a compaction
 * (true), a clear (false), or absent (null). In a Codex remote_v2 chat every
 * compaction is Codex's own, which other models cannot read.
 */
export function latestCheckpointIsCompaction(events: readonly SessionEvent[]): boolean | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const type = events[index]!.type;
    if (type === "session.context.compacted") return true;
    if (type === "session.context.cleared") return false;
  }
  return null;
}

/**
 * A chat Codex compacted is about to run on another provider's model, which
 * rebuilds its earlier messages from a fresh summary. Chats without a Codex
 * compaction switch with nothing to rebuild and need no heads-up.
 */
export function needsModelSwitchHeadsUp(input: {
  codexCompactionMode: Session["codexCompactionMode"] | null | undefined;
  codexCompacted: boolean;
  model: string | null | undefined;
}): boolean {
  return (
    input.codexCompactionMode === "remote_v2" &&
    input.codexCompacted &&
    typeof input.model === "string" &&
    input.model.length > 0 &&
    !isCodexProductModel(input.model)
  );
}

export function modelSwitchHeadsUpText(modelLabel: string): string {
  return `Earlier messages will be re-summarized for ${modelLabel}, so it may remember less detail.`;
}
