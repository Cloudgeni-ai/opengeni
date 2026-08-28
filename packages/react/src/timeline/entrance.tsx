import { createContext, useContext, useRef, type ReactNode } from "react";

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
const EntranceAnimationLiveContext = createContext(true);

/**
 * Freeze the mount-time gate for this subtree while publishing a separate live
 * gate to activity rails that need later appends to animate after a bulk paint.
 * MessageTimeline mounts one provider per durable group, so existing groups do
 * not receive a context invalidation when a prepend toggles bulk mode and new
 * groups still capture the value from the commit that created them.
 */
export function EntranceAnimationProvider({
  value,
  liveValue = value,
  children,
}: {
  value: boolean;
  liveValue?: boolean | undefined;
  children: ReactNode;
}) {
  const mountedValue = useRef(value).current;
  return (
    <EntranceAnimationContext.Provider value={mountedValue}>
      <EntranceAnimationLiveContext.Provider value={liveValue}>
        {children}
      </EntranceAnimationLiveContext.Provider>
    </EntranceAnimationContext.Provider>
  );
}

/**
 * Live entrance gate from the nearest provider. Prefer
 * {@link useEntranceAnimation} for elements that must freeze the decision at
 * mount; use this when a stable parent (e.g. ActivityRail) needs to animate
 * later appends after a bulk window clears.
 */
export function useEntranceAnimationLive(): boolean {
  return useContext(EntranceAnimationLiveContext);
}

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
