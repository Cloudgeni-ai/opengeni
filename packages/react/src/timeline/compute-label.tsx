import { createContext, useContext } from "react";

/* ----------------------------------------------------------------------------
   Session compute label

   Optional host-supplied display name for the session's active compute target
   (e.g. "Cloud sandbox" or a Connected Machine name). Used by exec_command
   collapsed previews. The host owns resolution; this package never calls the
   machines API.
   -------------------------------------------------------------------------- */

const TimelineComputeLabelContext = createContext<string | null>(null);

export const TimelineComputeLabelProvider = TimelineComputeLabelContext.Provider;

export function useTimelineComputeLabel(): string | null {
  return useContext(TimelineComputeLabelContext);
}
