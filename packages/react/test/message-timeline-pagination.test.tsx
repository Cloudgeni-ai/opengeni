import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { StrictMode, useState, type ComponentType } from "react";
import { flushSync } from "react-dom";
import {
  MessageTimeline as PublicMessageTimeline,
  createOlderHistoryLoadReceipt,
  type MessageTimelineProps,
  type OlderHistoryLoader,
  type OlderHistoryLoadReceipt,
  type TimelineItem,
  type UserMessageItem,
} from "../src";
import { setScrollEndSupportForTests } from "../src/components/tip-follow";
import { actRun, registerDom, renderComponent, flush } from "./render-hook";

registerDom();

type LegacyTestMessageTimelineProps = Omit<MessageTimelineProps, "onLoadOlder"> & {
  onLoadOlder?: (() => unknown) | undefined;
};

// Most cases below retain explicit runtime coverage for hosts compiled against
// the previous callback shape. Public contract checks use PublicMessageTimeline
// and OlderHistoryLoader directly so source compatibility cannot regress.
const MessageTimeline = PublicMessageTimeline as ComponentType<LegacyTestMessageTimelineProps>;

const receiptedLoader: OlderHistoryLoader = () =>
  createOlderHistoryLoadReceipt(() => Promise.resolve(true));
const forwardingWrapper: NonNullable<MessageTimelineProps["onLoadOlder"]> = () => receiptedLoader();
void forwardingWrapper;
const droppingWrapper: NonNullable<MessageTimelineProps["onLoadOlder"]> = () => {
  void receiptedLoader();
};
void droppingWrapper;
const legacyVoidLoader: () => void = () => undefined;
const legacyVoidProp: NonNullable<MessageTimelineProps["onLoadOlder"]> = legacyVoidLoader;
const nonBooleanPromiseLoader: NonNullable<MessageTimelineProps["onLoadOlder"]> = async () => [
  "older-event",
];
const synchronousValueLoader: NonNullable<MessageTimelineProps["onLoadOlder"]> = () => ({
  accepted: true,
});
void nonBooleanPromiseLoader;
void synchronousValueLoader;
void legacyVoidProp;

function controlledOlderReceipt(promise: Promise<boolean>): {
  receipt: OlderHistoryLoadReceipt;
  commit: () => void;
} {
  let commitReceipt: (() => void) | null = null;
  let commitRequested = false;
  const receipt = createOlderHistoryLoadReceipt((markCommitted) => {
    commitReceipt = markCommitted;
    if (commitRequested) {
      markCommitted();
    }
    return promise;
  });
  return {
    receipt,
    commit: () => {
      commitRequested = true;
      commitReceipt?.();
    },
  };
}

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

