import { type RefObject, useEffect, useState } from "react";

/** Where a floating timeline pill sits along its edge of the conversation. */
export type TimelinePillPlacement = "start" | "center" | "end";
export type TimelinePillPosition = { placement: TimelinePillPlacement; offsetY: number };

const RECHECK_MS = 1000;

/**
 * Floating pills (Jump to latest, Back to your message) sit over the scrolling
 * conversation. Prefer sliding one sideways when its spot would cover
 * a control: a link, a button, or the label and chevron of a full-width row
 * such as the active turn's "Working" header. Plain prose may sit under a pill;
 * controls may not. The top contextual pill can also move below a toolbar when
 * no horizontal slot fits. Only the pill moves — the scroller's size, padding, and
 * scroll position never change — so timeline anchoring stays untouched.
 */
export function useTimelinePillPlacement({
  pillRef,
  scrollerRef,
  active,
  preference,
  allowDownwardFallback = false,
}: {
  pillRef: RefObject<HTMLElement | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  active: boolean;
  /** Placements in order of preference; the first is the resting position. */
  preference: readonly TimelinePillPlacement[];
  allowDownwardFallback?: boolean;
}): TimelinePillPosition {
  const [position, setPosition] = useState<TimelinePillPosition>({
    placement: preference[0]!,
    offsetY: 0,
  });
  const key = preference.join(",");

  useEffect(() => {
    if (!active) {
      setPosition({ placement: preference[0]!, offsetY: 0 });
      return;
    }
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let frame = 0;
    let current: TimelinePillPosition = { placement: preference[0]!, offsetY: 0 };
    let geometry: typeof import("./timeline-pill-geometry") | null = null;
    let disposed = false;
    void import("./timeline-pill-geometry").then((loaded) => {
      if (disposed) return;
      geometry = loaded;
      schedule();
    });
    const evaluate = () => {
      frame = 0;
      const pill = pillRef.current;
      const frameElement = pill?.offsetParent;
      if (!geometry || !pill || !(frameElement instanceof HTMLElement)) return;
      const next = allowDownwardFallback
        ? geometry.chooseQuestionPosition(pill, frameElement, scroller, preference, current)
        : {
            placement: geometry.choosePlacement(
              pill,
              frameElement,
              scroller,
              preference,
              current.placement,
            ),
            offsetY: 0,
          };
      if (next.placement !== current.placement || next.offsetY !== current.offsetY) {
        current = next;
        setPosition(next);
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(evaluate);
    };
    schedule();
    const view = scroller.ownerDocument.defaultView;
    scroller.addEventListener("scroll", schedule, { passive: true });
    view?.addEventListener("resize", schedule);
    // Content and panel width can change under a stationary reader (a streaming
    // row, a ticking elapsed time, a resized host panel), so look again now and
    // then while the pill is shown.
    const timer = setInterval(schedule, RECHECK_MS);
    return () => {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      view?.removeEventListener("resize", schedule);
      clearInterval(timer);
    };
    // `key` stands in for the preference array's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, pillRef, scrollerRef, allowDownwardFallback]);

  return active ? position : { placement: preference[0]!, offsetY: 0 };
}
