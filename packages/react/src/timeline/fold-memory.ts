import { createContext, useContext } from "react";

/* ----------------------------------------------------------------------------
   Fold memory

   Remembers, per durable timeline group id, that a fold reached a RESTING
   state: "closed" when the settle choreography finished its collapse or the
   reader closed the chip by hand, "open" when the reader explicitly expanded
   it. The map lives OUTSIDE the component tree because the timeline
   deliberately remounts chips with fresh keys (the activity→turn wrap, the
   nested-chip key flip around settle chrome) — and a remount must never
   forget that the reader already watched this cluster fold. Re-opening an
   already-settled fold reads as the timeline undoing its own choreography.

   With no provider the hook returns null and every fold keeps its
   author-chosen default — standalone TurnSummary usage is unchanged.
   -------------------------------------------------------------------------- */

export type FoldRestingState = "open" | "closed";

const FoldMemoryContext = createContext<Map<string, FoldRestingState> | null>(null);

/** Provide a per-timeline resting-state map (MessageTimeline owns one). */
export const FoldMemoryProvider = FoldMemoryContext.Provider;

/** The ancestor fold-memory map, or null when none is mounted (inert). */
export function useFoldMemory(): Map<string, FoldRestingState> | null {
  return useContext(FoldMemoryContext);
}

/**
 * Single-cluster activity→turn wrap: copy the activity resting state onto the
 * new turn-* key. Those ids differ across the wrap; without this the turn
 * remounts settleFold and re-opens a chip the reader already watched collapse.
 *
 * Multi-cluster wraps deliberately do NOT inherit — the outer turn chip is new
 * and still takes one settle beat; nested clusters keep their own activity-*
 * memory so they stay closed under that beat.
 */
export function inheritFoldRestingState(
  memory: Map<string, FoldRestingState>,
  targetKey: string,
  sourceKeys: readonly string[],
): void {
  if (memory.has(targetKey) || sourceKeys.length !== 1) {
    return;
  }
  const state = memory.get(sourceKeys[0]!);
  if (state !== undefined) {
    memory.set(targetKey, state);
  }
}
