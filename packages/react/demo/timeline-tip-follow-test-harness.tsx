/* ----------------------------------------------------------------------------
   Tip-follow browser regression harness.

   Mirrors the session route layout: the timeline scroller is a flex-1 child of
   a fixed-height column, with an IN-FLOW chrome dock (SessionChrome stand-in)
   and composer below it. Docking chrome shrinks the scroller clientHeight, a
   live activity cluster grows at the tip both via React commits (new tool
   rows) and via commit-free late layout (motion/Radix-style height animation
   modeled with direct style mutation). The e2e drives real streaming cadence
   and asserts pinned follow converges to the exact tip when the stream pauses.
   -------------------------------------------------------------------------- */
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { MessageTimeline, type TimelineItem } from "../src/index";
import "./styles.css";

type TipFollowHarness = {
  /** Append one tool row inside the live cluster (a React commit). */
  appendToolRow: () => void;
  /** Grow the nested no-commit block by px (motion/Radix-style late layout). */
  lateGrow: (px: number) => void;
  /** Mount / resize the in-flow chrome dock below the scroller. */
  dockChrome: (px: number) => void;
  undockChrome: () => void;
  /** Grow the composer (multiline draft) — also shrinks the scroller. */
  setComposerHeight: (px: number) => void;
  scroller: () => HTMLElement;
  metrics: () => {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    maxScroll: number;
    distanceFromTip: number;
    pinned: boolean;
  };
};

declare global {
  interface Window {
    tipFollowHarness?: TipFollowHarness;
  }
}

function userItem(sequence: number): TimelineItem {
  return {
    kind: "user-message",
    id: `row-${sequence}`,
    text: `Timeline row ${sequence}`,
    resources: [],
    tools: [],
    occurredAt: new Date(1_750_000_000_000 + sequence).toISOString(),
  };
}

function toolItem(sequence: number, status: "running" | "complete"): TimelineItem {
  return {
    kind: "tool-call",
    id: `tool-${sequence}`,
    turnId: "turn-live",
    callId: `call-${sequence}`,
    name: "shell",
    arguments: { command: [`step ${sequence}`] },
    output: status === "complete" ? { output: `output for step ${sequence}` } : undefined,
    raw: undefined,
    status,
    occurredAt: new Date(1_750_000_100_000 + sequence).toISOString(),
  };
}

function streamedItem(text: string): TimelineItem {
  return {
    kind: "agent-message",
    id: "stream-1",
    turnId: "turn-live",
    text,
    streaming: true,
    occurredAt: new Date(1_750_000_200_000).toISOString(),
  };
}

function Harness() {
  const [toolCount, setToolCount] = useState(1);
  const [chromeHeight, setChromeHeight] = useState<number | null>(null);
  const [composerHeight, setComposerHeightState] = useState(88);
  // Commit-free growth target: a block nested in the streamed tip message.
  const lateGrowRef = useRef<HTMLDivElement | null>(null);
  const lateHeightRef = useRef(24);

  const items: TimelineItem[] = [
    ...Array.from({ length: 24 }, (_, index) => userItem(index + 1)),
    ...Array.from({ length: toolCount }, (_, index) =>
      toolItem(index + 1, index + 1 < toolCount ? "complete" : "running"),
    ),
    streamedItem("Streaming tip message with a nested late-layout block below."),
  ];

  const scroller = useCallback(() => {
    const node = document.querySelector<HTMLElement>("[data-tip-follow] .og-root > div");
    if (!node) throw new Error("timeline scroller is unavailable");
    return node;
  }, []);

  useEffect(() => {
    window.tipFollowHarness = {
      appendToolRow: () => flushSync(() => setToolCount((current) => current + 1)),
      lateGrow: (px: number) => {
        // No commit, no scroll event — exactly what a motion/Radix height
        // animation frame does to the scroller.
        lateHeightRef.current += px;
        const block = lateGrowRef.current;
        if (block) {
          block.style.height = `${lateHeightRef.current}px`;
        }
      },
      dockChrome: (px: number) => flushSync(() => setChromeHeight(px)),
      undockChrome: () => flushSync(() => setChromeHeight(null)),
      setComposerHeight: (px: number) => flushSync(() => setComposerHeightState(px)),
      scroller,
      metrics: () => {
        const node = scroller();
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        return {
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          maxScroll,
          distanceFromTip: maxScroll - node.scrollTop,
          pinned: getComputedStyle(node).overflowAnchor === "none",
        };
      },
    };
    return () => {
      delete window.tipFollowHarness;
    };
  }, [scroller]);

  return (
    <main style={{ padding: 32, height: "100%" }} data-og-theme="light">
      <section className="tip-follow-app" data-tip-follow>
        <div className="tip-follow-timeline">
          <MessageTimeline
            className="tip-follow-shell"
            items={items}
            status="running"
            renderMessageText={(text, timelineItem) => (
              <div data-timeline-row={timelineItem.id}>
                {text}
                {timelineItem.id === "stream-1" ? (
                  <div
                    ref={lateGrowRef}
                    data-late-grow
                    style={{ height: 24, background: "#eef2f7", borderRadius: 8 }}
                  />
                ) : null}
              </div>
            )}
          />
        </div>
        {chromeHeight !== null ? (
          <div className="tip-follow-chrome" data-chrome style={{ height: chromeHeight }}>
            1 agent · 1 paused
          </div>
        ) : null}
        <div className="tip-follow-composer" data-composer style={{ height: composerHeight }}>
          Send a follow-up…
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
