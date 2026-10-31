import { useEffect, useState } from "react";

/**
 * A sticky bar stops at its scroll container's padding. A host page that pads
 * its scroller (room for its own floating button, say) would show the page
 * scrolling past in the strip between the bar and the window's edge. This
 * paints the page background over that strip, as if the bar reached the edge.
 * It is a clipped shadow, so it adds no scroll length and catches no clicks.
 * Render it inside the sticky bar (which is positioned) and only while the bar
 * is pinned against `edge`; a bar that only ever ends its column can keep it.
 */
export function StickyBarEdge({ edge }: { edge: "top" | "bottom" }) {
  const down = edge === "bottom";
  return (
    <span
      aria-hidden
      data-og-sticky-edge={edge}
      className="pointer-events-none absolute inset-0"
      style={{
        boxShadow: `0 ${down ? "" : "-"}50vh 0 50vh var(--color-bg)`,
        clipPath: down ? "inset(0 0 -100vh 0)" : "inset(-100vh 0 0 0)",
      }}
    />
  );
}

/** True while a sticky `top-0` bar is pinned to the top of its scroll container. */
export function useStuckToTop(bar: HTMLElement | null): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!bar) return;
    const scroller = scrollContainerOf(bar);
    let frame = 0;
    const measure = () => {
      frame = 0;
      setStuck(pinnedToTop(bar, scroller));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      target.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [bar]);
  return stuck;
}

/** The nearest ancestor that scrolls vertically; null when the page itself scrolls. */
export function scrollContainerOf(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent === document.body || parent === document.documentElement) return null;
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") return parent;
  }
  return null;
}

/**
 * Pinned means the bar's top sits on the scroller's content edge (inside its
 * padding), where `top: 0` holds it; unpinned, it sits lower, in its own place.
 */
export function pinnedToTop(bar: HTMLElement, scroller: HTMLElement | null): boolean {
  const top = bar.getBoundingClientRect().top;
  if (!scroller) return top <= 1;
  const view = scroller.getBoundingClientRect();
  const padding = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
  return top <= view.top + scroller.clientTop + padding + 1;
}
