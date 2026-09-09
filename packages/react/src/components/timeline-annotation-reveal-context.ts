import { createContext, useContext, type RefObject } from "react";

/** Owning timeline scroller for quote-source navigation. */
export const TimelineAnnotationSourceRootContext =
  createContext<RefObject<HTMLElement | null> | null>(null);

export function useTimelineAnnotationSourceRoot(): RefObject<HTMLElement | null> | null {
  return useContext(TimelineAnnotationSourceRootContext);
}
