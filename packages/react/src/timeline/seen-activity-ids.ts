import { createContext, useContext } from "react";

/* ----------------------------------------------------------------------------
   Seen activity ids

   ActivityRails remount across fold wraps / settle key flips. A per-rail
   previousIds set resets on remount, so either every row re-fades (flash) or
   the first live tool never animates (pop). This map lives on MessageTimeline
   and records every activity id that has already painted — live appends of
   unknown ids earn row-enter; remounts of known ids stay quiet.
   -------------------------------------------------------------------------- */

const SeenActivityIdsContext = createContext<Set<string> | null>(null);

export const SeenActivityIdsProvider = SeenActivityIdsContext.Provider;

export function useSeenActivityIds(): Set<string> | null {
  return useContext(SeenActivityIdsContext);
}
