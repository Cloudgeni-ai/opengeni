import { startTransition, useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { MessageTimeline, type TimelineItem, type TimelineSearchTarget } from "@opengeni/react";
import "./styles.css";

type VisibleRow = { id: string | null; top: number | null };
const VISIBLE_ROW_EDGE_TOLERANCE_PX = 2;
type TimelineScrollHarness = {
  append: () => void;
  growRowsAbove: () => void;
  stream: () => void;
  prepend: () => void;
  /** Production-like history scheduling without a test-only flushSync fence. */
  prependDeferred: () => void;
  scroller: () => HTMLElement;
  visible: () => VisibleRow;
  search: (target: TimelineSearchTarget | null) => void;
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
    sourceEvents: [{ eventId: `evt-${sequence}`, sequence }],
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

/** Model the fresh projected item objects produced from a changed event window. */
function reprojectedItem(timelineItem: TimelineItem): TimelineItem {
  if (timelineItem.kind === "user-message") {
    return {
      ...timelineItem,
      resources: [...timelineItem.resources],
      tools: [...timelineItem.tools],
    };
  }
  if (timelineItem.kind === "agent-message") {
    return { ...timelineItem };
  }
  return timelineItem;
}

function VirtualSearchBody({
  text,
  target,
}: {
  text: string;
  target: TimelineSearchTarget | null;
}) {
  const [materialized, setMaterialized] = useState<TimelineSearchTarget | null>(null);
  useEffect(() => {
    if (!target) return;
    const timer = setTimeout(() => setMaterialized(target), 50);
    return () => clearTimeout(timer);
  }, [target]);
  return (
    <div>
      <p>{text.slice(0, 10)}</p>
      {materialized ? (
        <div style={{ paddingTop: 2000 }}>
          <span
            data-og-search-occurrence={materialized.occurrence ?? 0}
            data-og-search-sequence={materialized.sequence}
            data-og-search-query={materialized.query}
          >
            {materialized.query}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const adjacentPrepend = params.has("adjacent");
  // Compact newest-suffix: barely overflows a 400px shell so the reader can
  // sit at the top (loading older history) while still inside PIN_THRESHOLD
  // of the live tip after a prepend restore.
  const compactTail = params.has("compact-tail");
  const searchFixture = params.has("search");
  const foldedSearchFixture = params.has("search-fold");
  const virtualSearchFixture = params.has("search-virtual");
  const [searchTarget, setSearchTarget] = useState<TimelineSearchTarget | null>(null);
  const [items, setItems] = useState(() =>
    compactTail
      ? range(13, 6)
      : [
          ...(adjacentPrepend ? range(1_040, 80) : range(1_000, 120)).map((row) =>
            searchFixture && row.id === "row-1040"
              ? {
                  ...row,
                  text: `first literal [a+b] match\n\n${"Long source paragraph.\n\n".repeat(800)}last literal [a+b] match`,
                }
              : row,
          ),
          ...(foldedSearchFixture
            ? [
                item(2000),
                {
                  kind: "agent-message",
                  id: "folded-answer",
                  turnId: "folded-turn",
                  text: "Hidden commentary needle",
                  phase: "commentary",
                  streaming: false,
                  sourceEvents: [{ eventId: "evt-2001", sequence: 2001 }],
                  occurredAt: "2026-09-17T00:00:00Z",
                } as TimelineItem,
                {
                  kind: "reasoning",
                  id: "folded-reason",
                  turnId: "folded-turn",
                  text: "Reasoning",
                  streaming: false,
                  occurredAt: "2026-09-17T00:00:00Z",
                } as TimelineItem,
                {
                  kind: "agent-message",
                  id: "final-answer",
                  turnId: "folded-turn",
                  text: "Final answer",
                  phase: "final_answer",
                  streaming: false,
                  occurredAt: "2026-09-17T00:00:00Z",
                } as TimelineItem,
                {
                  kind: "turn-end",
                  id: "folded-end",
                  turnId: "folded-turn",
                  outcome: "complete",
                  failureText: null,
                  occurredAt: "2026-09-17T00:00:00Z",
                } as TimelineItem,
              ]
            : [streamedItem("Initial streamed response")]),
        ],
  );
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
      // Ignore a subpixel sliver at the viewport edge. Layout rounding can
      // otherwise make the preceding row intermittently look like the reader's
      // anchor even while the retained row stays at the same pixel position.
      (candidate) =>
        candidate.getBoundingClientRect().bottom > containerTop + VISIBLE_ROW_EDGE_TOLERANCE_PX,
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
        ...(compactTail ? range(1, 12) : adjacentPrepend ? range(1_000, 40) : range(900, 100)),
        ...current,
      ]),
    );
  }, [adjacentPrepend, compactTail]);
  const prependDeferred = useCallback(() => {
    startTransition(() => {
      setItems((current) => [
        ...(adjacentPrepend ? range(1_000, 40) : range(900, 100)),
        ...current.map(reprojectedItem),
      ]);
    });
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
      prependDeferred,
      scroller,
      visible,
      search: (target) => flushSync(() => setSearchTarget(target)),
    };
    return () => {
      delete window.timelineScrollHarness;
    };
  }, [append, prepend, prependDeferred, scroller, stream, visible]);

  return (
    <main style={{ padding: 32 }} data-og-theme="light">
      <section data-timeline-test style={{ margin: "0 auto", maxWidth: 900 }}>
        <MessageTimeline
          className={
            compactTail ? "timeline-test-shell timeline-test-shell-compact" : "timeline-test-shell"
          }
          items={items}
          searchTarget={searchTarget}
          hasOlder
          renderMessageText={
            virtualSearchFixture
              ? (text, _item, context) => (
                  <VirtualSearchBody text={text} target={context.searchTarget} />
                )
              : searchFixture
                ? undefined
                : (text, timelineItem) => {
                    const isStream = timelineItem.id === "stream-1";
                    const sequence = Number(timelineItem.id.replace("row-", ""));
                    const baseHeight = compactTail
                      ? 48
                      : isStream
                        ? streamed
                          ? 220
                          : 48
                        : 34 + (sequence % 7) * 13;
                    // Models delayed image/font/tool-fold measurement strictly ABOVE the
                    // reader (anchored near row 1040). Native scroll anchoring owns this
                    // compensation; browsers intentionally suppress it when the anchor
                    // node's own style mutates, so growth never touches the anchor row.
                    const delayedGrowth = !isStream && grown && sequence < 1_035 ? 57 : 0;
                    return (
                      <div
                        data-timeline-row={timelineItem.id}
                        style={{ minHeight: baseHeight + delayedGrowth }}
                      >
                        {text}
                      </div>
                    );
                  }
          }
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
