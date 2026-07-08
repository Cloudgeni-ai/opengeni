import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { MessageTimeline } from "../src";
import { registerDom, renderComponent, flush } from "./render-hook";

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

const originalIntersectionObserver = globalThis.IntersectionObserver;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

afterEach(() => {
  globalThis.IntersectionObserver = originalIntersectionObserver;
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

describe("MessageTimeline pagination affordances", () => {
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
    callback(
      [{ isIntersecting: true, target: observed[0]! } as IntersectionObserverEntry],
      instance!,
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

    for (const frame of frames.splice(0)) {
      frame(performance.now());
    }
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
