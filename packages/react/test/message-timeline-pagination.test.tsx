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

async function armOlderPrefetch(container: HTMLElement): Promise<void> {
  const scroller = container.querySelector(".overflow-y-auto");
  if (!(scroller instanceof HTMLElement)) {
    throw new Error("expected timeline scroller");
  }
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2400 });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
  await actRun(() => {
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
  });
  await flush();
}

const originalIntersectionObserver = globalThis.IntersectionObserver;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const originalElementRect = Element.prototype.getBoundingClientRect;
const originalGetComputedStyle = window.getComputedStyle;

afterEach(() => {
  globalThis.IntersectionObserver = originalIntersectionObserver;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  Element.prototype.getBoundingClientRect = originalElementRect;
  window.getComputedStyle = originalGetComputedStyle;
});

describe("MessageTimeline pagination affordances", () => {
  test("tip stays on newest suffix until scroll-up; then older groups batch in", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    // 20 groups: tip-locked paint shows newest 12 (9..20); no auto hydrate.
    const initial = manyEvents(20);
    const r = await renderComponent(<MessageTimeline events={initial} hasOlder />);

    expect(r.container.textContent).toContain("message 20");
    expect(r.container.textContent).toContain("message 9");
    expect(r.container.textContent).not.toContain("message 8");
    expect(r.container.querySelector(".animate-og-enter")).toBeNull();
    expect(r.container.querySelector("[data-og-top-sentinel]")).toBeNull();

    // Tip-locked: bulk-animation clear may use a frame, but older groups stay unmounted.
    await drainFrames(frames);
    expect(r.container.textContent).not.toContain("message 8");
    expect(r.container.querySelector("[data-og-top-sentinel]")).toBeNull();

    await armOlderPrefetch(r.container);
    // Hydration suppresses the sentinel until the older prefix is fully mounted.
    await runNextFrame(frames);
    expect(r.container.textContent).toContain("message 5");
    expect(r.container.textContent).not.toContain("message 4");
    expect(r.container.querySelector(".animate-og-enter")).toBeNull();

    await drainFrames(frames);
    const text = r.container.textContent ?? "";
    const positions = Array.from({ length: 20 }, (_, index) =>
      text.indexOf(`message ${index + 1}`),
    );
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      expect(text.match(new RegExp(`message ${sequence}(?!\\d)`, "g"))).toHaveLength(1);
    }
    expect(r.container.querySelector(".animate-og-enter")).toBeNull();
    expect(r.container.querySelector("[data-og-top-sentinel]")).not.toBeNull();
    await r.unmount();
  });

  test("live appends stay immediate on the tip without hydrating older groups", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const initial = manyEvents(20);
    const r = await renderComponent(<MessageTimeline events={initial} />);
    await r.rerender(<MessageTimeline events={[...initial, event(21)]} />);

    expect(r.container.textContent).toContain("message 20");
    expect(r.container.textContent).toContain("message 21");
    // Tip window slides forward (newest 12 of 21 ⇒ 10..21); older stay unmounted.
    expect(r.container.textContent).not.toContain("message 9");

    await drainFrames(frames);
    expect(r.container.textContent).toContain("message 21");
    expect(r.container.textContent).not.toContain("message 9");
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

  test("same-key streaming updates do not schedule older-group hydration while tip-locked", async () => {
    const frames: FrameRequestCallback[] = [];
    let cancellations = 0;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => {
      cancellations += 1;
    };

    const prefix = manyEvents(19);
    const initial = [...prefix, agentDelta(20, "hello ")];
    const r = await renderComponent(<MessageTimeline events={initial} />);
    expect(r.container.textContent).toContain("hello");
    expect(r.container.textContent).not.toContain("message 8");

    await r.rerender(<MessageTimeline events={[...initial, agentDelta(21, "world")]} />);
    expect(r.container.textContent).toContain("hello world");
    expect(cancellations).toBe(0);
    await drainFrames(frames);
    expect(r.container.textContent).not.toContain("message 8");
    await r.unmount();
  });

  test("after scroll-up, a prepended page keeps mounted rows and reveals its new prefix", async () => {
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

    expect(r.container.textContent).toContain("message 20");
    expect(r.container.textContent).toContain("message 9");
    // New prefix above the retained suffix mounts progressively.
    expect(r.container.textContent).not.toContain("message 4");

    await runNextFrame(frames);
    expect(r.container.textContent).toContain("message 5");
    await drainFrames(frames);

    const text = r.container.textContent ?? "";
    for (let sequence = 1; sequence <= 20; sequence += 1) {
      expect(text.indexOf(`message ${sequence}`)).toBeGreaterThanOrEqual(0);
    }
    expect(text.indexOf("message 1")).toBeLessThan(text.indexOf("message 2"));
    expect(text.indexOf("message 19")).toBeLessThan(text.indexOf("message 20"));
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
      ...Array.from({ length: 14 }, (_, index) => userItem(`u${index + 1}`, `message U${index + 1}`)),
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

  test("pinned follow keeps the tip at the scroller bottom across live appends", async () => {
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
    // let the live append's layout effect run stick-to-bottom.
    layout.setContentHeight(2080);
    expect(layout.tipBottomGap()).toBeGreaterThan(2);
    await r.rerender(
      <MessageTimeline events={[...initial, agentDelta(21, " world")]} status="running" />,
    );
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

  test("pinned tip does not arm older prefetch; scroll-up does", async () => {
    let callback: IntersectionObserverCallback = () => undefined;
    let instance: IntersectionObserver | null = null;
    const observed: Element[] = [];
    globalThis.IntersectionObserver = class implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "1600px 0px 0px 0px";
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
});

async function runNextFrame(frames: FrameRequestCallback[]): Promise<void> {
  const frame = frames.shift();
  if (!frame) {
    throw new Error("expected a scheduled animation frame");
  }
  await actRun(() => frame(performance.now()));
}

async function drainFrames(frames: FrameRequestCallback[]): Promise<void> {
  let count = 0;
  while (frames.length > 0) {
    await runNextFrame(frames);
    count += 1;
    if (count > 100) {
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

  const originalElementRect = Element.prototype.getBoundingClientRect;
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
    return originalElementRect.call(this);
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
      Element.prototype.getBoundingClientRect = originalElementRect;
      window.getComputedStyle = originalStyle;
    },
  };
}
