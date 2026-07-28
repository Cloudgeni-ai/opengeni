import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { MessageTimeline, type TimelineItem } from "../src/index";
import "./styles.css";

type VisibleRow = { id: string | null; top: number | null };
type TimelineScrollHarness = {
  append: () => void;
  growRowsAbove: () => void;
  stream: () => void;
  prepend: () => void;
  scroller: () => HTMLElement;
  visible: () => VisibleRow;
};

declare global {
  interface Window {
    timelineScrollHarness?: TimelineScrollHarness;
  }
}

function item(sequence: number): TimelineItem {
  return {
    kind: "user-message",
    id: `row-${sequence}`,
    text: `Timeline row ${sequence}`,
    resources: [],
    tools: [],
    occurredAt: new Date(1_750_000_000_000 + sequence).toISOString(),
  };
}

function range(start: number, count: number): TimelineItem[] {
  return Array.from({ length: count }, (_, index) => item(start + index));
}

function streamedItem(text: string): TimelineItem {
  return {
    kind: "agent-message",
    id: "stream-1",
    turnId: "turn-stream",
    text,
    streaming: true,
    occurredAt: new Date(1_750_000_000_500).toISOString(),
  };
}

function Harness() {
  const adjacentPrepend = new URLSearchParams(window.location.search).has("adjacent");
  const [items, setItems] = useState(() => [
    ...(adjacentPrepend ? range(1_040, 80) : range(1_000, 120)),
    streamedItem("Initial streamed response"),
  ]);
  const [grown, setGrown] = useState(false);
  const [streamed, setStreamed] = useState(false);
  const [nextSequence, setNextSequence] = useState(1_120);

  const scroller = useCallback(() => {
    const node = document.querySelector<HTMLElement>("[data-timeline-test] .og-root > div");
    if (!node) throw new Error("timeline scroller is unavailable");
    return node;
  }, []);
  const visible = useCallback((): VisibleRow => {
    const node = scroller();
    const containerTop = node.getBoundingClientRect().top;
    const row = [...document.querySelectorAll<HTMLElement>("[data-timeline-row]")].find(
      (candidate) => candidate.getBoundingClientRect().bottom > containerTop + 1,
    );
    return {
      id: row?.dataset.timelineRow ?? null,
      top: row ? row.getBoundingClientRect().top - containerTop : null,
    };
  }, [scroller]);
  const append = useCallback(() => {
    flushSync(() => {
      setItems((current) => [...current, item(nextSequence)]);
      setNextSequence((current) => current + 1);
    });
  }, [nextSequence]);
  const prepend = useCallback(() => {
    flushSync(() =>
      setItems((current) => [
        ...(adjacentPrepend ? range(1_000, 40) : range(900, 100)),
        ...current,
      ]),
    );
  }, [adjacentPrepend]);
  const stream = useCallback(() => {
    flushSync(() => {
      setStreamed(true);
      setItems((current) =>
        current.map((currentItem) =>
          currentItem.id === "stream-1"
            ? streamedItem("Streamed response grew while the reader was away from the bottom")
            : currentItem,
        ),
      );
    });
  }, []);

  useEffect(() => {
    window.timelineScrollHarness = {
      append,
      growRowsAbove: () => flushSync(() => setGrown(true)),
      stream,
      prepend,
      scroller,
      visible,
    };
    return () => {
      delete window.timelineScrollHarness;
    };
  }, [append, prepend, scroller, stream, visible]);

  return (
    <main style={{ padding: 32 }} data-og-theme="light">
      <section data-timeline-test style={{ margin: "0 auto", maxWidth: 900 }}>
        <MessageTimeline
          className="timeline-test-shell"
          items={items}
          hasOlder
          renderMessageText={(text, timelineItem) => {
            const isStream = timelineItem.id === "stream-1";
            const sequence = Number(timelineItem.id.replace("row-", ""));
            const baseHeight = isStream ? (streamed ? 220 : 48) : 34 + (sequence % 7) * 13;
            // Models delayed image/font/tool-fold measurement above the reader.
            const delayedGrowth = !isStream && grown && sequence < 1_060 ? 57 : 0;
            return (
              <div
                data-timeline-row={timelineItem.id}
                style={{ minHeight: baseHeight + delayedGrowth }}
              >
                {text}
              </div>
            );
          }}
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