function userItem(id: string, text: string): UserMessageItem {
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
const originalResizeObserver = globalThis.ResizeObserver;
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
  globalThis.ResizeObserver = originalResizeObserver;
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
  test("can reveal a known-fresh first message without blanking the scroller", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const r = await renderComponent(
      <MessageTimeline items={[userItem("c", "accepted first prompt")]} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");

    expect(scroller).not.toBeNull();
    expect(scroller?.getAttribute("style") ?? "").not.toContain("visibility");
    expect(r.container.textContent).toContain("accepted first prompt");
    await r.unmount();
  });

  test("keeps an optimistic user message mounted through its durable event handoff", async () => {
    const clientEventId = "client-send-1";
    const optimistic: TimelineItem = {
      ...userItem(`optimistic:${clientEventId}`, "test message"),
      reconciliationKey: `user-message:${clientEventId}`,
      delivery: { state: "sending" },
    };
    const durable = {
      ...event(1),
      id: "durable-event-1",
      clientEventId,
      payload: { text: "test message" },
    };
    const r = await renderComponent(<MessageTimeline items={[optimistic]} />);
    await flush();

    const selector = `[data-og-group-key="user-message:${clientEventId}"]`;
    const rowBefore = r.container.querySelector(selector);
    expect(rowBefore).not.toBeNull();
    expect(r.container.textContent).toContain("test message");
    expect(r.container.textContent).not.toContain("Sending");
    expect(r.container.textContent).not.toContain("Queued");

    await r.rerender(
      <MessageTimeline items={[{ ...optimistic, delivery: { state: "queued" } }]} />,
    );
    expect(r.container.querySelector(selector)).toBe(rowBefore);
    expect(r.container.textContent).toContain("test message");
    expect(r.container.textContent).not.toContain("Queued");

    await r.rerender(<MessageTimeline events={[durable]} />);

    // The same mounted row moves from local delivery metadata to canonical
    // event identity. A remount would replay animate-og-enter at opacity 0 and
    // produce the visible blink reported by users.
    expect(r.container.querySelector(selector)).toBe(rowBefore);
    expect(r.container.textContent).toContain("test message");
    expect(r.container.textContent).not.toContain("Queued");
    await r.unmount();
  });

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

  test("consumer-owned cyclic payloads fail closed during settled-group comparison", async () => {
    const firstRaw: Record<string, unknown> = {};
    firstRaw.self = firstRaw;
    const first = { ...userItem("cyclic", "first value"), raw: firstRaw } as TimelineItem;
    const nextRaw: Record<string, unknown> = {};
    nextRaw.self = nextRaw;
    const next = { ...userItem("cyclic", "next value"), raw: nextRaw } as TimelineItem;

    const r = await renderComponent(<MessageTimeline items={[first]} />);
    await r.rerender(<MessageTimeline items={[next]} />);

    expect(r.container.textContent).toContain("next value");
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
    const renderCounts = new Map<string, number>();
    const renderMessageText = (text: string, item: TimelineItem) => {
      renderCounts.set(item.id, (renderCounts.get(item.id) ?? 0) + 1);
      return <span data-message-id={item.id}>{text}</span>;
    };
    const r = await renderComponent(
      <MessageTimeline items={initial} renderMessageText={renderMessageText} />,
    );
    await armOlderPrefetch(r.container);
    await drainFrames(frames);
    const u1Before = r.container.querySelector('[data-message-id="u1"]');
    expect(u1Before).not.toBeNull();
    const retainedRenderCounts = new Map(renderCounts);

    await r.rerender(
      <MessageTimeline
        items={[reasoningItem("activity-b", "activity B"), ...initial]}
        renderMessageText={renderMessageText}
      />,
    );

    expect(r.container.querySelector('[data-message-id="u1"]')).toBe(u1Before);
    expect(r.container.querySelector('[data-message-id="u14"]')).not.toBeNull();
    for (let sequence = 1; sequence <= 14; sequence += 1) {
      const id = `u${sequence}`;
      expect(renderCounts.get(id)).toBe(retainedRenderCounts.get(id));
    }
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
    const renderCounts = new Map<string, number>();
    const renderMessageText = (text: string, item: TimelineItem) => {
      renderCounts.set(item.id, (renderCounts.get(item.id) ?? 0) + 1);
      return <span data-message-id={item.id}>{text}</span>;
    };
    const r = await renderComponent(
      <MessageTimeline events={initial} renderMessageText={renderMessageText} />,
    );
    await armOlderPrefetch(r.container);
    await drainFrames(frames);
    const message3Before = r.container.querySelector('[data-message-id="evt-3"]');
    expect(message3Before).not.toBeNull();
    const retainedRenderCounts = new Map(renderCounts);

    await r.rerender(
      <MessageTimeline
        events={[reasoningDelta(1, "activity B"), ...initial]}
        renderMessageText={renderMessageText}
      />,
    );

    expect(r.container.querySelector('[data-message-id="evt-3"]')).toBe(message3Before);
    expect(r.container.querySelector('[data-message-id="evt-15"]')).not.toBeNull();
    for (let sequence = 3; sequence <= 15; sequence += 1) {
      const id = `evt-${sequence}`;
      expect(renderCounts.get(id)).toBe(retainedRenderCounts.get(id));
    }
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

  test("a reader-driven prepend on a compact tail does not snap back to the live tip", async () => {
    // Initial paint is a compact newest-suffix window. When that tail only
    // barely overflows, the reader can be at the top (loading older history)
    // while still within PIN_THRESHOLD of the live tip AFTER the prepend
    // restores their gap. A restore write looks like a scroll-down toward the
    // tip and used to re-pin, then the next commit snapped them to the bottom.
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const tail = manyEvents(8).map((evt) => event(evt.sequence + 12)); // 13..20
    const r = await renderComponent(
      <MessageTimeline events={tail} hasOlder loadingOlder={false} />,
    );
    await drainFrames(frames);
    const scroller = r.container.querySelector(".overflow-y-auto");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 440,
      tipHeight: 80,
      paddingBottom: 24,
      emitScrollOnWrite: true,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(distanceFromBottom(scroller)).toBe(0);

    await actRun(() => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();
    expect(r.container.textContent).toContain("Jump to latest");
    expect(scroller.scrollTop).toBe(0);

    await r.rerender(<MessageTimeline events={tail} hasOlder loadingOlder={false} />);
    await flush();
    expect(scroller.scrollTop).toBe(0);

    layout.setContentHeight(2_440);
    await r.rerender(<MessageTimeline events={manyEvents(20)} hasOlder loadingOlder={false} />);
    await flush();
    await drainFrames(frames);

    expect(r.container.textContent).toContain("Jump to latest");
    expect(scroller.scrollTop).toBe(2_000);
    expect(distanceFromBottom(scroller)).toBe(40);

    // An actual reader move toward the now-distant live tip still re-pins.
    await actRun(() => {
      scroller.scrollTop = 2_040;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flush();
    expect(distanceFromBottom(scroller)).toBeLessThan(2);
    expect(scroller.className).toContain("[overflow-anchor:none]");
    layout.restore();
    await r.unmount();
  });

  test("a sentinel-owned prepend restores an unpinned compact tail instead of snapping to the tip", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    let intersectionCallback: IntersectionObserverCallback = () => undefined;
    let intersectionObserver: IntersectionObserver | null = null;
    const observed: Element[] = [];
    globalThis.IntersectionObserver = class implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "400px 0px 0px 0px";
      readonly scrollMargin = "0px 0px 0px 0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
        intersectionObserver = this;
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

    const tail = manyEvents(8).map((evt) => event(evt.sequence + 12));
    const load = deferred<boolean>();
    const controlled = controlledOlderReceipt(load.promise);
    const onLoadOlder: OlderHistoryLoader = () => controlled.receipt;
    const r = await renderComponent(
      <PublicMessageTimeline events={tail} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 440,
      tipHeight: 80,
      paddingBottom: 24,
      emitScrollOnWrite: true,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    await readerScrollUp(scroller, 0);
    expect(r.container.textContent).toContain("Jump to latest");

    const target = observed.at(-1);
    if (!target) {
      throw new Error("expected observed top sentinel");
    }
    await actRun(() =>
      intersectionCallback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        intersectionObserver!,
      ),
    );
    expect(scroller.scrollTop).toBe(0);

    controlled.commit();
    layout.setContentHeight(2_440);
    await r.rerender(
      <PublicMessageTimeline events={manyEvents(20)} hasOlder onLoadOlder={onLoadOlder} />,
    );
    await flush();
    await drainFrames(frames);

    expect(r.container.textContent).toContain("Jump to latest");
    expect(scroller.scrollTop).toBe(2_000);
    expect(distanceFromBottom(scroller)).toBe(40);

    await actRun(() => load.resolve(true));
    await flush();
    layout.restore();
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
    // maxScroll while scrollTop still drops — layout tip-follow recovers;
    // scrollend must not treat that as a reader leave.
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
    // growth below). Production folds co-occur with a commit — layout
    // tip-follow recovers before scrollend settles at the tip.
    await actRun(() => {
      scroller.scrollTop = 1400;
      scroller.dispatchEvent(new Event("scroll"));
    });
    layout.setContentHeight(2000);
    await r.rerender(
      <MessageTimeline events={[...initial, agentDelta(21, "x")]} status="running" />,
    );
    await drainFrames(frames);
    await flush();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scrollend"));
    });
    await flush();
    expect(r.container.textContent).not.toContain("Jump to latest");
    expect(distanceFromBottom(scroller)).toBeLessThan(48);

    layout.restore();
    await r.unmount();
  });

  test("unarmed scroll settle away from tip unpins (Vimium / PageUp)", async () => {
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
    await drainFrames(frames);
    expect(r.container.textContent).not.toContain("Jump to latest");

    // Extension-style jump: no wheel, no pointer arm — scrollend decides leave.
    await actRun(() => {
      scroller.scrollTop = 200;
      layout.placeTipAt(120);
      scroller.dispatchEvent(new Event("scroll"));
    });
    // Stream token while leave is pending must not yank back to the tip.
    layout.setContentHeight(2400);
    await r.rerender(
      <MessageTimeline events={[...initial, agentDelta(21, "world")]} status="running" />,
    );
    await drainFrames(frames);
    await flush();
    expect(scroller.scrollTop).toBe(200);

    await actRun(() => {
      scroller.dispatchEvent(new Event("scrollend"));
    });
    await flush();
    expect(r.container.textContent).toContain("Jump to latest");
    expect(scroller.scrollTop).toBe(200);
    expect(distanceFromBottom(scroller)).toBeGreaterThan(48);

    layout.restore();
    await r.unmount();
  });

  test("unarmed scroll-away falls back to one rAF leave when scrollend is missing", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;
    setScrollEndSupportForTests(false);
    try {
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
      // Drain reveal/tip-follow frames so they cannot cancel the leave rAF.
      await drainFrames(frames);

      await actRun(() => {
        scroller.scrollTop = 200;
        layout.placeTipAt(120);
        scroller.dispatchEvent(new Event("scroll"));
      });
      await drainFrames(frames);
      await flush();
      expect(r.container.textContent).toContain("Jump to latest");

      layout.restore();
      await r.unmount();
    } finally {
      setScrollEndSupportForTests(null);
    }
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
      nested.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, deltaX: 0, bubbles: true }));
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

  test("requests older history when a collapsed tail underfills the scroller", async () => {
    let calls = 0;
    const items = [reasoningItem("collapsed-step", "collapsed step")];
    const r = await renderComponent(
      <MessageTimeline
        items={items}
        hasOlder
        onLoadOlder={() => {
          calls += 1;
        }}
      />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });

    // A child disclosure can shrink without re-rendering MessageTimeline, but
    // an ordinary parent commit must cover the initial underfilled window too.
    await r.rerender(
      <MessageTimeline
        items={items}
        status="idle"
        hasOlder
        onLoadOlder={() => {
          calls += 1;
        }}
      />,
    );
    await flush();

    expect(calls).toBe(1);

    // Unrelated commits against the same loaded window do not loop requests.
    await r.rerender(
      <MessageTimeline
        items={items}
        status="running"
        hasOlder
        onLoadOlder={() => {
          calls += 1;
        }}
      />,
    );
    await flush();
    expect(calls).toBe(1);

    // A newly prepended window may request the next page if it still does not
    // fill the viewport.
    await r.rerender(
      <MessageTimeline
        items={[reasoningItem("older-step", "older step"), ...items]}
        hasOlder
        onLoadOlder={() => {
          calls += 1;
        }}
      />,
    );
    await flush();
    expect(calls).toBe(2);
    await r.unmount();
  });

  test("StrictMode effect replay retains one pending underfill owner", async () => {
    const originalClientHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientHeight",
    );
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.hasAttribute("data-og-timeline-scroller") ? 400 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.hasAttribute("data-og-timeline-scroller") ? 240 : 0;
      },
    });

    const pending = deferred<boolean>();
    let calls = 0;
    let r: Awaited<ReturnType<typeof renderComponent>> | null = null;
    try {
      r = await renderComponent(
        <StrictMode>
          <MessageTimeline
            items={[reasoningItem("collapsed-step", "collapsed step")]}
            hasOlder
            onLoadOlder={() => {
              calls += 1;
              return pending.promise;
            }}
          />
        </StrictMode>,
      );
      await flush();
      expect(calls).toBe(1);

      await r.unmount();
      r = null;
      await actRun(() => pending.resolve(true));
      await flush();
      expect(calls).toBe(1);
    } finally {
      await r?.unmount();
      if (originalClientHeight) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
      }
      if (originalScrollHeight) {
        Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      }
    }
  });

  test("a delayed underfill prepend keeps the revealed live tail pinned immediately", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const load = deferred<boolean>();
    let calls = 0;
    const tail = [userItem("tail", "live tail")];
    const onLoadOlder = () => {
      calls += 1;
      return load.promise;
    };
    const r = await renderComponent(
      <MessageTimeline items={tail} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 240,
      tipHeight: 80,
      paddingBottom: 24,
    });

    await r.rerender(
      <MessageTimeline items={tail} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);
    expect(
      r.container.querySelector("[data-og-timeline-scroller]")?.getAttribute("style") ?? "",
    ).not.toContain("visibility");

    // The response lands after the two-frame reveal. Prepending grows a real
    // scroll range, but the reader is still pinned at the live tail. The first
    // painted commit must already be parked there rather than easing up from 0.
    layout.setContentHeight(1_600);
    await r.rerender(
      <MessageTimeline
        items={[userItem("older", "older history"), ...tail]}
        status="idle"
        hasOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );
    expect(distanceFromBottom(scroller)).toBeLessThan(2);
    expect(layout.tipBottomGap()).toBeLessThan(2);

    await actRun(() => load.resolve(true));
    await flush();
    expect(calls).toBe(1);
    layout.restore();
    await r.unmount();
  });

  test("final-page availability cannot strand a pinned underfill prepend", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const load = deferred<boolean>();
    let calls = 0;
    const tail = [userItem("tail", "live tail")];
    const onLoadOlder = () => {
      calls += 1;
      return load.promise;
    };
    const r = await renderComponent(
      <MessageTimeline items={tail} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 240,
      tipHeight: 80,
      paddingBottom: 24,
    });

    await r.rerender(
      <MessageTimeline items={tail} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);

    // A large streamed append creates real scroll range, but no reader leave
    // occurred, so the pinned viewport stays on the truthful live tip.
    const liveItems = [...tail, userItem("live-growth", "large live growth")];
    layout.setContentHeight(1_600);
    await r.rerender(
      <MessageTimeline items={liveItems} status="running" hasOlder onLoadOlder={onLoadOlder} />,
    );
    expect(distanceFromBottom(scroller)).toBeLessThan(2);

    // Final-page availability can commit before the fetched rows. It must not
    // release the pending owner that still identifies the delayed prepend.
    await r.rerender(
      <MessageTimeline
        items={liveItems}
        status="running"
        hasOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );
    expect(distanceFromBottom(scroller)).toBeLessThan(2);

    // Promise settlement still does not prove that the fetched rows committed.
    // Keep this exact owner through the settlement-only render as well.
    await actRun(() => load.resolve(true));
    await flush();
    expect(calls).toBe(1);
    expect(distanceFromBottom(scroller)).toBeLessThan(2);

    layout.setContentHeight(2_200);
    await r.rerender(
      <MessageTimeline
        items={[userItem("older", "older history"), ...liveItems]}
        status="running"
        hasOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );
    expect(distanceFromBottom(scroller)).toBeLessThan(2);
    expect(layout.tipBottomGap()).toBeLessThan(2);

    expect(calls).toBe(1);
    layout.restore();
    await r.unmount();
  });

  test("a pending underfill owner blocks top prefetch after live growth", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    let intersectionCallback: IntersectionObserverCallback = () => undefined;
    let intersectionObserver: IntersectionObserver | null = null;
    const observed: Element[] = [];
    globalThis.IntersectionObserver = class implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "400px 0px 0px 0px";
      readonly scrollMargin = "0px 0px 0px 0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
        intersectionObserver = this;
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

    const load = deferred<boolean>();
    let calls = 0;
    const tail = [reasoningItem("collapsed-step", "collapsed step")];
    const onLoadOlder = () => {
      calls += 1;
      return load.promise;
    };
    const r = await renderComponent(
      <MessageTimeline items={tail} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 240,
      tipHeight: 80,
      paddingBottom: 24,
    });

    await r.rerender(
      <MessageTimeline items={tail} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);

    const liveItems = [...tail, userItem("live-growth", "large live growth")];
    layout.setContentHeight(1_600);
    await r.rerender(
      <MessageTimeline items={liveItems} status="running" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await readerScrollUp(scroller, 0);
    expect(observed).toHaveLength(1);

    await actRun(() =>
      intersectionCallback(
        [{ isIntersecting: true, target: observed[0]! } as IntersectionObserverEntry],
        intersectionObserver!,
      ),
    );
    expect(calls).toBe(1);

    // The same overlap must still respect explicit reader ownership when the
    // older page lands: preserve the retained rows instead of snapping to tip.
    layout.setContentHeight(2_200);
    await r.rerender(
      <MessageTimeline
        items={[userItem("older", "older history"), ...liveItems]}
        hasOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );
    // Happy DOM reports the retained first item's content coordinate unchanged,
    // so the exact anchor correction is a no-op here. The browser regression
    // below verifies row/pixel preservation; this unit fence proves no tip snap.
    expect(scroller.scrollTop).toBe(0);
    expect(distanceFromBottom(scroller)).toBeGreaterThan(48);

    await actRun(() => load.resolve(true));
    await drainFrames(frames);
    expect(calls).toBe(1);
    layout.restore();
    await r.unmount();
  });

  test("forward oldest eviction retains the pending owner through retry, resize, and prepend", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    let resizeCallback: ResizeObserverCallback = () => undefined;
    let resizeObserver: ResizeObserver | null = null;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    let intersectionCallback: IntersectionObserverCallback = () => undefined;
    let intersectionObserver: IntersectionObserver | null = null;
    const observed: Element[] = [];
    globalThis.IntersectionObserver = class implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "400px 0px 0px 0px";
      readonly scrollMargin = "0px 0px 0px 0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
        intersectionObserver = this;
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

    const first = deferred<boolean>();
    const retryLoad = deferred<boolean>();
    const loads = [first, retryLoad];
    let calls = 0;
    const onLoadOlder = () => loads[calls++]!.promise;
    const initialItems = [
      reasoningItem("evicted-oldest", "oldest pending boundary"),
      userItem("retained-tail", "retained tail"),
    ];
    const r = await renderComponent(
      <MessageTimeline items={initialItems} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 240,
      tipHeight: 80,
      paddingBottom: 24,
    });

    await r.rerender(
      <MessageTimeline items={initialItems} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);

    // A bounded tail append evicts A's oldest row while retaining newer rows.
    // That forward boundary movement must rebase A, not release it.
    const firstEvictedWindow = [
      initialItems[1]!,
      userItem("live-tail-1", "live tail after first eviction"),
    ];
    layout.setContentHeight(1_600);
    await r.rerender(
      <MessageTimeline
        items={firstEvictedWindow}
        status="running"
        hasOlder
        onLoadOlder={onLoadOlder}
      />,
    );
    await readerScrollUp(scroller, 0);
    expect(observed).toHaveLength(1);
    await actRun(() =>
      intersectionCallback(
        [{ isIntersecting: true, target: observed[0]! } as IntersectionObserverEntry],
        intersectionObserver!,
      ),
    );
    await actRun(() => resizeCallback([], resizeObserver!));
    await drainFrames(frames);
    expect(calls).toBe(1);

    // A's rejection still belongs to the rebased window and authorizes one
    // explicit retry. Observer and resize churn cannot overlap that retry.
    await actRun(() => first.reject(new Error("transient evicted-window failure")));
    await flush();
    const retry = r.container.querySelector("[data-og-retry]");
    expect(retry).not.toBeNull();
    await actRun(() => resizeCallback([], resizeObserver!));
    await drainFrames(frames);
    expect(calls).toBe(1);

    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(2);
    await actRun(() => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      resizeCallback([], resizeObserver!);
    });
    await drainFrames(frames);
    expect(calls).toBe(2);

    // Return to the live tip, then let another bounded append evict the retry's
    // oldest row. Its delayed prepend must still use the rebased owner to keep
    // the truthful live tail parked in the commit that lands it.
    await actRun(() => {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll"));
    });
    const secondEvictedWindow = [
      firstEvictedWindow[1]!,
      userItem("live-tail-2", "live tail after second eviction"),
    ];
    layout.setContentHeight(1_900);
    await r.rerender(
      <MessageTimeline
        items={secondEvictedWindow}
        status="running"
        hasOlder
        onLoadOlder={onLoadOlder}
      />,
    );
    expect(distanceFromBottom(scroller)).toBeLessThan(2);

    layout.setContentHeight(2_300);
    await r.rerender(
      <MessageTimeline
        items={[userItem("older-page", "successful older retry"), ...secondEvictedWindow]}
        hasOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );
    expect(distanceFromBottom(scroller)).toBeLessThan(2);
    expect(layout.tipBottomGap()).toBeLessThan(2);

    await actRun(() => retryLoad.resolve(true));
    await flush();
    await actRun(() => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      resizeCallback([], resizeObserver!);
    });
    await drainFrames(frames);
    expect(calls).toBe(2);
    layout.restore();
    await r.unmount();
  });

  test("a committed full-window older replacement releases only its prior owner", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    let resizeCallback: ResizeObserverCallback = () => undefined;
    let resizeObserver: ResizeObserver | null = null;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const retryLoad = deferred<boolean>();
    const loads = [first, second, retryLoad];
    const receipts = loads.map((load) => controlledOlderReceipt(load.promise));
    let calls = 0;
    const onLoadOlder = () => receipts[calls++]!.receipt;
    const initialItems = [reasoningItem("full-window-tail", "collapsed live tail")];
    const r = await renderComponent(
      <MessageTimeline items={initialItems} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 240,
      tipHeight: 80,
      paddingBottom: 24,
    });

    await r.rerender(
      <MessageTimeline items={initialItems} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);

    // A bounded live-tail append can evict every item that existed when A
    // started. Without a committed older revision this is forward movement:
    // rebase A and keep both underfill and resize from issuing B.
    const liveReplacement = [userItem("bounded-live-replacement", "bounded live replacement")];
    await r.rerender(
      <MessageTimeline
        items={liveReplacement}
        status="running"
        hasOlder
        onLoadOlder={onLoadOlder}
      />,
    );
    await actRun(() => resizeCallback([], resizeObserver!));
    await drainFrames(frames);
    expect(calls).toBe(1);

    // A successful oldest-directed page can also replace the whole bounded
    // source with zero overlap. Marking A's exact owner as committed releases
    // it and permits exactly one follow-on underfill request for page B.
    const olderReplacement = [reasoningItem("full-window-older", "older collapsed page")];
    receipts[0]!.commit();
    await r.rerender(
      <MessageTimeline items={olderReplacement} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(2);

    // A settles after B adopted the new owner. Its stale callback cannot release
    // or convert B, and observer churn cannot duplicate the active request.
    await actRun(() => first.reject(new Error("late full-window page A settlement")));
    await flush();
    await actRun(() => resizeCallback([], resizeObserver!));
    await drainFrames(frames);
    expect(calls).toBe(2);
    expect(r.container.querySelector("[data-og-retry]")).toBeNull();

    await actRun(() => second.reject(new Error("transient page B failure")));
    await flush();
    const retry = r.container.querySelector("[data-og-retry]");
    expect(retry).not.toBeNull();
    await actRun(() => resizeCallback([], resizeObserver!));
    await drainFrames(frames);
    expect(calls).toBe(2);

    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(3);
    await actRun(() => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      resizeCallback([], resizeObserver!);
    });
    await drainFrames(frames);
    expect(calls).toBe(3);

    receipts[2]!.commit();
    await r.rerender(
      <MessageTimeline
        items={[reasoningItem("durable-start", "durable start")]}
        hasOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );
    await actRun(() => retryLoad.resolve(true));
    await flush();
    expect(calls).toBe(3);
    layout.restore();
    await r.unmount();
  });

  test("a forwarding wrapper preserves the reader seam for a zero-overlap older replacement", async () => {
    let intersectionCallback: IntersectionObserverCallback = () => undefined;
    let intersectionObserver: IntersectionObserver | null = null;
    const observed: Element[] = [];
    globalThis.IntersectionObserver = class implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "400px 0px 0px 0px";
      readonly scrollMargin = "0px 0px 0px 0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
        intersectionObserver = this;
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

    const load = deferred<boolean>();
    const controlled = controlledOlderReceipt(load.promise);
    let calls = 0;
    const loadOlder: OlderHistoryLoader = () => {
      calls += 1;
      return controlled.receipt;
    };
    const forwardingLoadOlder: OlderHistoryLoader = () => loadOlder();
    const initialItems = Array.from({ length: 40 }, (_, index) =>
      userItem(`tail-${index}`, `tail ${index}`),
    );
    const replacement = Array.from({ length: 40 }, (_, index) =>
      userItem(`older-${index}`, `older ${index}`),
    );
    const r = await renderComponent(
      <PublicMessageTimeline items={initialItems} hasOlder onLoadOlder={forwardingLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    const layout = mockScrollerLayout(scroller, {
      clientHeight: 400,
      contentHeight: 1_600,
      tipHeight: 80,
      paddingBottom: 24,
    });

    await r.rerender(
      <PublicMessageTimeline
        items={initialItems}
        status="idle"
        hasOlder
        onLoadOlder={forwardingLoadOlder}
      />,
    );
    await readerScrollUp(scroller, 80);
    const target = observed.at(-1);
    if (!target) {
      throw new Error("expected observed top sentinel");
    }
    await actRun(() =>
      intersectionCallback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        intersectionObserver!,
      ),
    );
    expect(calls).toBe(1);
    expect(scroller.scrollTop).toBe(80);

    controlled.commit();
    layout.setContentHeight(2_000);
    await r.rerender(
      <PublicMessageTimeline
        items={replacement}
        status="idle"
        hasOlder
        onLoadOlder={forwardingLoadOlder}
      />,
    );

    expect(scroller.scrollTop).toBe(1_600);
    expect(distanceFromBottom(scroller)).toBeLessThan(2);
    expect(r.container.textContent).toContain("Jump to latest");

    await actRun(() => load.resolve(true));
    await flush();
    expect(calls).toBe(1);
    layout.restore();
    await r.unmount();
  });

  test("a declined older load during newer navigation exposes one bounded retry", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    let resizeCallback: ResizeObserverCallback = () => undefined;
    let resizeObserver: ResizeObserver | null = null;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    const acceptedRetry = deferred<boolean>();
    let calls = 0;
    const onLoadOlder = () => {
      calls += 1;
      // Mirrors useSessionEvents.loadOlder() declining while loadNewer owns
      // the navigation lock. The later explicit retry is accepted.
      return calls === 1 ? Promise.resolve(false) : acceptedRetry.promise;
    };
    const items = [reasoningItem("collapsed-step", "collapsed step")];
    const r = await renderComponent(
      <MessageTimeline items={items} hasOlder loadingNewer onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 800 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });

    await r.rerender(
      <MessageTimeline
        items={items}
        status="idle"
        hasOlder
        loadingNewer
        onLoadOlder={onLoadOlder}
      />,
    );
    await drainFrames(frames);
    expect(calls).toBe(0);

    // A collapse removes the scroll range while newer pagination is active.
    // The first-party loader declines this older request with exact `false`.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });
    await actRun(() => resizeCallback([], resizeObserver!));
    await drainFrames(frames);
    await flush();
    const retry = r.container.querySelector("[data-og-retry]");
    expect(retry).not.toBeNull();
    expect(calls).toBe(1);

    // Observer churn cannot auto-repeat the declined request.
    await actRun(() => {
      resizeCallback([], resizeObserver!);
      resizeCallback([], resizeObserver!);
    });
    await drainFrames(frames);
    expect(calls).toBe(1);

    // Once the newer navigation settles, exactly one explicit retry may take
    // ownership. The exiting button and resize callbacks cannot overlap it.
    await r.rerender(
      <MessageTimeline items={items} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(2);
    await actRun(() => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      resizeCallback([], resizeObserver!);
      resizeCallback([], resizeObserver!);
    });
    await drainFrames(frames);
    expect(calls).toBe(2);

    await r.rerender(
      <MessageTimeline
        items={[reasoningItem("older-step", "older step"), ...items]}
        hasOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );
    await actRun(() => acceptedRetry.resolve(true));
    await flush();
    // AnimatePresence may retain the exiting button, but current ownership has
    // been revoked by boundary progress/final-page availability.
    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(2);
    await r.unmount();
  });

  test("a late underfill settlement cannot clear the newer window attempt", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    let resizeCallback: ResizeObserverCallback = () => undefined;
    let resizeObserver: ResizeObserver | null = null;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const retryLoad = deferred<boolean>();
    const loads = [first, second, retryLoad];
    let calls = 0;
    const onLoadOlder = () => loads[calls++]!.promise;
    const items = [reasoningItem("collapsed-step", "collapsed step")];
    const r = await renderComponent(
      <MessageTimeline items={items} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });

    await r.rerender(
      <MessageTimeline items={items} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);

    const nextItems = [reasoningItem("older-step", "older step"), ...items];
    await r.rerender(
      <MessageTimeline items={nextItems} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(2);

    await actRun(() => {
      resizeCallback([], resizeObserver!);
      resizeCallback([], resizeObserver!);
    });
    await drainFrames(frames);
    expect(calls).toBe(2);

    // Window B owns the active marker now. A's later settlement must not clear
    // it or let the post-settlement commit/observer issue another B request.
    await actRun(() => first.resolve(true));
    await flush();
    await drainFrames(frames);
    expect(calls).toBe(2);
    await actRun(() => resizeCallback([], resizeObserver!));
    await drainFrames(frames);
    expect(calls).toBe(2);

    // B still owns settlement and can expose exactly one bounded manual retry.
    await actRun(() => second.reject(new Error("transient page B failure")));
    await flush();
    const retry = r.container.querySelector("[data-og-retry]");
    expect(retry).not.toBeNull();
    await actRun(() => resizeCallback([], resizeObserver!));
    await drainFrames(frames);
    expect(calls).toBe(2);

    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(3);
    await actRun(() => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      resizeCallback([], resizeObserver!);
      resizeCallback([], resizeObserver!);
    });
    await drainFrames(frames);
    expect(calls).toBe(3);

    await r.rerender(
      <MessageTimeline items={nextItems} hasOlder={false} onLoadOlder={onLoadOlder} />,
    );
    await actRun(() => retryLoad.resolve(true));
    await flush();
    expect(calls).toBe(3);
    await r.unmount();
  });

  test("a fulfilled underfill load retains ownership until its non-final prepend commits", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    let resizeCallback: ResizeObserverCallback = () => undefined;
    let resizeObserver: ResizeObserver | null = null;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const retryLoad = deferred<boolean>();
    const loads = [first, second, retryLoad];
    let calls = 0;
    const onLoadOlder = () => loads[calls++]!.promise;
    const items = [reasoningItem("collapsed-step", "collapsed step")];
    const r = await renderComponent(
      <MessageTimeline items={items} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });

    await r.rerender(
      <MessageTimeline items={items} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);

    // Fulfillment can precede the parent commit that prepends a successful
    // non-final page. It is not a no-progress signal and must not expose a
    // same-boundary Retry, even when loadingOlder is omitted.
    await actRun(() => first.resolve(true));
    await flush();
    await actRun(() => {
      r.container
        .querySelector("[data-og-retry]")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      resizeCallback([], resizeObserver!);
    });
    await drainFrames(frames);
    expect(r.container.querySelector("[data-og-retry]")).toBeNull();
    expect(calls).toBe(1);

    // Boundary progress safely releases A and allows exactly one automatic
    // request for the still-underfilled non-final page B.
    const nextItems = [reasoningItem("older-step", "older step"), ...items];
    await r.rerender(
      <MessageTimeline items={nextItems} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(2);
    expect(r.container.querySelector("[data-og-retry]")).toBeNull();

    // Rejection is the explicit no-progress signal and authorizes one bounded
    // retry for B without allowing repeated clicks or resize callbacks to
    // overlap the replacement request.
    await actRun(() => second.reject(new Error("transient page B failure")));
    await flush();
    const retry = r.container.querySelector("[data-og-retry]");
    expect(retry).not.toBeNull();
    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(3);
    await actRun(() => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      resizeCallback([], resizeObserver!);
    });
    await drainFrames(frames);
    expect(calls).toBe(3);

    await r.rerender(
      <MessageTimeline items={nextItems} hasOlder={false} onLoadOlder={onLoadOlder} />,
    );
    await actRun(() => retryLoad.resolve(true));
    await flush();
    await r.unmount();
  });

  test("a committed same-first-id page releases a legacy void-wrapper owner", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const loads = [first, second];
    const commit: Array<() => void> = [];
    let calls = 0;
    const onLoadOlder: NonNullable<MessageTimelineProps["onLoadOlder"]> = () => {
      const load = loads[calls++]!;
      void createOlderHistoryLoadReceipt((markCommitted) => {
        commit.push(markCommitted);
        return load.promise;
      });
    };
    const items = [reasoningItem("collapsed-step", "collapsed step")];
    const r = await renderComponent(
      <PublicMessageTimeline items={items} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });

    await r.rerender(
      <PublicMessageTimeline items={items} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);

    // Fulfillment alone cannot release A before its accepted page commits.
    await actRun(() => first.resolve(true));
    await flush();
    expect(calls).toBe(1);
    expect(r.container.querySelector("[data-og-retry]")).toBeNull();

    // The raw page commits but projection merges into the existing first item.
    // Receipt capture must survive the void wrapper and release A even though
    // the first projected id remains unchanged.
    commit[0]!();
    const sameFirstPage = [{ ...items[0]!, text: "collapsed step with older detail" }];
    await r.rerender(
      <PublicMessageTimeline
        items={sameFirstPage}
        status="idle"
        hasOlder
        onLoadOlder={onLoadOlder}
      />,
    );
    await drainFrames(frames);
    expect(calls).toBe(2);
    expect(r.container.textContent).toContain("collapsed step with older detail");

    commit[1]!();
    await r.rerender(
      <PublicMessageTimeline
        items={[reasoningItem("visible-older-step", "visible older step"), ...sameFirstPage]}
        hasOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );
    await actRun(() => second.resolve(true));
    await flush();
    expect(r.container.textContent).toContain("visible older step");
    expect(calls).toBe(2);
    await r.unmount();
  });

  test("a committed projection-empty page releases ownership for later visible history", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const loads = [first, second];
    const commit: Array<() => void> = [];
    let calls = 0;
    const onLoadOlder: NonNullable<MessageTimelineProps["onLoadOlder"]> = () => {
      const load = loads[calls++]!;
      void createOlderHistoryLoadReceipt((markCommitted) => {
        commit.push(markCommitted);
        return load.promise;
      });
    };
    const r = await renderComponent(
      <PublicMessageTimeline items={[]} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });

    await r.rerender(
      <PublicMessageTimeline items={[]} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);

    await actRun(() => first.resolve(true));
    await flush();
    expect(calls).toBe(1);

    // A durable page consisting only of projection-omitted events publishes a
    // new raw window but leaves the projected items empty. Its exact commit
    // receipt must retire A so the still-underfilled page B can start.
    commit[0]!();
    await r.rerender(
      <PublicMessageTimeline items={[]} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(2);
    expect(r.container.querySelector("[data-og-retry]")).toBeNull();

    commit[1]!();
    await r.rerender(
      <PublicMessageTimeline
        items={[reasoningItem("visible-older-step", "visible older step")]}
        hasOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );
    await actRun(() => second.resolve(true));
    await flush();
    expect(r.container.textContent).toContain("visible older step");
    expect(calls).toBe(2);
    await r.unmount();
  });

  test("underfill rejection exposes one retry without observer loops or duplicates", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    let resizeCallback: ResizeObserverCallback = () => undefined;
    let resizeObserver: ResizeObserver | null = null;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    const first = deferred<boolean>();
    const second = deferred<boolean>();
    let calls = 0;
    const items = [reasoningItem("collapsed-step", "collapsed step")];
    const onLoadOlder = () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    };
    const r = await renderComponent(
      <MessageTimeline items={items} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });

    await r.rerender(
      <MessageTimeline items={items} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);

    // A streamed append changes the live tail, not the older-page boundary.
    // It must retain the pending owner even for hosts that do not synchronously
    // reflect loadingOlder or deduplicate their callback.
    const pendingAppendItems = [...items, userItem("live-tail-1", "live tail 1")];
    await r.rerender(
      <MessageTimeline
        items={pendingAppendItems}
        status="running"
        hasOlder
        onLoadOlder={onLoadOlder}
      />,
    );
    resizeCallback([], resizeObserver!);
    resizeCallback([], resizeObserver!);
    await drainFrames(frames);
    expect(calls).toBe(1);

    await actRun(() => first.reject(new Error("transient listEvents failure")));
    await flush();
    const retry = r.container.querySelector("[data-og-retry]");
    expect(retry).not.toBeNull();

    // A later streamed append must retain the rejected owner and its explicit
    // retry instead of silently starting a new request for the same oldest
    // boundary.
    const rejectedAppendItems = [...pendingAppendItems, userItem("live-tail-2", "live tail 2")];
    await r.rerender(
      <MessageTimeline
        items={rejectedAppendItems}
        status="idle"
        hasOlder
        onLoadOlder={onLoadOlder}
      />,
    );
    resizeCallback([], resizeObserver!);
    resizeCallback([], resizeObserver!);
    await drainFrames(frames);
    expect(calls).toBe(1);

    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(2);
    // AnimatePresence can retain the exiting DOM node. Even invoking that
    // stale handler again cannot create a duplicate concurrent request.
    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(2);
    resizeCallback([], resizeObserver!);
    resizeCallback([], resizeObserver!);
    await drainFrames(frames);
    expect(calls).toBe(2);

    await r.rerender(
      <MessageTimeline
        items={[reasoningItem("older-step", "older step"), ...rejectedAppendItems]}
        hasOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );
    await actRun(() => second.resolve(true));
    await flush();
    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(2);
    await r.unmount();
  });

  test("an empty rendered window keeps a rejected underfill attempt bounded", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    let resizeCallback: ResizeObserverCallback = () => undefined;
    let resizeObserver: ResizeObserver | null = null;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    const first = deferred<boolean>();
    const retryLoad = deferred<boolean>();
    let calls = 0;
    const onLoadOlder = () => {
      calls += 1;
      return calls === 1 ? first.promise : retryLoad.promise;
    };
    const r = await renderComponent(
      <MessageTimeline items={[]} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });

    await r.rerender(
      <MessageTimeline items={[]} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);

    await actRun(() => first.reject(new Error("transient empty-page failure")));
    await flush();
    const retry = r.container.querySelector("[data-og-retry]");
    expect(retry).not.toBeNull();
    expect(calls).toBe(1);

    await actRun(() => resizeCallback([], resizeObserver!));
    await drainFrames(frames);
    expect(calls).toBe(1);

    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(2);
    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(2);

    await actRun(() => retryLoad.resolve(true));
    await flush();
    await r.unmount();
  });

  test("an empty source releases its first successful page for follow-on underfill", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    let resizeCallback: ResizeObserverCallback = () => undefined;
    let resizeObserver: ResizeObserver | null = null;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    const first = deferred<boolean>();
    const second = deferred<boolean>();
    let calls = 0;
    const onLoadOlder = () => {
      calls += 1;
      return calls === 1 ? first.promise : second.promise;
    };
    const r = await renderComponent(
      <MessageTimeline items={[]} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });

    await r.rerender(
      <MessageTimeline items={[]} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);

    await actRun(() => first.resolve(true));
    await flush();
    const firstPage = [reasoningItem("first-page-step", "first page step")];
    await r.rerender(
      <MessageTimeline items={firstPage} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    resizeCallback([], resizeObserver!);
    resizeCallback([], resizeObserver!);
    await drainFrames(frames);
    expect(calls).toBe(2);

    await r.rerender(
      <MessageTimeline
        items={[reasoningItem("older-step", "older step"), ...firstPage]}
        status="idle"
        hasOlder={false}
        onLoadOlder={onLoadOlder}
      />,
    );
    await actRun(() => second.resolve(true));
    await flush();
    resizeCallback([], resizeObserver!);
    await drainFrames(frames);
    expect(calls).toBe(2);
    await r.unmount();
  });

  test("an explicit underfill retry remains actionable after resize creates a scroll range", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      frames.push(callback);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    let resizeCallback: ResizeObserverCallback = () => undefined;
    let resizeObserver: ResizeObserver | null = null;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    const first = deferred<boolean>();
    const retryLoad = deferred<boolean>();
    let calls = 0;
    const items = [reasoningItem("collapsed-step", "collapsed step")];
    const onLoadOlder = () => {
      calls += 1;
      return calls === 1 ? first.promise : retryLoad.promise;
    };
    const r = await renderComponent(
      <MessageTimeline items={items} hasOlder onLoadOlder={onLoadOlder} />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });

    await r.rerender(
      <MessageTimeline items={items} status="idle" hasOlder onLoadOlder={onLoadOlder} />,
    );
    await drainFrames(frames);
    expect(calls).toBe(1);

    await actRun(() => first.reject(new Error("transient listEvents failure")));
    await flush();
    const retry = r.container.querySelector("[data-og-retry]");
    expect(retry).not.toBeNull();

    // Geometry can become scrollable while this exact rejected window still
    // owns the retry. Resize must not auto-load, and the explicit retry must
    // remain usable instead of becoming a visible no-op.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 800 });
    await actRun(() => resizeCallback([], resizeObserver!));
    await drainFrames(frames);
    expect(scroller.scrollHeight - scroller.clientHeight).toBeGreaterThan(1);
    expect(calls).toBe(1);

    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(2);
    await actRun(() => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      resizeCallback([], resizeObserver!);
    });
    await drainFrames(frames);
    expect(calls).toBe(2);

    await r.rerender(<MessageTimeline items={items} hasOlder={false} onLoadOlder={onLoadOlder} />);
    await actRun(() => retryLoad.resolve(true));
    await flush();
    expect(calls).toBe(2);
    await r.unmount();
  });

  test("removing onLoadOlder removes a settled Retry affordance", async () => {
    const first = deferred<boolean>();
    const items = [reasoningItem("collapsed-step", "collapsed step")];
    const onJumpToStart = () => undefined;
    let calls = 0;
    const onLoadOlder = () => {
      calls += 1;
      return first.promise;
    };
    const r = await renderComponent(
      <MessageTimeline
        items={items}
        hasOlder
        onLoadOlder={onLoadOlder}
        onJumpToStart={onJumpToStart}
      />,
    );
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("expected timeline scroller");
    }
    await armOlderPrefetch(r.container);
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });

    await r.rerender(
      <MessageTimeline
        items={items}
        status="idle"
        hasOlder
        onLoadOlder={onLoadOlder}
        onJumpToStart={onJumpToStart}
      />,
    );
    expect(calls).toBe(1);
    await actRun(() => first.reject(new Error("transient listEvents failure")));
    await flush();
    const retry = r.container.querySelector("[data-og-retry]");
    expect(retry).not.toBeNull();

    await r.rerender(
      <MessageTimeline
        items={items}
        hasOlder
        onLoadOlder={undefined}
        onJumpToStart={onJumpToStart}
      />,
    );
    expect(r.container.querySelector("[data-og-retry]")).toBeNull();
    expect(r.container.textContent).not.toContain("Retry earlier activity");
    expect(r.container.querySelector("[data-og-jump-to-start]")).not.toBeNull();
    expect(r.container.textContent).toContain("Jump to start");
    // AnimatePresence may retain the captured node after the current render
    // revoked its loader. Its stale handler must consult current authorization.
    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
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

  test("a pending prefetch that settles after collapse exposes one bounded retry", async () => {
    let intersectionCallback: IntersectionObserverCallback = () => undefined;
    let intersectionObserver: IntersectionObserver | null = null;
    const observed: Element[] = [];
    globalThis.IntersectionObserver = class implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "400px 0px 0px 0px";
      readonly scrollMargin = "0px 0px 0px 0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
        intersectionObserver = this;
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

    let resizeCallback: ResizeObserverCallback = () => undefined;
    let resizeObserver: ResizeObserver | null = null;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    const first = deferred<boolean>();
    const retryLoad = deferred<boolean>();
    let calls = 0;
    const onLoadOlder = () => {
      calls += 1;
      return calls === 1 ? first.promise : retryLoad.promise;
    };
    const r = await renderComponent(
      <MessageTimeline events={manyEvents(4)} hasOlder onLoadOlder={onLoadOlder} />,
    );
    await armOlderPrefetch(r.container);
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    const target = observed.at(-1);
    if (!(scroller instanceof HTMLElement) || !target) {
      throw new Error("expected timeline scroller and top sentinel");
    }

    await actRun(() =>
      intersectionCallback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        intersectionObserver!,
      ),
    );
    expect(calls).toBe(1);

    // The viewport collapses while the ordinary prefetch owns the boundary.
    // Its ResizeObserver pass cannot start another load while that request is
    // pending, so settlement itself must expose the bounded retry transition.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });
    await actRun(() => resizeCallback([], resizeObserver!));
    expect(calls).toBe(1);

    await actRun(() => first.reject(new Error("transient prefetch failure")));
    await flush();
    const retry = r.container.querySelector("[data-og-retry]");
    expect(retry).not.toBeNull();
    expect(calls).toBe(1);

    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(2);
    await actRun(() => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      resizeCallback([], resizeObserver!);
    });
    expect(calls).toBe(2);

    await actRun(() => retryLoad.resolve(true));
    await flush();
    await r.unmount();
  });

  test("a declined prefetch promotes to retry when the viewport later collapses", async () => {
    let intersectionCallback: IntersectionObserverCallback = () => undefined;
    let intersectionObserver: IntersectionObserver | null = null;
    const observed: Element[] = [];
    globalThis.IntersectionObserver = class implements IntersectionObserver {
      readonly root: Element | Document | null = null;
      readonly rootMargin = "400px 0px 0px 0px";
      readonly scrollMargin = "0px 0px 0px 0px";
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
        intersectionObserver = this;
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

    let resizeCallback: ResizeObserverCallback = () => undefined;
    let resizeObserver: ResizeObserver | null = null;
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
        resizeObserver = this;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };

    const acceptedRetry = deferred<boolean>();
    let calls = 0;
    const onLoadOlder: OlderHistoryLoader = () =>
      createOlderHistoryLoadReceipt(() => {
        calls += 1;
        return calls === 1 ? false : acceptedRetry.promise;
      });
    const r = await renderComponent(
      <PublicMessageTimeline events={manyEvents(4)} hasOlder onLoadOlder={onLoadOlder} />,
    );
    await armOlderPrefetch(r.container);
    const scroller = r.container.querySelector("[data-og-timeline-scroller]");
    const target = observed.at(-1);
    if (!(scroller instanceof HTMLElement) || !target) {
      throw new Error("expected timeline scroller and top sentinel");
    }

    await actRun(() =>
      intersectionCallback(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        intersectionObserver!,
      ),
    );
    await flush();
    expect(calls).toBe(1);
    expect(r.container.querySelector("[data-og-retry]")).toBeNull();

    // The explicit decline has already settled while this ordinary prefetch
    // still owns a scrollable top-band visit. A later collapse must expose the
    // same owner as Retry instead of dispatching a second automatic request.
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 240 });
    await actRun(() => resizeCallback([], resizeObserver!));
    await flush();
    const retry = r.container.querySelector("[data-og-retry]");
    expect(retry).not.toBeNull();
    expect(calls).toBe(1);

    await actRun(() => {
      resizeCallback([], resizeObserver!);
      resizeCallback([], resizeObserver!);
    });
    expect(calls).toBe(1);

    await actRun(() => retry!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(calls).toBe(2);
    await actRun(() => acceptedRetry.resolve(true));
    await flush();
    await r.unmount();
  });

  test("synchronous cached prefetch progress with a void return releases its owner", async () => {
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
    function CachedHistoryHost() {
      const [events, setEvents] = useState(() => manyEvents(4));
      return (
        <MessageTimeline
          events={events}
          hasOlder
          onLoadOlder={() => {
            calls += 1;
            if (calls === 1) {
              flushSync(() => setEvents((current) => [event(0), ...current]));
              // A second synchronous host flush drains the boundary effect
              // before this legacy void callback returns.
              flushSync(() => undefined);
            }
          }}
        />
      );
    }

    const r = await renderComponent(<CachedHistoryHost />);
    await armOlderPrefetch(r.container);
    const notify = async (isIntersecting: boolean) => {
      const target = observed.at(-1);
      if (!target) {
        throw new Error("expected observed top sentinel");
      }
      await actRun(() =>
        callback([{ isIntersecting, target } as IntersectionObserverEntry], instance!),
      );
    };

    await notify(true);
    expect(calls).toBe(1);
    await flush();
    await notify(false);
    await notify(true);
    expect(calls).toBe(2);
    await r.unmount();
  });

  test("a settled prefetch yields to an underfilled progressed window", async () => {
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
    function CachedUnderfillHost() {
      const [events, setEvents] = useState(() => manyEvents(4));
      return (
        <MessageTimeline
          events={events}
          hasOlder
          onLoadOlder={() => {
            calls += 1;
            if (calls === 1) {
              const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
              if (!scroller) {
                throw new Error("expected timeline scroller");
              }
              Object.defineProperty(scroller, "scrollHeight", {
                configurable: true,
                value: 240,
              });
              flushSync(() => setEvents([event(0)]));
              flushSync(() => undefined);
            }
          }}
        />
      );
    }

    const r = await renderComponent(<CachedUnderfillHost />);
    await armOlderPrefetch(r.container);
    const target = observed.at(-1);
    if (!target) {
      throw new Error("expected observed top sentinel");
    }
    await actRun(() =>
      callback([{ isIntersecting: true, target } as IntersectionObserverEntry], instance!),
    );
    await flush();
    expect(calls).toBe(2);
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

  test("pinned growth does not unpin without a reader scroll-up", async () => {
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

    // Content grew under a pinned reader. A scroll echo must keep the pin and
    // track the truthful tip — not show Jump to latest.
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

  test("pinned appends stay at the tip; a later scroll-up releases the camera", async () => {
    // Pinned growth stays on the truthful tip. A later wheel-up still unpins —
    // programmatic scroll echoes must not swallow that intent.
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

    // Tip growth remains visible immediately; draining frames is a no-op for
    // new growth but still covers any pre-existing camera work.
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

  /**
   * Park the timeline pinned at the tip with camera baselines armed against
   * the mocked geometry (an extra commit runs driveFollow → tipFollowStep,
   * which adopts lastHeight/lastClientHeight).
   */
  async function renderPinnedAtTip(frames: FrameRequestCallback[], quantize = false) {
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
      quantize,
    });
    layout.syncTipAtBottom();
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    // Arm the camera baselines against the mocked metrics.
    await r.rerender(<MessageTimeline events={initial} status="idle" />);
    await drainFrames(frames);
    expect(distanceFromBottom(scroller)).toBe(0);
    return { r, scroller, layout, initial };
  }

  async function runFrames(frames: FrameRequestCallback[], count: number): Promise<void> {
    for (let i = 0; i < count && frames.length > 0; i += 1) {
      await runNextFrame(frames);
    }
  }

  test("large pinned catch-up offers an immediate jump to the live tip", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const { r, scroller, layout, initial } = await renderPinnedAtTip(frames);

    // Returning to a long-lived surface may expose pre-existing camera debt
    // (for example, from a prior hot follow frame). Keep the smooth follower,
    // but let the reader skip the remaining travel immediately.
    scroller.scrollTop -= 320;
    await r.rerender(<MessageTimeline events={initial} status="running" />);
    await flush();

    expect(distanceFromBottom(scroller)).toBeGreaterThan(240);
    const button = r.container.querySelector<HTMLButtonElement>("[data-og-jump-to-latest]");
    expect(button?.textContent).toContain("Jump to latest");

    await actRun(() => button?.click());
    expect(distanceFromBottom(scroller)).toBe(0);

    await drainFrames(frames);
    layout.restore();
    await r.unmount();
  });

  test("same-commit settle-fold + chrome dock glues BOTH shrinks in one write", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const { r, scroller, layout, initial } = await renderPinnedAtTip(frames);

    // The "turn blocked" moment: an activity cluster settle-folds (−30 content)
    // on the same frame SessionChrome docks (−60 viewport). The shrink
    // compensation must not adopt the shrunk clientHeight without gluing it.
    layout.setContentHeight(1970);
    layout.setClientHeight(340);
    await r.rerender(<MessageTimeline events={initial} status="running" />);

    // Same-commit: content glue (1600−30) + viewport glue (+60) → new tip 1630.
    expect(scroller.scrollTop).toBe(1630);
    expect(distanceFromBottom(scroller)).toBe(0);
    await drainFrames(frames);
    expect(distanceFromBottom(scroller)).toBe(0);
    layout.restore();
    await r.unmount();
  });

  test("SessionChrome dock via ResizeObserver glues to the tip on the next frame", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const resizeObserverBeforeTest = globalThis.ResizeObserver;
    const resizeCallbacks: ResizeObserverCallback[] = [];
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { r, scroller, layout } = await renderPinnedAtTip(frames);

      // Chrome docks with no commit and no scroll event — only the RO fires.
      layout.setClientHeight(340);
      await actRun(() => {
        for (const callback of resizeCallbacks) {
          callback([], {} as ResizeObserver);
        }
      });
      await runFrames(frames, 1);
      // Tip-glue, not cold soft-settle: at the new tip within one frame.
      expect(scroller.scrollTop).toBe(1660);
      expect(distanceFromBottom(scroller)).toBe(0);
      layout.restore();
      await r.unmount();
    } finally {
      globalThis.ResizeObserver = resizeObserverBeforeTest;
    }
  });

  test("camera-write scroll echoes must not eat growth heat (nested tools keep the tip in reach)", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const { r, scroller, layout, initial } = await renderPinnedAtTip(frames);

    // Kick the camera with one committed token so it is writing scrollTop.
    layout.setContentHeight(2012);
    await r.rerender(
      <MessageTimeline events={[...initial, agentDelta(21, "x")]} status="running" />,
    );

    // Nested tool pills grow via motion/Radix height animation — no commit,
    // only late layout. The browser fires the echo of the camera's previous
    // write BEFORE the next rAF, so each frame is: grow → echo → step.
    // Adopting lastHeight on the echo starved the step of every growth frame:
    // the hot window lapsed mid-stream and the cold settle ceiling let the
    // debt ratchet away under the chrome.
    for (let i = 0; i < 30; i += 1) {
      layout.setContentHeight(2012 + (i + 1) * 12);
      await actRun(() => {
        scroller.dispatchEvent(new Event("scroll"));
      });
      if (frames.length === 0) {
        // Camera parked between bursts: any late-layout growth re-drives via
        // RO in production; model that with a commit.
        await r.rerender(
          <MessageTimeline
            events={[...initial, agentDelta(21, "x".repeat(i + 2))]}
            status="running"
          />,
        );
      }
      await runFrames(frames, 1);
    }

    // The stream pauses; a HOT camera closes the remaining debt quickly.
    await runFrames(frames, 40);
    expect(distanceFromBottom(scroller)).toBeLessThan(48);
    await drainFrames(frames);
    expect(distanceFromBottom(scroller)).toBe(0);
    layout.restore();
    await r.unmount();
  });

  test("quantizing scroller: bursty growth then quiet converges to the exact tip (no sub-pixel park)", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    // Real browsers floor sub-pixel scrollTop writes. A nested tool burst
    // lands (one commit, +88px), the stream pauses, and the settle-phase
    // camera slows below 1px/frame: without a fractional camera every write
    // is discarded, the rAF loop spins forever, and the tip parks ~20-50px
    // under SessionChrome while still pinned (no Jump-to-latest).
    const { r, scroller, layout, initial } = await renderPinnedAtTip(frames, true);

    layout.setContentHeight(2088);
    await r.rerender(
      <MessageTimeline events={[...initial, agentDelta(21, "burst")]} status="running" />,
    );

    await drainFrames(frames);
    expect(distanceFromBottom(scroller)).toBe(0);
    layout.restore();
    await r.unmount();
  });

  test("near-bottom reader jiggle must not eat growth heat inside the pin band", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const { r, scroller, layout, initial } = await renderPinnedAtTip(frames);

    // Content grows 40px (inside PIN_THRESHOLD) with the camera idle, then a
    // non-programmatic scroll event lands near-bottom (reader jiggle / echo of
    // an outside write). The quiet path must not adopt the unseen growth.
    layout.setContentHeight(2040);
    await actRun(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(distanceFromBottom(scroller)).toBe(40);

    // The next commit's driveFollow must still see the 40px as fresh growth
    // (hot, line-τ) — not settle cold at ~42px/s and park inside the band.
    await r.rerender(<MessageTimeline events={initial} status="running" />);
    await runFrames(frames, 25);
    expect(distanceFromBottom(scroller)).toBeLessThan(8);
    await drainFrames(frames);
    expect(distanceFromBottom(scroller)).toBe(0);
    layout.restore();
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
    /** Snap scrollTop writes to whole pixels like a real browser at dpr 1. */
    quantize?: boolean;
    /**
     * Chromium fires `scroll` from programmatic `scrollTop` writes. Opt in so
     * restore/camera assignments exercise the same echo path as the browser.
     */
    emitScrollOnWrite?: boolean;
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
      const clamped = Math.max(0, Math.min(max, value));
      const next = options.quantize ? Math.floor(clamped) : clamped;
      if (next === currentScrollTop) {
        return;
      }
      currentScrollTop = next;
      if (options.emitScrollOnWrite) {
        scroller.dispatchEvent(new Event("scroll"));
      }
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
    /** SessionChrome/composer dock: the scroller viewport shrinks in place. */
    setClientHeight(next: number) {
      options.clientHeight = next;
    },
    syncTipAtBottom() {
      currentScrollTop = Math.max(0, contentHeight - options.clientHeight);
      tipTopInScroller = contentHeight - options.paddingBottom - options.tipHeight;
    },
    placeTipAt(topInScroller: number) {
      tipTopInScroller = topInScroller;
    },
    tipBottomGap() {
      if (!findTip()) {
        throw new Error("expected tip element");
      }
      // The helper owns this synthetic layout. Derive both edges from that
      // state so an unrelated test's process-global DOM rect stub cannot make
      // a correctly parked camera appear one padding-width short of the tip.
      const tipBottom = scrollerTop + tipTopInScroller - currentScrollTop + options.tipHeight;
      const viewportBottom = scrollerTop + options.clientHeight - options.paddingBottom;
      return Math.abs(tipBottom - viewportBottom);
    },
    restore() {
      Element.prototype.getBoundingClientRect = scrollerElementRect;
      window.getComputedStyle = originalStyle;
    },
  };
}
