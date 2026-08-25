import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { MessageTimeline, type TimelineItem } from "@opengeni/react";
import "./styles.css";

type TimelineCollapsedHistoryHarness = {
  armOlder: () => void;
  loadCalls: () => number;
  settleOlder: (outcome: "success" | "failure") => void;
  scroller: () => HTMLElement;
  metrics: () => {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
    maxScroll: number;
    liveTailGap: number;
  };
};

declare global {
  interface Window {
    timelineCollapsedHistoryHarness?: TimelineCollapsedHistoryHarness;
  }
}

const occurredAt = (sequence: number) =>
  new Date(1_750_000_000_000 + sequence * 1_000).toISOString();
const STEPS_PER_TURN = 24;

function userMessage(sequence: number): TimelineItem {
  return {
    kind: "user-message",
    id: `user-${sequence}`,
    text: `Earlier user message ${sequence}`,
    resources: [],
    tools: [],
    occurredAt: occurredAt(sequence),
  };
}

function assistantMessage(sequence: number, turnId: string): TimelineItem {
  return {
    kind: "agent-message",
    id: `assistant-${sequence}`,
    turnId,
    text: `Earlier assistant message ${sequence}`,
    streaming: false,
    occurredAt: occurredAt(sequence),
  };
}

function reasoning(sequence: number, turnId: string, prefix: string): TimelineItem {
  return {
    kind: "reasoning",
    id: `${prefix}-step-${sequence}`,
    turnId,
    text: `${prefix} step ${sequence}: ${"diagnostic detail ".repeat(50)}`,
    streaming: false,
    occurredAt: occurredAt(sequence),
  };
}

function turnEnd(sequence: number, turnId: string): TimelineItem {
  return {
    kind: "turn-end",
    id: `${turnId}-end`,
    turnId,
    outcome: "complete",
    failureText: null,
    occurredAt: occurredAt(sequence),
  };
}

function settledTurn(
  sequence: number,
  turnId: string,
  prefix: string,
  includeMessages: boolean,
): TimelineItem[] {
  return [
    ...(includeMessages ? [userMessage(sequence)] : []),
    ...Array.from({ length: STEPS_PER_TURN }, (_, index) =>
      reasoning(sequence + index + 1, turnId, prefix),
    ),
    ...(includeMessages ? [assistantMessage(sequence + STEPS_PER_TURN + 2, turnId)] : []),
    turnEnd(sequence + STEPS_PER_TURN + 3, turnId),
  ];
}

function initialCollapsedTail(): TimelineItem[] {
  return Array.from({ length: 4 }, (_, index) =>
    settledTurn(200 + index * 40, `tail-turn-${index + 1}`, `Tail turn ${index + 1}`, false),
  ).flat();
}

function olderConversation(): TimelineItem[] {
  return Array.from({ length: 9 }, (_, index) =>
    settledTurn(1 + index * 40, `older-turn-${index + 1}`, `Older turn ${index + 1}`, true),
  ).flat();
}

function Harness() {
  const search = new URLSearchParams(window.location.search);
  const dynamicCollapse = search.has("dynamic-collapse");
  const manualLoad = search.has("manual-load");
  const [items, setItems] = useState<TimelineItem[]>(initialCollapsedTail);
  const [hasOlder, setHasOlder] = useState(!dynamicCollapse);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadCalls, setLoadCalls] = useState(0);
  const loadCallsRef = useRef(0);
  const pendingLoadRef = useRef<{
    promise: Promise<boolean>;
    resolve: (value: boolean) => void;
    reject: (reason: unknown) => void;
  } | null>(null);

  const scroller = useCallback(() => {
    const node = document.querySelector<HTMLElement>(
      "[data-collapsed-history-test] [data-og-timeline-scroller]",
    );
    if (!node) throw new Error("timeline scroller is unavailable");
    return node;
  }, []);

  const settleOlder = useCallback((outcome: "success" | "failure") => {
    const pending = pendingLoadRef.current;
    if (!pending) {
      return;
    }
    pendingLoadRef.current = null;
    if (outcome === "failure") {
      pending.reject(new Error("transient collapsed-history load failure"));
      return;
    }
    setItems((current) => [...olderConversation(), ...current]);
    setHasOlder(false);
    pending.resolve(false);
  }, []);

  const loadOlder = useCallback((): Promise<boolean> => {
    const pending = pendingLoadRef.current;
    if (pending) {
      return pending.promise;
    }
    loadCallsRef.current += 1;
    setLoadCalls(loadCallsRef.current);
    setLoadingOlder(true);
    let resolveLoad!: (value: boolean) => void;
    let rejectLoad!: (reason: unknown) => void;
    const load = new Promise<boolean>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    }).finally(() => setLoadingOlder(false));
    pendingLoadRef.current = {
      promise: load,
      resolve: resolveLoad,
      reject: rejectLoad,
    };
    if (!manualLoad) {
      window.setTimeout(() => settleOlder("success"), 250);
    }
    return load;
  }, [manualLoad, settleOlder]);

  useEffect(() => {
    window.timelineCollapsedHistoryHarness = {
      armOlder: () => setHasOlder(true),
      loadCalls: () => loadCallsRef.current,
      settleOlder,
      scroller,
      metrics: () => {
        const node = scroller();
        const tail = Array.from(
          node.querySelectorAll<HTMLElement>("[data-og-timeline-group-anchor]"),
        ).at(-1);
        return {
          scrollTop: node.scrollTop,
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          maxScroll: Math.max(0, node.scrollHeight - node.clientHeight),
          liveTailGap: tail
            ? node.getBoundingClientRect().bottom - tail.getBoundingClientRect().bottom
            : Number.NaN,
        };
      },
    };
    return () => {
      delete window.timelineCollapsedHistoryHarness;
    };
  }, [loadCalls, scroller, settleOlder]);

  return (
    <main style={{ padding: 32 }} data-og-theme="light">
      <section data-collapsed-history-test style={{ margin: "0 auto", maxWidth: 900 }}>
        <MessageTimeline
          className="timeline-collapsed-history-shell"
          items={items}
          hasOlder={hasOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlder}
          renderMessageText={(text, item) => <div data-conversation-message={item.id}>{text}</div>}
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
