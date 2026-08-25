import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { MessageTimeline, type TimelineItem } from "@opengeni/react";
import "./styles.css";

type TimelineCollapsedHistoryHarness = {
  appendLiveItem: () => void;
  appendLivePage: () => void;
  appendLivePageMarkNoOlderAndSettleOlder: () => Promise<void>;
  armOlder: () => void;
  clickRetainedRetryAfterRemovingLoader: () => boolean;
  loadCalls: () => number;
  prependFilteredOlderPage: () => void;
  prependUnderfilledPage: () => void;
  removeLoader: () => void;
  settleLoad: (call: number, outcome: "success" | "failure", complete?: boolean) => void;
  settleOlder: (outcome: "success" | "failure") => void;
  settleOlderWithoutPrepend: (outcome: "success" | "failure") => void;
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

function authNeeded(sequence: number): TimelineItem {
  return {
    kind: "auth-needed",
    id: `hidden-auth-${sequence}`,
    turnId: null,
    serverId: null,
    providerDomain: "example.com",
    connectionId: null,
    reason: null,
    scopes: [],
    resource: null,
    toolName: null,
    authorizationUrl: null,
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

function prefetchWindow(): TimelineItem[] {
  return Array.from({ length: 40 }, (_, index) => userMessage(500 + index));
}

const search = new URLSearchParams(window.location.search);

function Harness() {
  const dynamicCollapse = search.has("dynamic-collapse");
  const manualLoad = search.has("manual-load");
  const overlapLoads = search.has("overlap-loads");
  const emptyWindow = search.has("empty-window");
  const omitLoadingOlder = search.has("omit-loading-older");
  const suppressAuthNeeded = search.has("suppress-auth-needed");
  const usePrefetchWindow = search.has("prefetch-window");
  const syncCachedPrefetch = search.has("sync-cached-prefetch");
  const syncCachedUnderfill = search.has("sync-cached-underfill");
  const [items, setItems] = useState<TimelineItem[]>(() =>
    emptyWindow
      ? []
      : syncCachedPrefetch || syncCachedUnderfill || usePrefetchWindow
        ? prefetchWindow()
        : initialCollapsedTail(),
  );
  const [hasOlder, setHasOlder] = useState(!dynamicCollapse);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loaderAvailable, setLoaderAvailable] = useState(true);
  const [loadCalls, setLoadCalls] = useState(0);
  const loadCallsRef = useRef(0);
  const liveAppendRef = useRef(0);
  const livePageRef = useRef(0);
  const pendingLoadRef = useRef<{
    promise: Promise<boolean>;
    resolve: (value: boolean) => void;
    reject: (reason: unknown) => void;
  } | null>(null);
  const overlappingLoadsRef = useRef(
    new Map<
      number,
      {
        resolve: (value: boolean) => void;
        reject: (reason: unknown) => void;
      }
    >(),
  );

  const scroller = useCallback(() => {
    const node = document.querySelector<HTMLElement>(
      "[data-collapsed-history-test] [data-og-timeline-scroller]",
    );
    if (!node) throw new Error("timeline scroller is unavailable");
    return node;
  }, []);

  const settleOlderWithoutPrepend = useCallback((outcome: "success" | "failure") => {
    const pending = pendingLoadRef.current;
    if (!pending) {
      return;
    }
    pendingLoadRef.current = null;
    if (outcome === "failure") {
      pending.reject(new Error("transient collapsed-history load failure"));
      return;
    }
    pending.resolve(false);
  }, []);

  const prependOlderPage = useCallback(() => {
    setItems((current) => [...olderConversation(), ...current]);
    setHasOlder(false);
  }, []);

  const settleOlder = useCallback(
    (outcome: "success" | "failure") => {
      if (!pendingLoadRef.current) {
        return;
      }
      if (outcome === "success") {
        prependOlderPage();
      }
      settleOlderWithoutPrepend(outcome);
    },
    [prependOlderPage, settleOlderWithoutPrepend],
  );

  const prependUnderfilledPage = useCallback(() => {
    const call = loadCallsRef.current;
    setItems((current) => [
      ...settledTurn(100 + call * 40, `overlap-turn-${call}`, `Overlap turn ${call}`, false),
      ...current,
    ]);
  }, []);

  const prependFilteredOlderPage = useCallback(() => {
    const call = loadCallsRef.current;
    setItems((current) => [authNeeded(50 + call), ...current]);
  }, []);

  const clickRetainedRetryAfterRemovingLoader = useCallback(() => {
    const retry = document.querySelector<HTMLElement>("[data-og-retry]");
    if (!retry) {
      return false;
    }
    flushSync(() => setLoaderAvailable(false));
    retry.click();
    return true;
  }, []);

  const appendLiveItem = useCallback(() => {
    const append = ++liveAppendRef.current;
    setItems((current) => [...current, userMessage(1_000 + append)]);
  }, []);

  const appendLivePage = useCallback(() => {
    const append = ++livePageRef.current;
    const sequence = 1_100 + append * 100;
    setItems((current) => [
      ...current,
      ...Array.from({ length: 30 }, (_, index) => userMessage(sequence + index)),
    ]);
  }, []);

  const appendLivePageMarkNoOlderAndSettleOlder = useCallback(async () => {
    // Availability and promise settlement both arrive before the fetched rows,
    // with no animation frame available to drain the live-tail camera debt.
    flushSync(() => appendLivePage());
    flushSync(() => setHasOlder(false));
    settleOlderWithoutPrepend("success");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    flushSync(() => undefined);
    flushSync(() => prependOlderPage());
  }, [appendLivePage, prependOlderPage, settleOlderWithoutPrepend]);

  const settleLoad = useCallback(
    (call: number, outcome: "success" | "failure", complete = false) => {
      const pending = overlappingLoadsRef.current.get(call);
      if (!pending) {
        return;
      }
      overlappingLoadsRef.current.delete(call);
      if (outcome === "failure") {
        pending.reject(new Error(`transient collapsed-history load ${call} failure`));
        return;
      }
      if (complete) {
        flushSync(() => {
          setItems((current) => [...olderConversation(), ...current]);
          setHasOlder(false);
        });
      }
      pending.resolve(false);
    },
    [],
  );

  const loadOlder = useCallback((): Promise<boolean> | void => {
    if (syncCachedPrefetch || syncCachedUnderfill) {
      const call = ++loadCallsRef.current;
      flushSync(() => {
        setLoadCalls(call);
        if (call === 1) {
          setItems((current) =>
            syncCachedUnderfill ? [userMessage(499)] : [userMessage(499), ...current],
          );
        }
      });
      flushSync(() => undefined);
      return;
    }
    if (overlapLoads) {
      const call = ++loadCallsRef.current;
      setLoadCalls(call);
      return new Promise<boolean>((resolve, reject) => {
        overlappingLoadsRef.current.set(call, { resolve, reject });
      });
    }
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
  }, [manualLoad, overlapLoads, settleOlder, syncCachedPrefetch, syncCachedUnderfill]);

  useEffect(() => {
    window.timelineCollapsedHistoryHarness = {
      appendLiveItem,
      appendLivePage,
      appendLivePageMarkNoOlderAndSettleOlder,
      armOlder: () => setHasOlder(true),
      clickRetainedRetryAfterRemovingLoader,
      loadCalls: () => loadCallsRef.current,
      prependFilteredOlderPage,
      prependUnderfilledPage,
      removeLoader: () => setLoaderAvailable(false),
      settleLoad,
      settleOlder,
      settleOlderWithoutPrepend,
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
  }, [
    appendLiveItem,
    appendLivePage,
    appendLivePageMarkNoOlderAndSettleOlder,
    clickRetainedRetryAfterRemovingLoader,
    loadCalls,
    prependFilteredOlderPage,
    prependUnderfilledPage,
    scroller,
    settleLoad,
    settleOlder,
    settleOlderWithoutPrepend,
  ]);

  return (
    <main style={{ padding: 32 }} data-og-theme="light">
      <section data-collapsed-history-test style={{ margin: "0 auto", maxWidth: 900 }}>
        <MessageTimeline
          className="timeline-collapsed-history-shell"
          items={items}
          hasOlder={hasOlder}
          loadingOlder={overlapLoads || omitLoadingOlder ? false : loadingOlder}
          onLoadOlder={loaderAvailable ? loadOlder : undefined}
          shouldRenderAuthNeeded={suppressAuthNeeded ? () => false : undefined}
          renderMessageText={(text, item) => <div data-conversation-message={item.id}>{text}</div>}
        />
      </section>
    </main>
  );
}

const harness = <Harness />;
createRoot(document.getElementById("root")!).render(
  search.has("strict-mode") ? <StrictMode>{harness}</StrictMode> : harness,
);
