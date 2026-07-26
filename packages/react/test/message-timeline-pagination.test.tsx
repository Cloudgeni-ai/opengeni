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

const originalIntersectionObserver = globalThis.IntersectionObserver;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

afterEach(() => {
  globalThis.IntersectionObserver = originalIntersectionObserver;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

describe("MessageTimeline pagination affordances", () => {
  test("bulk tails mount newest-first across frames and finish in exact order", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const initial = [event(1), event(2), event(3), event(4)];
    const r = await renderComponent(<MessageTimeline events={initial} hasOlder />);

    expect(r.container.textContent).toContain("message 4");
    expect(r.container.textContent).not.toContain("message 3");
    expect(r.container.querySelector(".animate-og-enter")).toBeNull();
    expect(r.container.querySelector("[data-og-top-sentinel]")).toBeNull();

    await runNextFrame(frames);
    expect(r.container.textContent).toContain("message 3");
    expect(r.container.textContent).not.toContain("message 2");
    expect(r.container.querySelector(".animate-og-enter")).toBeNull();

    await drainFrames(frames);
    const text = r.container.textContent ?? "";
    const positions = [1, 2, 3, 4].map((sequence) => text.indexOf(`message ${sequence}`));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    for (const sequence of [1, 2, 3, 4]) {
      expect(text.match(new RegExp(`message ${sequence}`, "g"))).toHaveLength(1);
    }
    expect(r.container.querySelector(".animate-og-enter")).toBeNull();
    expect(r.container.querySelector("[data-og-top-sentinel]")).not.toBeNull();
    await r.unmount();
  });

  test("live appends stay immediate while the older prefix is still mounting", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const initial = [event(1), event(2), event(3), event(4)];
    const r = await renderComponent(<MessageTimeline events={initial} />);
    await r.rerender(<MessageTimeline events={[...initial, event(5)]} />);

    expect(r.container.textContent).toContain("message 4");
    expect(r.container.textContent).toContain("message 5");
    expect(r.container.textContent).not.toContain("message 3");

    await drainFrames(frames);
    const text = r.container.textContent ?? "";
    for (const sequence of [1, 2, 3, 4, 5]) {
      expect(text.match(new RegExp(`message ${sequence}`, "g"))).toHaveLength(1);
    }
    expect(text.indexOf("message 4")).toBeLessThan(text.indexOf("message 5"));
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

  test("same-key streaming updates do not restart older-group hydration", async () => {
    const frames: FrameRequestCallback[] = [];
    let cancellations = 0;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => {
      cancellations += 1;
    };

    const initial = [event(1), event(2), event(3), agentDelta(4, "hello ")];
    const r = await renderComponent(<MessageTimeline events={initial} />);
    expect(r.container.textContent).toContain("hello");
    expect(r.container.textContent).not.toContain("message 3");

    await r.rerender(<MessageTimeline events={[...initial, agentDelta(5, "world")]} />);
    expect(r.container.textContent).toContain("hello world");
    expect(cancellations).toBe(0);

    await runNextFrame(frames);
    expect(r.container.textContent).toContain("message 3");
    await drainFrames(frames);
    await r.unmount();
  });

  test("a prepended page keeps mounted rows stable and reveals only its new prefix", async () => {
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      frames.push(cb);
      return frames.length;
    };
    globalThis.cancelAnimationFrame = () => undefined;

    const r = await renderComponent(<MessageTimeline events={[event(3), event(4)]} />);
    await drainFrames(frames);
    await r.rerender(<MessageTimeline events={[event(1), event(2), event(3), event(4)]} />);

    expect(r.container.textContent).toContain("message 3");
    expect(r.container.textContent).toContain("message 4");
    expect(r.container.textContent).not.toContain("message 2");

    await runNextFrame(frames);
    expect(r.container.textContent).toContain("message 2");
    expect(r.container.textContent).not.toContain("message 1");
    await drainFrames(frames);

    const text = r.container.textContent ?? "";
    expect(text.indexOf("message 1")).toBeLessThan(text.indexOf("message 2"));
    expect(text.indexOf("message 2")).toBeLessThan(text.indexOf("message 3"));
    expect(text.indexOf("message 3")).toBeLessThan(text.indexOf("message 4"));
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
      userItem("u1", "message U1"),
      userItem("u2", "message U2"),
      userItem("u3", "message U3"),
    ];
    const renderMessageText = (text: string, item: TimelineItem) => (
      <span data-message-id={item.id}>{text}</span>
    );
    const r = await renderComponent(
      <MessageTimeline items={initial} renderMessageText={renderMessageText} />,
    );
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
    expect(r.container.querySelector('[data-message-id="u2"]')).not.toBeNull();
    expect(r.container.querySelector('[data-message-id="u3"]')).not.toBeNull();
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
      reasoningDelta(4, "activity C"),
      event(5),
      reasoningDelta(6, "activity D"),
      event(7),
    ];
    const renderMessageText = (text: string, item: TimelineItem) => (
      <span data-message-id={item.id}>{text}</span>
    );
    const r = await renderComponent(
      <MessageTimeline events={initial} renderMessageText={renderMessageText} />,
    );
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
    expect(r.container.querySelector('[data-message-id="evt-5"]')).not.toBeNull();
    expect(r.container.querySelector('[data-message-id="evt-7"]')).not.toBeNull();
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

  test("top sentinel calls onLoadOlder when it intersects", async () => {
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
        events={[event(1)]}
        hasOlder
        onLoadOlder={() => {
          calls += 1;
        }}
      />,
    );
    await flush();
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
