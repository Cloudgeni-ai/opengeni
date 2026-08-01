import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { MessageTimeline, type TimelineItem } from "../src";
import { actRun, registerDom, renderComponent, flush } from "./render-hook";

registerDom();

function event(sequence: number): SessionEvent {
  return {
    id: `evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type: "user.message",
    payload: { text: `message ${sequence}` },
    occurredAt: new Date(1_750_000_000_000 + sequence).toISOString(),
    clientEventId: null,
    turnId: null,
  };
}

function agentDelta(sequence: number, text: string): SessionEvent {
  return {
    ...event(sequence),
    type: "agent.message.delta",
    payload: { text },
    turnId: "turn-1",
  };
}

function reasoningDelta(sequence: number, text: string): SessionEvent {
  return {
    ...event(sequence),
    type: "agent.reasoning.delta",
    payload: { text },
    turnId: "turn-1",
  };
}

function userItem(id: string, text: string): TimelineItem {
  return {
    kind: "user-message",
    id,
    text,
    resources: [],
    tools: [],
    occurredAt: "2026-01-01T00:00:00.000Z",
  };
}

function reasoningItem(id: string, text: string): TimelineItem {
  return {
    kind: "reasoning",
    id,
    turnId: "turn-1",
    text,
    streaming: false,
    occurredAt: "2026-01-01T00:00:00.000Z",
  };
}

function manyEvents(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => event(index + 1));
}

async function readerScrollUp(scroller: HTMLElement, scrollTop = 0): Promise<void> {
  // Wheel marks reader intent (fold clamps never synthesize wheel). Scroll
  // position then lands far from the tip.
  await actRun(() => {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
    scroller.scrollTop = scrollTop;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await flush();
}

async function armOlderPrefetch(container: HTMLElement): Promise<void> {
  const scroller = container.querySelector(".overflow-y-auto");
  if (!(scroller instanceof HTMLElement)) {
    throw new Error("expected timeline scroller");
  }
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2400 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
  // Park at the tip first so scroll-up is a real upward delta. (Pinned + tall
  // mock height with scrollTop already 0 is tip-debt recovery, not reader intent.)
  await actRun(() => {
    scroller.scrollTop = 2000;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await flush();
  await readerScrollUp(scroller, 0);
}

const originalIntersectionObserver = globalThis.IntersectionObserver;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const originalElementRect = Element.prototype.getBoundingClientRect;
const originalGetComputedStyle = window.getComputedStyle;
const originalCssDescriptor = Object.getOwnPropertyDescriptor(globalThis, "CSS");

/** happy-dom's `CSS` global is a per-access getter; stub the property itself. */
function stubNativeScrollAnchoringUnsupported(): void {
  Object.defineProperty(globalThis, "CSS", {
    configurable: true,
    value: {
      supports: (condition: string) => !String(condition).includes("overflow-anchor"),
    },
  });
}

afterEach(() => {
  globalThis.IntersectionObserver = originalIntersectionObserver;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  Element.prototype.getBoundingClientRect = originalElementRect;
  window.getComputedStyle = originalGetComputedStyle;
  if (originalCssDescriptor) {
    Object.defineProperty(globalThis, "CSS", originalCssDescriptor);
  }
  frameClockMs = 0;
});

describe("MessageTimeline pagination affordances", () => {
  test("the full loaded window mounts in one bulk paint, ordered and animation-free", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    // Everything the hook loaded is in the DOM immediately — no tip-lock
    // window and no per-frame drip-feed (that was the "content is hidden,
    // then pops in" wobble).
    const initial = manyEvents(20);
    const r = await renderComponent(<MessageTimeline events={initial} hasOlder />);

    const text = r.container.textContent ?? "";
    const positions = Array.from({ length: 20 }, (_, index) =>
      text.indexOf(`message ${index + 1}`),
    );
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(0);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      expect(text.match(new RegExp(`message ${sequence}(?!\\d)`, "g"))).toHaveLength(1);
    }
    expect(r.container.querySelector(".animate-og-enter")).toBeNull();
    // The prefetch sentinel only exists after the reader scrolls up.
    expect(r.container.querySelector("[data-og-top-sentinel]")).toBeNull();

    await drainFrames(frames);
    expect(r.container.querySelector(".animate-og-enter")).toBeNull();
    expect(r.container.querySelector("[data-og-top-sentinel]")).toBeNull();

    await armOlderPrefetch(r.container);
    expect(r.container.querySelector("[data-og-top-sentinel]")).not.toBeNull();
    await drainFrames(frames);
    await r.unmount();
  });

  test("live appends land immediately with the full history retained", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const initial = manyEvents(20);
    const r = await renderComponent(<MessageTimeline events={initial} />);
    await r.rerender(<MessageTimeline events={[...initial, event(21)]} />);

    expect(r.container.textContent).toContain("message 1");
    expect(r.container.textContent).toContain("message 20");
    expect(r.container.textContent).toContain("message 21");

    await drainFrames(frames);
    expect(r.container.textContent).toContain("message 21");
    expect(r.container.textContent!.indexOf("message 20")).toBeLessThan(
      r.container.textContent!.indexOf("message 21"),
    );
    await r.unmount();
  });

  test("same-key streaming content invalidates the memoized group immediately", async () => {
    const first = agentDelta(1, "hello ");
    const r = await renderComponent(<MessageTimeline events={[first]} />);
    expect(r.container.textContent).toContain("hello");
    expect(r.container.textContent).not.toContain("hello world");

    await r.rerender(<MessageTimeline events={[first, agentDelta(2, "world")]} />);
    expect(r.container.textContent).toContain("hello world");
    await r.unmount();
  });

  test("streaming updates keep the full history mounted", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const prefix = manyEvents(19);
    const initial = [...prefix, agentDelta(20, "hello ")];
    const r = await renderComponent(<MessageTimeline events={initial} />);
    expect(r.container.textContent).toContain("hello");
    expect(r.container.textContent).toContain("message 1");

    await r.rerender(<MessageTimeline events={[...initial, agentDelta(21, "world")]} />);
    expect(r.container.textContent).toContain("hello world");
    await drainFrames(frames);
    expect(r.container.textContent).toContain("message 1");
    await r.unmount();
  });

  test("a prepended page mounts entirely in one commit — no progressive reveal", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const settled = manyEvents(12).map((evt) => event(evt.sequence + 8)); // 9..20
    const r = await renderComponent(<MessageTimeline events={settled} />);
    await armOlderPrefetch(r.container);
    await drainFrames(frames);
    await r.rerender(<MessageTimeline events={manyEvents(20)} />);

    // The whole prepend is present in the very same commit, so its scroll
    // correction is a single exact delta instead of per-frame batches.
    const text = r.container.textContent ?? "";
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      expect(text.indexOf(`message ${sequence}`)).toBeGreaterThanOrEqual(0);
    }
    expect(text.indexOf("message 1")).toBeLessThan(text.indexOf("message 2"));
    expect(text.indexOf("message 19")).toBeLessThan(text.indexOf("message 20"));
    // Prepended rows are a bulk paint: no entrance animations.
    expect(r.container.querySelector(".animate-og-enter")).toBeNull();
    await drainFrames(frames);
    await r.unmount();
  });

  test("an items prepend that merges into the first activity group keeps visible rows mounted", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const initial = [
      reasoningItem("activity-a", "activity A"),
      ...Array.from({ length: 14 }, (_, index) =>
        userItem(`u${index + 1}`, `message U${index + 1}`),
      ),
    ];
    const renderMessageText = (text: string, item: TimelineItem) => (
      <span data-message-id={item.id}>{text}</span>
    );
    const r = await renderComponent(
      <MessageTimeline items={initial} renderMessageText={renderMessageText} />,
    );
    await armOlderPrefetch(r.container);
    await drainFrames(frames);
    const u1Before = r.container.querySelector('[data-message-id="u1"]');
    expect(u1Before).not.toBeNull();

    await r.rerender(
      <MessageTimeline
        items={[reasoningItem("activity-b", "activity B"), ...initial]}
        renderMessageText={renderMessageText}
      />,
    );

    expect(r.container.querySelector('[data-message-id="u1"]')).toBe(u1Before);
    expect(r.container.querySelector('[data-message-id="u14"]')).not.toBeNull();
    await drainFrames(frames);
    await r.unmount();
  });

  test("a raw-event prepend that merges reasoning keeps the hydrated suffix mounted", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const initial = [
      reasoningDelta(2, "activity A"),
      event(3),
      ...Array.from({ length: 12 }, (_, index) => event(index + 4)),
    ];
    const renderMessageText = (text: string, item: TimelineItem) => (
      <span data-message-id={item.id}>{text}</span>
    );
    const r = await renderComponent(
      <MessageTimeline events={initial} renderMessageText={renderMessageText} />,
    );
    await armOlderPrefetch(r.container);
    await drainFrames(frames);
    const message3Before = r.container.querySelector('[data-message-id="evt-3"]');
    expect(message3Before).not.toBeNull();

    await r.rerender(
      <MessageTimeline
        events={[reasoningDelta(1, "activity B"), ...initial]}
        renderMessageText={renderMessageText}
      />,
    );

    expect(r.container.querySelector('[data-message-id="evt-3"]')).toBe(message3Before);
    expect(r.container.querySelector('[data-message-id="evt-15"]')).not.toBeNull();
    await drainFrames(frames);
    await r.unmount();
  });

  test("loadingOlder renders the quiet top row and !hasOlder renders no sentinel", async () => {
    const loading = await renderComponent(<MessageTimeline events={[event(1)]} loadingOlder />);
    await flush();
    expect(loading.container.textContent).toContain("Loading earlier activity…");
    await loading.unmount();

    const settled = await renderComponent(<MessageTimeline events={[event(1)]} />);
    await flush();
    expect(settled.container.querySelector("[data-og-top-sentinel]")).toBeNull();
    expect(settled.container.textContent).not.toContain("Loading earlier activity…");
    await settled.unmount();
  });

  test("tip group wrappers do not use content-visibility (keeps scrollHeight honest)", async () => {
    const r = await renderComponent(<MessageTimeline events={manyEvents(20)} />);
    const groups = r.container.querySelectorAll("[data-og-timeline-group-anchor]");
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.className).not.toContain("content-visibility");
      expect(group.className).not.toContain("contain-intrinsic-size");
    }
    await r.unmount();
  });

  test("unpinned prepend restores place by height delta when group offsets are unavailable", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const settled = manyEvents(12).map((evt) => event(evt.sequence + 8)); // 9..20
    const r = await renderComponent(
      <MessageTimeline events={settled} hasOlder loadingOlder={false} />,
    );
    await armOlderPrefetch(r.container);
    await drainFrames(frames);

    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }

    // Reader is near the top — the historical wobble zone while the next
    // older page inserts. Happy-dom group offsetTops are 0, so restore uses
    // the scrollHeight-delta fallback.
    let contentHeight = 2000;
    const clientHeight = 400;
    let currentScrollTop = 24;
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      get: () => clientHeight,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => {
        const max = Math.max(0, contentHeight - clientHeight);
        currentScrollTop = Math.max(0, Math.min(max, value));
      },
    });
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    // Sync the height baseline at the mocked 2000 (a commit with no prepend
    // must never write scrollTop while unpinned).
    await r.rerender(<MessageTimeline events={settled} hasOlder loadingOlder status="idle" />);
    await flush();
    expect(scroller.scrollTop).toBe(24);

    // Content grows WITHOUT a prepend (live tip streaming below, shimmer,
    // late layout): the reader must not be nudged a single pixel.
    contentHeight = 2100;
    await r.rerender(<MessageTimeline events={settled} hasOlder loadingOlder status="running" />);
    await flush();
    expect(scroller.scrollTop).toBe(24);

    // A genuine prepend (older page landed: first item id changed) is
    // corrected by exactly the height delta, once.
    contentHeight = 2500;
    await r.rerender(
      <MessageTimeline events={manyEvents(20)} hasOlder loadingOlder={false} status="running" />,
    );
    await flush();
    expect(scroller.scrollTop).toBe(424); // 24 + (2500 - 2100)

    // Subsequent commits and scroll ticks with unchanged content leave the
    // reader exactly in place — nothing left to oscillate.
    await r.rerender(
      <MessageTimeline events={manyEvents(20)} hasOlder loadingOlder={false} status="running" />,
    );
    await flush();
    expect(scroller.scrollTop).toBe(424);
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(scroller.scrollTop).toBe(424);

    await drainFrames(frames);
    expect(scroller.scrollTop).toBe(424);
    await r.unmount();
  });

  test("near-top prepend restores place when scrollHeight is unchanged (tip truncated)", async () => {
    // loadOlder uses an oldest-directed window: older rows prepend AND the live
    // tip can be evicted. Net scrollHeight may not grow, so height-delta restore
    // alone leaves scrollTop at 0 — the "jumped to top of materialised page" bug.
    // Anchor the previous first group's offsetTop instead.
    const settled = manyEvents(12).map((evt) => event(evt.sequence + 8)); // 9..20
    const r = await renderComponent(
      <MessageTimeline events={settled} hasOlder loadingOlder={false} />,
    );
    await armOlderPrefetch(r.container);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    let height = 2000;
    let top = 0;
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      get: () => 400,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => height,
    });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(height - 400, value));
      },
    });
    await actRun(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await r.rerender(<MessageTimeline events={settled} hasOlder loadingOlder={false} />);
    await flush();

    const originalOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.getAttribute("data-og-group-key") !== "evt-9") {
          return 0;
        }
        // Post-prepend DOM includes older rows (evt-1); that is when the
        // retained evt-9 group has shifted down.
        return scroller.querySelector('[data-og-group-key="evt-1"]') ? 600 : 0;
      },
    });
    try {
      height = 2000; // tip truncated — no net growth
      await r.rerender(
        <MessageTimeline events={manyEvents(20)} hasOlder loadingOlder={false} status="running" />,
      );
      await flush();
      expect(scroller.scrollTop).toBe(600);
    } finally {
      if (originalOffset) {
        Object.defineProperty(HTMLElement.prototype, "offsetTop", originalOffset);
      } else {
        delete (HTMLElement.prototype as { offsetTop?: unknown }).offsetTop;
      }
    }
    await r.unmount();
  });

  test("native scroll anchoring is off while pinned; on when unpinned", async () => {
    const r = await renderComponent(<MessageTimeline events={manyEvents(6)} />);
    await flush();
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    // Pinned: anchoring off so the tip-follow camera owns the motion.
    expect(scroller.className).toContain("[overflow-anchor:none]");
    expect(scroller.className).not.toContain("[overflow-anchor:auto]");

    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2400 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    await actRun(() => {
      scroller.scrollTop = 2000;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();
    await readerScrollUp(scroller, 0);
    // Unpinned: the browser holds the reader's place.
    expect(scroller.className).toContain("[overflow-anchor:auto]");
    expect(scroller.className).not.toContain("[overflow-anchor:none]");
    await r.unmount();
  });

  test("pinned follow keeps the tip at the scroller bottom across live appends", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const prefix = manyEvents(19);
    const initial = [...prefix, agentDelta(20, "hello ")];
    const r = await renderComponent(<MessageTimeline events={initial} status="running" />);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }

    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(distanceFromBottom(scroller)).toBeLessThan(48);
    expect(layout.tipBottomGap()).toBeLessThan(2);

    // Grow content first (stale scrollTop leaves tip above the bottom), then
    // let the tip-follow camera ease back to the bottom.
    layout.setContentHeight(2080);
    expect(layout.tipBottomGap()).toBeGreaterThan(2);
    await r.rerender(
      <MessageTimeline events={[...initial, agentDelta(21, " world")]} status="running" />,
    );
    await drainFrames(frames);
    await flush();

    expect(r.container.textContent).toContain("hello  world");
    expect(distanceFromBottom(scroller)).toBeLessThan(48);
    expect(layout.tipBottomGap()).toBeLessThan(2);
    layout.restore();
    await r.unmount();
  });

  test("reader scroll-up unpins and stays free across streaming updates", async () => {
    const prefix = manyEvents(19);
    const initial = [...prefix, agentDelta(20, "hello ")];
    const r = await renderComponent(<MessageTimeline events={initial} status="running" />);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }

    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(distanceFromBottom(scroller)).toBeLessThan(48);

    await actRun(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
      scroller.scrollTop = 200;
      layout.placeTipAt(120);
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();
    expect(distanceFromBottom(scroller)).toBeGreaterThan(48);
    expect(r.container.textContent).toContain("Jump to latest");

    const scrollTopBefore = scroller.scrollTop;
    await r.rerender(
      <MessageTimeline events={[...initial, agentDelta(21, "world")]} status="running" />,
    );
    await flush();

    expect(r.container.textContent).toContain("hello world");
    expect(r.container.textContent).toContain("Jump to latest");
    // Stick-to-bottom must not yank the reader back to the tip after unpinning.
    expect(scroller.scrollTop).toBe(scrollTopBefore);
    layout.restore();
    await r.unmount();
  });

  test("hasNewer history append (loadNewer) never yanks to the new page bottom", async () => {
    // Mirror of unpinned loadOlder: growth below the viewport must leave
    // scrollTop alone. History-window bottoms used to count as pinned live tip.
    const initial = manyEvents(20);
    const r = await renderComponent(
      <MessageTimeline events={initial} hasNewer onLoadNewer={() => undefined} />,
    );
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }

    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    // Sit near the bottom of this history page (where the newer sentinel fires).
    layout.syncTipAtBottom();
    scroller.scrollTop = Math.max(0, 2000 - 400 - 20);
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();
    expect(r.container.textContent).toContain("Jump to latest");
    expect(scroller.className).toContain("[overflow-anchor:auto]");

    const scrollTopBefore = scroller.scrollTop;
    layout.setContentHeight(2600);
    await r.rerender(
      <MessageTimeline
        events={[...initial, ...Array.from({ length: 8 }, (_, index) => event(21 + index))]}
        hasNewer
        onLoadNewer={() => undefined}
      />,
    );
    await flush();

    expect(scroller.scrollTop).toBe(scrollTopBefore);
    expect(distanceFromBottom(scroller)).toBeGreaterThan(48);
    expect(r.container.textContent).toContain("Jump to latest");
    layout.restore();
    await r.unmount();
  });

  test("mid-turn fold + tip growth does not unpin when maxScroll stays flat", async () => {
    // tools→message→tools: cluster collapse and narration growth cancel in
    // maxScroll while scrollTop still drops — old conservation false-unpinned.
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const prefix = manyEvents(19);
    const initial = [...prefix, agentDelta(20, "hello ")];
    const r = await renderComponent(<MessageTimeline events={initial} status="running" />);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(r.container.textContent).not.toContain("Jump to latest");

    // Same scrollHeight + same maxScroll, but scrollTop drops (fold above +
    // growth below). Must stay pinned and recover tip — not Jump to latest.
    await actRun(() => {
      scroller.scrollTop = 1400;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await drainFrames(frames);
    await flush();
    expect(r.container.textContent).not.toContain("Jump to latest");
    expect(distanceFromBottom(scroller)).toBeLessThan(48);

    layout.restore();
    await r.unmount();
  });

  test("layout height shrink while pinned does not unpin (settle-fold / scenario spawn)", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const prefix = manyEvents(19);
    const initial = [...prefix, agentDelta(20, "hello ")];
    const r = await renderComponent(<MessageTimeline events={initial} status="running" />);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }

    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(distanceFromBottom(scroller)).toBeLessThan(48);
    expect(r.container.textContent).not.toContain("Jump to latest");

    // Settle-fold collapse: content above the tip shrinks. Browser clamp
    // lowers scrollTop to the new max (not below — that would be reader intent).
    // Clamp conservation: top fall ≈ maxScroll fall → stay pinned.
    layout.setContentHeight(1500);
    await actRun(() => {
      scroller.scrollTop = 1100; // new max = 1500 - 400
      scroller.dispatchEvent(new Event("scroll"));
    });
    // Same-height second scroll after stick: still pinned at tip.
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await drainFrames(frames);
    await flush();
    expect(r.container.textContent).not.toContain("Jump to latest");
    expect(distanceFromBottom(scroller)).toBeLessThan(48);

    // A following tip append must still stick to bottom.
    layout.setContentHeight(1580);
    await r.rerender(<MessageTimeline events={[...initial, event(21)]} status="running" />);
    await drainFrames(frames);
    await flush();
    expect(r.container.textContent).not.toContain("Jump to latest");
    expect(distanceFromBottom(scroller)).toBeLessThan(48);
    layout.restore();
    await r.unmount();
  });

  test("pointer-armed scroll-up during growth unpins without a wheel event", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const prefix = manyEvents(19);
    const initial = [...prefix, agentDelta(20, "hello ")];
    const r = await renderComponent(<MessageTimeline events={initial} status="running" />);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(r.container.textContent).not.toContain("Jump to latest");

    // Streaming growth, then pointer-drag the scroller up (scrollbar / touch).
    // Bare scroll without pointer arm must NOT unpin — that's mid-turn fold noise.
    layout.setContentHeight(2400);
    await actRun(() => {
      scroller.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          pointerType: "mouse",
          bubbles: true,
        }),
      );
      scroller.scrollTop = 1200;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await drainFrames(frames);
    await flush();
    expect(r.container.textContent).toContain("Jump to latest");
    layout.restore();
    await r.unmount();
  });

  test("settle-fold clamp does not re-pin an unpinned reader", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const prefix = manyEvents(19);
    const initial = [...prefix, agentDelta(20, "hello ")];
    const r = await renderComponent(<MessageTimeline events={initial} status="running" />);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await readerScrollUp(scroller, 1300);
    expect(r.container.textContent).toContain("Jump to latest");

    // Fold removes content below the reader → clamp onto nearBottom. Must
    // stay unpinned (not silently re-stick and yank on the next delta).
    layout.setContentHeight(1500);
    await actRun(() => {
      scroller.scrollTop = 1100;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await drainFrames(frames);
    await flush();
    expect(r.container.textContent).toContain("Jump to latest");
    layout.restore();
    await r.unmount();
  });

  test("wheel over a nested overflow scroller does not unpin the timeline", async () => {
    const r = await renderComponent(
      <MessageTimeline events={[...manyEvents(19), agentDelta(20, "hello ")]} status="running" />,
    );
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    const nested = document.createElement("pre");
    nested.className = "max-h-64 overflow-auto";
    Object.defineProperty(nested, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(nested, "clientHeight", { configurable: true, value: 200 });
    nested.scrollTop = 120;
    scroller.appendChild(nested);

    window.getComputedStyle = ((el: Element) => {
      if (el === nested) {
        return { overflowY: "auto" } as CSSStyleDeclaration;
      }
      return originalGetComputedStyle(el);
    }) as typeof window.getComputedStyle;

    await actRun(() => {
      nested.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -40, deltaX: 0, bubbles: true }),
      );
    });
    await flush();
    expect(r.container.textContent).not.toContain("Jump to latest");
    window.getComputedStyle = originalGetComputedStyle;
    nested.remove();
    layout.restore();
    await r.unmount();
  });

  test("pinned tip does not arm older prefetch; scroll-up does", async () => {
    let callback: IntersectionObserverCallback = () => undefined;
    let instance: IntersectionObserver | null = null;
    const observed: Element[] = [];
    globalThis.IntersectionObserver = class implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "400px 0px 0px 0px";
      readonly scrollMargin = "0px 0px 0px 0px";
      readonly thresholds = [0];
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
        instance = this;
      }
      observe(target: Element): void {
        observed.push(target);
      }
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    };

    let calls = 0;
    const r = await renderComponent(
      <MessageTimeline
        events={manyEvents(4)}
        hasOlder
        onLoadOlder={() => {
          calls += 1;
        }}
      />,
    );
    await flush();
    expect(r.container.querySelector("[data-og-top-sentinel]")).toBeNull();
    expect(observed).toHaveLength(0);

    await armOlderPrefetch(r.container);
    expect(r.container.querySelector("[data-og-top-sentinel]")).not.toBeNull();
    expect(observed).toHaveLength(1);
    await actRun(() =>
      callback(
        [{ isIntersecting: true, target: observed[0]! } as IntersectionObserverEntry],
        instance!,
      ),
    );
    expect(calls).toBe(1);
    await r.unmount();
  });

  test("older prefetch does not loop at the batch top", async () => {
    let callback: IntersectionObserverCallback = () => undefined;
    let instance: IntersectionObserver | null = null;
    const observed: Element[] = [];
    globalThis.IntersectionObserver = class implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "400px 0px 0px 0px";
      readonly scrollMargin = "0px 0px 0px 0px";
      readonly thresholds = [0];
      constructor(cb: IntersectionObserverCallback) {
        callback = cb;
        instance = this;
      }
      observe(target: Element): void {
        observed.push(target);
      }
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    };

    let calls = 0;
    const r = await renderComponent(
      <MessageTimeline
        events={manyEvents(4)}
        hasOlder
        onLoadOlder={() => {
          calls += 1;
        }}
      />,
    );
    await armOlderPrefetch(r.container);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    scroller.scrollTop = 200;

    const hit = async () => {
      await actRun(() =>
        callback(
          [{ isIntersecting: true, target: observed[0]! } as IntersectionObserverEntry],
          instance!,
        ),
      );
    };
    await hit();
    expect(calls).toBe(1);
    // Still intersecting / scrolling toward y=0 must not chain-load.
    await hit();
    await hit();
    expect(calls).toBe(1);
    await actRun(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();
    await hit();
    expect(calls).toBe(1);

    // Leave the top band (scroll down into content) re-arms.
    await actRun(() => {
      scroller.scrollTop = 500;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();
    await hit();
    expect(calls).toBe(2);

    // Sentinel exit also re-arms.
    await actRun(() =>
      callback(
        [{ isIntersecting: false, target: observed[0]! } as IntersectionObserverEntry],
        instance!,
      ),
    );
    await hit();
    expect(calls).toBe(3);
    await r.unmount();
  });

  test("pinned scroll-up intent releases pin instead of yanking back to tip", async () => {
    const r = await renderComponent(<MessageTimeline events={manyEvents(8)} status="running" />);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(distanceFromBottom(scroller)).toBeLessThan(48);

    // Wheel toward older history unpins — fold clamps never synthesize wheel,
    // so this is the reliable reader-intent edge.
    await actRun(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
      scroller.scrollTop = 1200;
      layout.placeTipAt(1200);
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();
    expect(r.container.textContent).toContain("Jump to latest");
    expect(scroller.scrollTop).toBe(1200);
    layout.restore();
    await r.unmount();
  });

  test("pinned tip-debt from growth does not unpin without a reader scroll-up", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const prefix = manyEvents(19);
    const initial = [...prefix, agentDelta(20, "hello ")];
    const r = await renderComponent(<MessageTimeline events={initial} status="running" />);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    // Content grew under a pinned reader; scrollTop stale ⇒ tip-debt. A scroll
    // echo must keep the pin and recover — not show Jump to latest.
    layout.setContentHeight(2300);
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await drainFrames(frames);
    await flush();
    expect(r.container.textContent).not.toContain("Jump to latest");
    expect(distanceFromBottom(scroller)).toBeLessThan(48);
    layout.restore();
    await r.unmount();
  });

  test("pinned appends soft-follow the tip; a later scroll-up cancels the camera", async () => {
    // Tip-follow eases toward the bottom. Mid-follow wheel-up unpins —
    // camera echoes (downward scrollTop) must not swallow that intent.
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const prefix = manyEvents(19);
    const initial = [...prefix, agentDelta(20, "hello ")];
    const r = await renderComponent(<MessageTimeline events={initial} status="running" />);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    // Tip growth + tip-follow reaches the bottom after camera frames drain.
    layout.setContentHeight(2300);
    await r.rerender(
      <MessageTimeline events={[...initial, agentDelta(21, "world")]} status="running" />,
    );
    await drainFrames(frames);
    expect(distanceFromBottom(scroller)).toBeLessThan(2);

    const freedTop = 900;
    await actRun(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
      scroller.scrollTop = freedTop;
      layout.placeTipAt(freedTop + 200);
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();

    expect(r.container.textContent).toContain("Jump to latest");
    expect(scroller.scrollTop).toBe(freedTop);

    // Further streaming must not re-stick / yank.
    const before = scroller.scrollTop;
    layout.setContentHeight(2600);
    await r.rerender(
      <MessageTimeline
        events={[...initial, agentDelta(21, "world"), agentDelta(22, "!")]}
        status="running"
      />,
    );
    await drainFrames(frames);
    await flush();
    expect(scroller.scrollTop).toBe(before);
    expect(r.container.textContent).toContain("Jump to latest");

    layout.restore();
    await r.unmount();
  });

  test("Jump to latest with hasNewer pins only when the tip window lands", async () => {
    // Pinning against the current history page would snap to ITS bottom and
    // page-crawl forward through the gap; the pin must wait for hasNewer to
    // flip false.
    let jumps = 0;
    const onJumpToLatest = () => {
      jumps += 1;
    };
    const initial = manyEvents(20);
    const r = await renderComponent(
      <MessageTimeline events={initial} hasNewer onJumpToLatest={onJumpToLatest} />,
    );
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    scroller.scrollTop = 1000;
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();

    const button = Array.from(r.container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Jump to latest"),
    );
    if (!button) {
      throw new Error("expected Jump to latest button");
    }
    await actRun(() => {
      button.click();
    });
    await flush();
    expect(jumps).toBe(1);
    // History window still showing: no snap to the page bottom.
    expect(scroller.scrollTop).toBe(1000);

    // The tip window lands (hasNewer false): pin + snap. (The button itself
    // may linger through its exit animation under happy-dom, so assert pin via
    // overflow-anchor:none + near-bottom.)
    layout.setContentHeight(2400);
    await r.rerender(<MessageTimeline events={initial} onJumpToLatest={onJumpToLatest} />);
    await flush();
    expect(distanceFromBottom(scroller)).toBeLessThan(2);
    expect(scroller.className).toContain("[overflow-anchor:none]");
    layout.restore();
    await r.unmount();
  });

  test("paging forward to the tip re-pins a reader parked at the bottom", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const initial = manyEvents(20);
    const r = await renderComponent(
      <MessageTimeline events={initial} hasNewer onLoadNewer={() => undefined} />,
    );
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    // Parked at the bottom of the last history page.
    scroller.scrollTop = 1600;
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();
    expect(r.container.textContent).toContain("Jump to latest");

    // The last page merges into the live tip: hasNewer flips false and the
    // reader at the bottom is following again — no stranded unpinned state
    // with new content growing below. (Pin = overflow-anchor:none; the Jump
    // button may linger through its exit animation under happy-dom.)
    await r.rerender(<MessageTimeline events={initial} />);
    await flush();
    expect(scroller.className).toContain("[overflow-anchor:none]");

    layout.setContentHeight(2100);
    await r.rerender(<MessageTimeline events={[...initial, event(21)]} />);
    await drainFrames(frames);
    await flush();
    expect(distanceFromBottom(scroller)).toBeLessThan(2);
    layout.restore();
    await r.unmount();
  });

  test("rows born in the initial bulk paint never animate; rows appended live do", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const initial = [event(1)];
    const r = await renderComponent(<MessageTimeline events={initial} />);
    // Mounted during the bulk paint: no entrance animation class — and none
    // appears later either (nothing is toggled, so nothing can replay).
    expect(r.container.querySelector(".animate-og-enter")).toBeNull();

    await actRun(() => {
      for (const frame of frames.splice(0)) {
        frame(performance.now());
      }
    });
    await flush();
    expect(r.container.querySelector(".animate-og-enter")).toBeNull();

    // A row appended AFTER the bulk window animates in exactly as before.
    await r.rerender(<MessageTimeline events={[...initial, event(2)]} />);
    await flush();
    const animated = Array.from(r.container.querySelectorAll(".animate-og-enter"));
    expect(animated).toHaveLength(1);
    expect(animated[0]?.textContent).toContain("message 2");
    await r.unmount();
  });

  test("a rejected onJumpToLatest clears the pending pin latch", async () => {
    // A rejecting tip reload is an ordinary network failure. The latch must
    // not survive it: minutes later, when the reader pages to the tip
    // themselves, a stale latch would force pin + snap from wherever they are.
    const initial = manyEvents(20);
    const r = await renderComponent(
      <MessageTimeline
        events={initial}
        hasNewer
        onJumpToLatest={() => Promise.reject(new Error("tip reload failed"))}
      />,
    );
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    scroller.scrollTop = 1000;
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();

    const button = Array.from(r.container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Jump to latest"),
    );
    if (!button) {
      throw new Error("expected Jump to latest button");
    }
    await actRun(() => {
      button.click();
    });
    await flush();
    expect(scroller.scrollTop).toBe(1000);

    // The reader later reaches the tip window on their own: no surprise snap.
    await r.rerender(
      <MessageTimeline
        events={initial}
        onJumpToLatest={() => Promise.reject(new Error("tip reload failed"))}
      />,
    );
    await flush();
    expect(scroller.scrollTop).toBe(1000);
    expect(scroller.className).toContain("[overflow-anchor:auto]");
    layout.restore();
    await r.unmount();
  });

  test("Jump to latest without a reload handler: scrolls the window; a scroll away expires the latch", async () => {
    const initial = manyEvents(20);
    const r = await renderComponent(
      <MessageTimeline events={initial} hasNewer onLoadNewer={() => undefined} />,
    );
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 2000,
      tipHeight: 80,
      paddingBottom: 24,
    });
    scroller.scrollTop = 1000;
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();

    const button = Array.from(r.container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Jump to latest"),
    );
    if (!button) {
      throw new Error("expected Jump to latest button");
    }
    // Without onJumpToLatest the click still jumps within the in-memory
    // window (its bottom is where the newer sentinel pages forward from).
    await actRun(() => {
      button.click();
    });
    await flush();
    expect(scroller.scrollTop).toBe(1600);

    // The reader changes their mind and scrolls back into history: the
    // pending latch expires with them.
    await readerScrollUp(scroller, 200);

    // The tip window lands much later: no stale force pin + snap.
    await r.rerender(<MessageTimeline events={initial} onLoadNewer={() => undefined} />);
    await flush();
    expect(scroller.scrollTop).toBe(200);
    expect(scroller.className).toContain("[overflow-anchor:auto]");
    layout.restore();
    await r.unmount();
  });

  test("Jump to start consumes its pending flag on the window-swap commit, once", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;
    // The fallback prepend-correction path is the observable alternative to
    // the jump: a leaked flag shows up as scrollTop 0 instead of a correction.
    stubNativeScrollAnchoringUnsupported();

    const settled = manyEvents(12).map((evt) => event(evt.sequence + 8)); // 9..20
    const r = await renderComponent(
      <MessageTimeline events={settled} hasOlder onJumpToStart={() => undefined} />,
    );
    await armOlderPrefetch(r.container);
    await drainFrames(frames);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    let contentHeight = 2000;
    const clientHeight = 400;
    let currentScrollTop = 600;
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      get: () => clientHeight,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => {
        const max = Math.max(0, contentHeight - clientHeight);
        currentScrollTop = Math.max(0, Math.min(max, value));
      },
    });
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    // Sync the height baseline at the mocked 2000.
    await r.rerender(<MessageTimeline events={settled} hasOlder onJumpToStart={() => undefined} />);
    await flush();

    const button = Array.from(r.container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Jump to start"),
    );
    if (!button) {
      throw new Error("expected Jump to start button");
    }
    await actRun(() => {
      button.click();
    });
    await flush();

    // The oldest window lands (first item id changes): jump to the top of the
    // NEW DOM — the prepend correction (which would land at 600) must not run.
    contentHeight = 2600;
    await r.rerender(
      <MessageTimeline events={manyEvents(20)} hasOlder onJumpToStart={() => undefined} />,
    );
    await flush();
    expect(scroller.scrollTop).toBe(0);
    await drainFrames(frames);

    // Consumed exactly once: a LATER prepend gets the ordinary correction, not
    // a spurious jump back to the top.
    await readerScrollUp(scroller, 24);
    await r.rerender(
      <MessageTimeline events={manyEvents(20)} hasOlder onJumpToStart={() => undefined} />,
    );
    await flush();
    contentHeight = 3000;
    await r.rerender(
      <MessageTimeline
        events={[event(0), ...manyEvents(20)]}
        hasOlder
        onJumpToStart={() => undefined}
      />,
    );
    await flush();
    expect(scroller.scrollTop).toBe(424); // 24 + (3000 - 2600)
    await drainFrames(frames);
    await r.unmount();
  });

  test("Jump to start resolving without a window change clears the pending flag", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;
    stubNativeScrollAnchoringUnsupported();

    const settled = manyEvents(12).map((evt) => event(evt.sequence + 8)); // 9..20
    const r = await renderComponent(
      <MessageTimeline events={settled} hasOlder onJumpToStart={() => undefined} />,
    );
    await armOlderPrefetch(r.container);
    await drainFrames(frames);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    let contentHeight = 2000;
    const clientHeight = 400;
    let currentScrollTop = 600;
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      get: () => clientHeight,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => currentScrollTop,
      set: (value: number) => {
        const max = Math.max(0, contentHeight - clientHeight);
        currentScrollTop = Math.max(0, Math.min(max, value));
      },
    });
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await r.rerender(<MessageTimeline events={settled} hasOlder onJumpToStart={() => undefined} />);
    await flush();

    const button = Array.from(r.container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Jump to start"),
    );
    if (!button) {
      throw new Error("expected Jump to start button");
    }
    await actRun(() => {
      button.click();
    });
    await flush();
    // Resolved against the CURRENT window: scrolled to its top…
    expect(scroller.scrollTop).toBe(0);
    // …and the pending flag expires by the next frame (no swap commit came).
    await drainFrames(frames);

    // The next genuine prepend must get the ordinary correction — a leaked
    // flag would consume it as a spurious jump to the top.
    await readerScrollUp(scroller, 24);
    await r.rerender(<MessageTimeline events={settled} hasOlder onJumpToStart={() => undefined} />);
    await flush();
    contentHeight = 2500;
    await r.rerender(
      <MessageTimeline events={manyEvents(20)} hasOlder onJumpToStart={() => undefined} />,
    );
    await flush();
    expect(scroller.scrollTop).toBe(524); // 24 + (2500 - 2000)
    await drainFrames(frames);
    await r.unmount();
  });
});

/**
 * Synthetic vsync clock for tip-follow. Seeded from performance.now() so it
 * stays on the same timeline as layout/RO driveFollow calls.
 */
let frameClockMs = 0;

async function runNextFrame(frames: FrameRequestCallback[]): Promise<void> {
  const frame = frames.shift();
  if (!frame) {
    throw new Error("expected a scheduled animation frame");
  }
  if (frameClockMs === 0) {
    frameClockMs = performance.now();
  }
  frameClockMs += 16;
  await actRun(() => frame(frameClockMs));
}

async function drainFrames(frames: FrameRequestCallback[]): Promise<void> {
  let count = 0;
  while (frames.length > 0) {
    await runNextFrame(frames);
    count += 1;
    // Calm tip-follow (~42 px/s) needs headroom for multi-hundred-px debt.
    if (count > 800) {
      throw new Error("animation-frame queue did not settle");
    }
  }
  await flush();
}

function distanceFromBottom(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}

/**
 * Happy-DOM does not lay out timeline rows. Stub scroller metrics + tip
 * getBoundingClientRect so stick-to-bottom / unpin logic can be asserted.
 */
function mockScrollerLayout(
  scroller: HTMLElement,
  options: {
    clientHeight: number;
    contentHeight: number;
    tipHeight: number;
    paddingBottom: number;
  },
) {
  let contentHeight = options.contentHeight;
  let tipTopInScroller = contentHeight - options.paddingBottom - options.tipHeight;
  let currentScrollTop = Math.max(0, contentHeight - options.clientHeight);
  const scrollerTop = 100;

  const findTip = (): HTMLElement | null => {
    const inner = scroller.firstElementChild;
    if (!inner) {
      return null;
    }
    for (let child = inner.lastElementChild; child; child = child.previousElementSibling) {
      if (child instanceof HTMLElement && child.dataset.ogTimelineChrome === undefined) {
        return child;
      }
    }
    return null;
  };

  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    get: () => options.clientHeight,
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => contentHeight,
  });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => currentScrollTop,
    set: (value: number) => {
      const max = Math.max(0, contentHeight - options.clientHeight);
      currentScrollTop = Math.max(0, Math.min(max, value));
    },
  });

  const scrollerElementRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (this === scroller) {
      return {
        top: scrollerTop,
        bottom: scrollerTop + options.clientHeight,
        height: options.clientHeight,
        width: 640,
        left: 0,
        right: 640,
        x: 0,
        y: scrollerTop,
        toJSON() {
          return {};
        },
      } as DOMRect;
    }
    if (this === findTip()) {
      const top = scrollerTop + (tipTopInScroller - currentScrollTop);
      return {
        top,
        bottom: top + options.tipHeight,
        height: options.tipHeight,
        width: 640,
        left: 0,
        right: 640,
        x: 0,
        y: top,
        toJSON() {
          return {};
        },
      } as DOMRect;
    }
    return scrollerElementRect.call(this);
  };

  const originalStyle = window.getComputedStyle;
  window.getComputedStyle = (elt: Element, pseudoElt?: string | null) => {
    const style = originalStyle(elt, pseudoElt);
    if (elt === scroller) {
      return new Proxy(style, {
        get(target, prop, receiver) {
          if (prop === "paddingBottom") {
            return `${options.paddingBottom}px`;
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as CSSStyleDeclaration;
    }
    return style;
  };

  return {
    setContentHeight(next: number) {
      contentHeight = next;
      tipTopInScroller = contentHeight - options.paddingBottom - options.tipHeight;
    },
    syncTipAtBottom() {
      currentScrollTop = Math.max(0, contentHeight - options.clientHeight);
      tipTopInScroller = contentHeight - options.paddingBottom - options.tipHeight;
    },
    placeTipAt(topInScroller: number) {
      tipTopInScroller = topInScroller;
    },
    tipBottomGap() {
      const tip = findTip();
      if (!tip) {
        throw new Error("expected tip element");
      }
      const tipRect = tip.getBoundingClientRect();
      const nodeRect = scroller.getBoundingClientRect();
      return Math.abs(tipRect.bottom - (nodeRect.bottom - options.paddingBottom));
    },
    restore() {
      Element.prototype.getBoundingClientRect = scrollerElementRect;
      window.getComputedStyle = originalStyle;
    },
  };
}
