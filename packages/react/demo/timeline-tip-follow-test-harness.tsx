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

import { MessageTimeline, type TimelineItem } from "@opengeni/react";
import "./styles.css";

type TipFollowHarness = {
  /** Append visible text to the live message (a token/markdown React commit). */
  appendStreamText: (text: string) => void;
  /** Append one tool row inside the live cluster (a React commit). */
  appendToolRow: () => void;
  /** Grow the nested no-commit block by px (motion/Radix-style late layout). */
  lateGrow: (px: number) => void;
  /** Grow rows above an unpinned reader (font/image-style late reflow). */
  growRowsAbove: (px: number) => void;
  /** Prepend durable rows through the real timeline commit path. */
  prepend: (count: number) => void;
  /** Mount / resize the in-flow chrome dock below the scroller. */
  dockChrome: (px: number) => void;
  undockChrome: () => void;
  /** Grow the composer (multiline draft) — also shrinks the scroller. */
  setComposerHeight: (px: number) => void;
  /** Resize the actual timeline shell to force responsive row reflow. */
  setShellSize: (width: number, height: number) => void;
  scroller: () => HTMLElement;
  metrics: () => {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    maxScroll: number;
    distanceFromTip: number;
    pinned: boolean;
    visible: { id: string | null; top: number | null };
    horizontalOverflow: number;
    renderedRows: number;
  };
  operations: () => readonly string[];
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
  const [oldestSequence, setOldestSequence] = useState(1);
  const [toolCount, setToolCount] = useState(1);
  const [streamText, setStreamText] = useState(
    "Streaming tip message with a nested late-layout block below.",
  );
  const [rowsAboveGrowth, setRowsAboveGrowth] = useState(0);
  const [chromeHeight, setChromeHeight] = useState<number | null>(null);
  const [composerHeight, setComposerHeightState] = useState(88);
  const [shellSize, setShellSize] = useState({ width: 900, height: 680 });
  // Commit-free growth target: a block nested in the streamed tip message.
  const lateGrowRef = useRef<HTMLDivElement | null>(null);
  const lateHeightRef = useRef(24);
  const operationsRef = useRef<string[]>([]);

  const record = useCallback((operation: string) => {
    operationsRef.current = [...operationsRef.current.slice(-199), operation];
  }, []);

  const items: TimelineItem[] = [
    ...Array.from({ length: 25 - oldestSequence }, (_, index) => userItem(oldestSequence + index)),
    ...Array.from({ length: toolCount }, (_, index) =>
      toolItem(index + 1, index + 1 < toolCount ? "complete" : "running"),
    ),
    streamedItem(streamText),
  ];

  const scroller = useCallback(() => {
    const node = document.querySelector<HTMLElement>("[data-tip-follow] .og-root > div");
    if (!node) throw new Error("timeline scroller is unavailable");
    return node;
  }, []);

  useEffect(() => {
    window.tipFollowHarness = {
      appendStreamText: (text: string) => {
        record(`append-stream:${text.length}`);
        flushSync(() => setStreamText((current) => current + text));
      },
      appendToolRow: () => {
        record("append-tool");
        flushSync(() => setToolCount((current) => current + 1));
      },
      lateGrow: (px: number) => {
        record(`late-grow:${px}`);
        // No commit, no scroll event — exactly what a motion/Radix height
        // animation frame does to the scroller.
        lateHeightRef.current = Math.max(1, lateHeightRef.current + px);
        const block = lateGrowRef.current;
        if (block) {
          block.style.height = `${lateHeightRef.current}px`;
        }
      },
      growRowsAbove: (px: number) => {
        record(`grow-above:${px}`);
        flushSync(() => setRowsAboveGrowth((current) => Math.max(0, current + px)));
      },
      prepend: (count: number) => {
        record(`prepend:${count}`);
        flushSync(() => setOldestSequence((current) => current - Math.max(0, count)));
      },
      dockChrome: (px: number) => {
        record(`dock-chrome:${px}`);
        flushSync(() => setChromeHeight(px));
      },
      undockChrome: () => {
        record("undock-chrome");
        flushSync(() => setChromeHeight(null));
      },
      setComposerHeight: (px: number) => {
        record(`composer:${px}`);
        flushSync(() => setComposerHeightState(px));
      },
      setShellSize: (width: number, height: number) => {
        record(`shell:${width}x${height}`);
        flushSync(() => setShellSize({ width, height }));
      },
      scroller,
      metrics: () => {
        const node = scroller();
        const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
        const containerTop = node.getBoundingClientRect().top;
        const visibleRow = [...document.querySelectorAll<HTMLElement>("[data-timeline-row]")].find(
          (candidate) => candidate.getBoundingClientRect().bottom > containerTop + 1,
        );
        return {
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          maxScroll,
          distanceFromTip: maxScroll - node.scrollTop,
          pinned: getComputedStyle(node).overflowAnchor === "none",
          visible: {
            id: visibleRow?.dataset.timelineRow ?? null,
            top: visibleRow ? visibleRow.getBoundingClientRect().top - containerTop : null,
          },
          horizontalOverflow: Math.max(
            0,
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
          renderedRows: document.querySelectorAll("[data-timeline-row]").length,
        };
      },
      operations: () => operationsRef.current,
    };
    return () => {
      delete window.tipFollowHarness;
    };
  }, [record, scroller]);

  return (
    <main style={{ padding: 32, height: "100%" }} data-og-theme="light">
      <section
        className="tip-follow-app"
        data-tip-follow
        style={{ width: shellSize.width, height: shellSize.height }}
      >
        <div className="tip-follow-timeline">
          <MessageTimeline
            className="tip-follow-shell"
            items={items}
            status="running"
            renderMessageText={(text, timelineItem) => (
              <div
                data-timeline-row={timelineItem.id}
                style={{
                  minHeight:
                    timelineItem.id.startsWith("row-") &&
                    Number(timelineItem.id.slice("row-".length)) <= 10
                      ? 34 + rowsAboveGrowth
                      : 34,
                }}
              >
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
