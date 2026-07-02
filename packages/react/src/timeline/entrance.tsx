import { createContext, useContext, useRef } from "react";

/* ----------------------------------------------------------------------------
   Entrance animation gating

   Bulk paints (the initial tail window, a prepended older window) must not run
   per-row entrance animations — hundreds of rows fading in at once reads as a
   full-timeline flash. Toggling `animation: none` on and off is NOT an option:
   removing the override restarts every animation, which is itself the flash.

   Instead each animated element decides ONCE, at its own mount, whether it was
   born in a bulk paint — and keeps that decision forever. Rows born in a bulk
   paint never animate; rows appended live animate exactly as before. Nothing
   is ever toggled on existing DOM, so nothing can replay.
   -------------------------------------------------------------------------- */

const EntranceAnimationContext = createContext(true);

export const EntranceAnimationProvider = EntranceAnimationContext.Provider;

/**
 * Whether this element should wear the entrance animation. Captured at mount
 * from the nearest provider (true outside any provider) and stable for the
 * element's lifetime — see the module doctrine above.
 */
export function useEntranceAnimation(): boolean {
  const enabled = useContext(EntranceAnimationContext);
  const captured = useRef(enabled);
  return captured.current;
}
