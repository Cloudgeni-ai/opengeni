import type { TimelineGroup } from "@opengeni/react/session";

/**
 * Live progress notes. While a turn runs, each progress note reads above its
 * work row and is also listed inside it (the projection's `liveNoteIds`).
 * While that work row is open, the copies above fold away, so every note
 * shows once (the web timeline's liveNoteFolds).
 */
export interface LiveNotes {
  /** Each live work row's progress note ids. */
  byWork: ReadonlyMap<string, readonly string[]>;
  /** Every live progress note id. */
  notes: ReadonlySet<string>;
}

export function collectLiveNotes(groups: readonly TimelineGroup[]): LiveNotes {
  const byWork = new Map<string, readonly string[]>();
  const notes = new Set<string>();
  for (const group of groups) {
    if (group.kind !== "activity" || !group.work?.liveNoteIds?.length) continue;
    byWork.set(group.id, group.work.liveNoteIds);
    for (const id of group.work.liveNoteIds) notes.add(id);
  }
  return { byWork, notes };
}

/** The note rows to fold: those whose work row is open. */
export function foldedLiveNotes(
  liveNotes: LiveNotes,
  openWork: ReadonlySet<string>,
): ReadonlySet<string> {
  const folded = new Set<string>();
  for (const [workId, ids] of liveNotes.byWork) {
    if (!openWork.has(workId)) continue;
    for (const id of ids) folded.add(id);
  }
  return folded;
}

/**
 * The scroll correction for folding (open) or restoring (closed) a work row's
 * notes, which sit above it: each measured note row plus the gap after it.
 * Moving the offset by this keeps the toggled row where the reader saw it.
 */
export function liveFoldShift(
  liveNotes: LiveNotes,
  workId: string,
  open: boolean,
  heights: ReadonlyMap<string, number>,
  rowGap: number,
): number {
  const height = (liveNotes.byWork.get(workId) ?? []).reduce((total, id) => {
    const row = heights.get(id);
    return row === undefined ? total : total + row + rowGap;
  }, 0);
  return height === 0 ? 0 : open ? -height : height;
}
