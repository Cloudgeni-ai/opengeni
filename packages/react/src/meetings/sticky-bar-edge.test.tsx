import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register();
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { StickyBarEdge, pinnedToTop, scrollContainerOf } = await import("./sticky-bar-edge");

afterAll(() => {
  if (ownsDom) GlobalRegistrator.unregister();
});

function rect(top: number): DOMRect {
  return {
    top,
    bottom: top + 40,
    left: 0,
    right: 400,
    height: 40,
    width: 400,
    x: 0,
    y: top,
  } as DOMRect;
}

/** A host scroller with 12 px of top padding, holding `bar` at `barTop` px. */
function hostScroller(barTop: number) {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  scroller.style.paddingTop = "12px";
  const column = document.createElement("div");
  const bar = document.createElement("div");
  column.append(bar);
  scroller.append(column);
  document.body.append(scroller);
  scroller.getBoundingClientRect = () => rect(100);
  bar.getBoundingClientRect = () => rect(barTop);
  return { scroller, bar };
}

describe("sticky bars that reach the window's edge", () => {
  test("a bar finds the host's scroller, and none when the page itself scrolls", () => {
    const { scroller, bar } = hostScroller(112);
    expect(scrollContainerOf(bar)).toBe(scroller);
    const loose = document.createElement("div");
    document.body.append(loose);
    expect(scrollContainerOf(loose)).toBeNull();
    scroller.remove();
    loose.remove();
  });

  test("the player's bar is pinned on the scroller's content edge, not lower in its own place", () => {
    const pinned = hostScroller(112);
    expect(pinnedToTop(pinned.bar, pinned.scroller)).toBe(true);
    const inPlace = hostScroller(260);
    expect(pinnedToTop(inPlace.bar, inPlace.scroller)).toBe(false);
    pinned.scroller.remove();
    inPlace.scroller.remove();
  });

  test("the cover paints the page background outward from the bar, clipped to its width", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <>
          <StickyBarEdge edge="bottom" />
          <StickyBarEdge edge="top" />
        </>,
      );
    });
    const bottom = host.querySelector<HTMLElement>('[data-og-sticky-edge="bottom"]');
    const top = host.querySelector<HTMLElement>('[data-og-sticky-edge="top"]');
    expect(bottom?.getAttribute("aria-hidden")).toBe("true");
    expect(bottom?.style.boxShadow).toContain("var(--color-bg)");
    expect(bottom?.style.clipPath).toBe("inset(0 0 -100vh 0)");
    expect(top?.style.clipPath).toBe("inset(-100vh 0 0 0)");
    expect(bottom?.className).toContain("pointer-events-none");
    await act(async () => root.unmount());
    host.remove();
  });
});
