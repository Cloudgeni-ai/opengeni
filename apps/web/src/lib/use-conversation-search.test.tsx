import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  useCommittedSearchQuery,
  useConversationSearch,
  type ConversationSearchPage,
} from "./use-conversation-search";

beforeAll(() => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

function page(overrides: Partial<ConversationSearchPage> = {}): ConversationSearchPage {
  return {
    matches: [],
    nextCursor: null,
    hasMore: false,
    countIsExact: true,
    scannedMessages: 0,
    matchedMessageCount: 0,
    matchedOccurrenceCount: 0,
    ...overrides,
  };
}

function hit(eventId: string) {
  return {
    sessionId: "session",
    sessionTitle: "Session",
    eventId,
    sequence: 1,
    turnId: null,
    role: "user" as const,
    messageId: null,
    messageMatchOffset: 0,
    snippet: { text: "needle", matchStart: 0, matchEnd: 6 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

const flush = (ms = 10) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

async function harness(read: OpenGeniBrowserClient["searchSessionMessages"], strict = false) {
  const client = { searchSessionMessages: read } as OpenGeniBrowserClient;
  const root = createRoot(document.createElement("div"));
  let state!: ReturnType<typeof useConversationSearch>;
  const commits: Array<ReturnType<typeof useConversationSearch>> = [];
  let committed = "";
  function Probe({
    query = "needle",
    authority = "a",
    workspaceId = "w",
    enabled = true,
    archiveStatus = "all",
    activeClient = client,
  }: {
    query?: string;
    authority?: string;
    workspaceId?: string;
    enabled?: boolean;
    archiveStatus?: "active" | "archived" | "all";
    activeClient?: OpenGeniBrowserClient;
  }) {
    committed = useCommittedSearchQuery(
      query,
      JSON.stringify([authority, workspaceId, archiveStatus]),
      enabled,
      40,
    );
    state = useConversationSearch({
      client: activeClient,
      authority,
      workspaceId,
      query: committed,
      enabled,
      archiveStatus,
      debounceMs: 0,
    });
    useLayoutEffect(() => {
      commits.push(state);
    });
    return null;
  }
  async function render(props: Parameters<typeof Probe>[0] = {}) {
    await act(async () =>
      root.render(
        strict ? (
          <StrictMode>
            <Probe {...props} />
          </StrictMode>
        ) : (
          <Probe {...props} />
        ),
      ),
    );
  }
  await render();
  return {
    render,
    commits,
    state: () => state,
    query: () => committed,
    unmount: () => act(async () => root.unmount()),
  };
}

test("a brief typo and undo leave the active request and completed results intact", async () => {
  const response = deferred<ConversationSearchPage>();
  const signals: AbortSignal[] = [];
  const view = await harness(async (_workspace, _request, options) => {
    signals.push(options!.signal!);
    return response.promise;
  });
  try {
    await flush();
    await view.render({ query: "needlex" });
    await flush();
    expect(view.query()).toBe("needle");
    expect(signals[0]!.aborted).toBe(false);
    await view.render({ query: "needle" });
    await flush(60);
    expect(signals).toHaveLength(1);
    await act(async () => response.resolve(page({ matches: [hit("one")], scannedMessages: 1 })));
    expect(view.state().page?.matches).toHaveLength(1);
    await view.render({ query: "needlex" });
    await view.render({ query: "needle" });
    await flush(60);
    expect(signals).toHaveLength(1);
    expect(view.state().page?.matches).toHaveLength(1);
  } finally {
    await view.unmount();
  }
});

test("committed edits abort the old request, preserve literal whitespace, and clear immediately", async () => {
  const requests: Array<{ query: string; signal: AbortSignal }> = [];
  const view = await harness(async (_workspace, request, options) => {
    requests.push({ query: request.query, signal: options!.signal! });
    return page();
  });
  try {
    await flush();
    await view.render({ query: " needle " });
    await flush(60);
    await flush();
    expect(requests.map((request) => request.query)).toEqual(["needle", " needle "]);
    expect(requests[0]!.signal.aborted).toBe(true);
    await view.render({ query: "" });
    expect(view.query()).toBe("");
    expect(view.state().page).toBeNull();
    expect(view.state().loading).toBe(false);
  } finally {
    await view.unmount();
  }
});

test("transient continuation failures preserve matches and retry the last successful boundary", async () => {
  const cursors: Array<string | undefined> = [];
  let fail = true;
  const view = await harness(async (_workspace, request) => {
    cursors.push(request.cursor);
    if (!request.cursor)
      return page({ hasMore: true, nextCursor: "empty", countIsExact: false, scannedMessages: 32 });
    if (request.cursor === "empty")
      return page({
        matches: [hit("one")],
        hasMore: true,
        nextCursor: "partial",
        countIsExact: false,
        scannedMessages: 64,
        matchedMessageCount: 1,
        matchedOccurrenceCount: 1,
      });
    if (fail) throw new OpenGeniApiError(503, "sensitive diagnostics");
    expect(request.limit).toBe(49);
    return page({
      matches: [hit("two")],
      scannedMessages: 80,
      matchedMessageCount: 2,
      matchedOccurrenceCount: 2,
    });
  });
  try {
    await flush();
    expect(view.state().page?.matches.map((match) => match.eventId)).toEqual(["one"]);
    expect(view.state().scanned).toBe(64);
    expect(view.state().error).not.toContain("sensitive");
    expect(view.state().accessDenied).toBe(false);
    fail = false;
    await act(async () => view.state().retry());
    expect(view.state().page?.matches).toHaveLength(1);
    await flush();
    expect(cursors).toEqual([undefined, "empty", "partial", "partial"]);
    expect(view.state().page?.matches.map((match) => match.eventId)).toEqual(["one", "two"]);
    expect(view.state().error).toBeNull();
    expect(view.state().scanned).toBe(80);
  } finally {
    await view.unmount();
  }
});

test.each([400, 401, 403, 404, 410])(
  "HTTP %s clears partial content and retry starts a fresh authorized search",
  async (status) => {
    const cursors: Array<string | undefined> = [];
    const view = await harness(async (_workspace, request) => {
      cursors.push(request.cursor);
      if (!request.cursor)
        return page({
          matches: [hit("private")],
          hasMore: true,
          nextCursor: "next",
          countIsExact: false,
        });
      throw new OpenGeniApiError(status, "server diagnostic");
    });
    try {
      await flush();
      expect(view.state().page).toBeNull();
      expect(view.state().scanned).toBe(0);
      expect(view.state().accessDenied).toBe([401, 403, 404].includes(status));
      await act(async () => view.state().retry());
      await flush();
      expect(cursors).toEqual([undefined, "next", undefined, "next"]);
    } finally {
      await view.unmount();
    }
  },
);

test("scope changes hide old hits immediately and reject late responses even if transport ignores abort", async () => {
  const old = deferred<ConversationSearchPage>();
  let reads = 0;
  const view = await harness(async () =>
    ++reads === 1 ? old.promise : page({ matches: [hit("new")] }),
  );
  try {
    await flush();
    await view.render({ authority: "b", query: "different" });
    expect(view.query()).toBe("different");
    expect(view.state().page).toBeNull();
    await flush();
    await act(async () => old.resolve(page({ matches: [hit("old")] })));
    expect(view.state().page?.matches.map((match) => match.eventId)).toEqual(["new"]);
    await view.render({ authority: "b", query: "different", archiveStatus: "archived" });
    expect(view.state().page).toBeNull();
    await flush();
    expect(reads).toBe(3);
  } finally {
    await view.unmount();
  }
});

test("closing and reopening reauthorizes rather than restoring cached progress", async () => {
  const cursors: Array<string | undefined> = [];
  const view = await harness(async (_workspace, request) => {
    cursors.push(request.cursor);
    if (!request.cursor)
      return page({
        matches: [hit("one")],
        hasMore: true,
        nextCursor: "next",
        countIsExact: false,
      });
    throw new Error("temporary connection failure");
  });
  try {
    await flush();
    await view.render({ enabled: false });
    await view.render({ enabled: true });
    await flush();
    expect(cursors).toEqual([undefined, "next", undefined, "next"]);
  } finally {
    await view.unmount();
  }
});

test.each([400, 401, 403, 404, 410])(
  "HTTP %s after navigation retries page zero without replaying the rejected cursor",
  async (status) => {
    const cursors: Array<string | undefined> = [];
    const view = await harness(async (_workspace, request) => {
      cursors.push(request.cursor);
      if (request.cursor) throw new OpenGeniApiError(status, "rejected scope");
      return page({
        matches: Array.from({ length: 50 }, (_, index) => hit(String(index))),
        hasMore: true,
        nextCursor: "rejected",
      });
    });
    try {
      await flush();
      await act(async () => view.state().next());
      await flush();
      expect(view.state().pageIndex).toBe(1);
      expect(view.state().page).toBeNull();
      expect(view.state().error).not.toBeNull();
      expect(view.state().accessDenied).toBe([401, 403, 404].includes(status));
      // The failure remains visible until an explicit retry, without a read loop.
      expect(cursors).toEqual([undefined, "rejected"]);
      await act(async () => view.state().retry());
      await flush();
      expect(cursors).toEqual([undefined, "rejected", undefined]);
      expect(view.state().pageIndex).toBe(0);
      expect(view.state().error).toBeNull();
      expect(view.state().page?.matches).toHaveLength(50);
    } finally {
      await view.unmount();
    }
  },
);

test("disable and reopen never commit old hits, progress, or errors before reauthorization", async () => {
  const fresh = deferred<ConversationSearchPage>();
  const signals: AbortSignal[] = [];
  let reads = 0;
  const view = await harness(async (_workspace, request, options) => {
    signals.push(options!.signal!);
    if (++reads > 2) return fresh.promise;
    if (request.cursor) throw new OpenGeniApiError(503, "temporary");
    return page({
      matches: [hit("private")],
      scannedMessages: 32,
      hasMore: true,
      nextCursor: "next",
    });
  });
  try {
    await flush();
    expect(view.state().page?.matches).toHaveLength(1);
    expect(view.state().error).not.toBeNull();
    view.commits.length = 0;
    await view.render({ enabled: false });
    expect(view.commits.length).toBeGreaterThan(0);
    for (const commit of view.commits) {
      expect(commit.page).toBeNull();
      expect(commit.scanned).toBe(0);
      expect(commit.error).toBeNull();
      expect(commit.loading).toBe(false);
    }
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    view.commits.length = 0;
    await view.render({ enabled: true });
    await flush();
    expect(view.commits.length).toBeGreaterThan(0);
    for (const commit of view.commits) {
      expect(commit.page).toBeNull();
      expect(commit.scanned).toBe(0);
      expect(commit.error).toBeNull();
      expect(commit.loading).toBe(true);
    }
    await act(async () => fresh.resolve(page({ matches: [hit("fresh")] })));
    expect(view.state().page?.matches.map((match) => match.eventId)).toEqual(["fresh"]);
  } finally {
    await view.unmount();
  }
});

test("client replacement resets navigation even when the old client returns later", async () => {
  const cursors: Array<string | undefined> = [];
  const read: OpenGeniBrowserClient["searchSessionMessages"] = async (_workspace, request) => {
    cursors.push(request.cursor);
    return request.cursor
      ? page({ matches: [hit("old page two")] })
      : page({
          matches: Array.from({ length: 50 }, (_, index) => hit(String(index))),
          hasMore: true,
          nextCursor: "old-client-cursor",
        });
  };
  const client = { searchSessionMessages: read } as OpenGeniBrowserClient;
  const view = await harness(read);
  const replacementCursors: Array<string | undefined> = [];
  const replacement = {
    searchSessionMessages: async (_workspace, request) => {
      replacementCursors.push(request.cursor);
      return page({ matches: [hit("replacement")] });
    },
  } as OpenGeniBrowserClient;
  try {
    await view.render({ activeClient: client });
    await flush();
    await act(async () => view.state().next());
    await flush();
    expect(view.state().pageIndex).toBe(1);
    view.commits.length = 0;
    await view.render({ activeClient: replacement });
    expect(view.commits[0]!.page).toBeNull();
    expect(view.commits[0]!.pageIndex).toBe(0);
    await flush();
    expect(replacementCursors).toEqual([undefined]);
    expect(view.state().pageIndex).toBe(0);
    await view.render({ activeClient: client });
    await flush();
    expect(cursors).toEqual([undefined, "old-client-cursor", undefined]);
    expect(view.state().pageIndex).toBe(0);
  } finally {
    await view.unmount();
  }
});

test("StrictMode starts one live request and cancels it on unmount", async () => {
  const signals: AbortSignal[] = [];
  const view = await harness(async (_workspace, _request, options) => {
    signals.push(options!.signal!);
    return page({ matches: [hit("one")] });
  }, true);
  try {
    await flush();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    expect(view.state().page?.matches).toHaveLength(1);
  } finally {
    await view.unmount();
  }
  expect(signals[0]!.aborted).toBe(true);
});

test("StrictMode clears an old denial before committing the reopened live search", async () => {
  let denied = true;
  let requests = 0;
  const view = await harness(async () => {
    requests++;
    if (denied) throw new OpenGeniApiError(403, "denied");
    return page();
  }, true);
  try {
    await flush();
    expect(view.state().accessDenied).toBe(true);
    view.commits.length = 0;
    await view.render({ enabled: false });
    expect(view.commits[0]).toMatchObject({ accessDenied: false, error: null, loading: false });
    denied = false;
    view.commits.length = 0;
    await view.render({ enabled: true });
    expect(requests).toBe(1);
    expect(view.commits[0]).toMatchObject({ accessDenied: false, error: null, loading: true });
    await flush();
    expect(requests).toBe(2);
    expect(view.state().accessDenied).toBe(false);
    expect(view.state().page).not.toBeNull();
  } finally {
    await view.unmount();
  }
});

test("broken continuation retries the last valid checkpoint without duplicating hits", async () => {
  let repaired = false;
  const cursors: Array<string | undefined> = [];
  const view = await harness(async (_workspace, request) => {
    cursors.push(request.cursor);
    if (!request.cursor)
      return page({ matches: [hit("one")], hasMore: true, nextCursor: "checkpoint" });
    if (!repaired) return page({ matches: [hit("one")], hasMore: true, nextCursor: "checkpoint" });
    return page({ matches: [hit("two")] });
  });
  try {
    await flush();
    expect(view.state().page?.matches.map((match) => match.eventId)).toEqual(["one"]);
    expect(view.state().error).not.toBeNull();
    repaired = true;
    await act(async () => view.state().retry());
    await flush();
    expect(cursors).toEqual([undefined, "checkpoint", "checkpoint"]);
    expect(view.state().page?.matches.map((match) => match.eventId)).toEqual(["one", "two"]);
  } finally {
    await view.unmount();
  }
});

test("successive transient retries preserve the paged checkpoint and remaining limit", async () => {
  const cursors: Array<string | undefined> = [];
  let phase = 0;
  const view = await harness(async (_workspace, request) => {
    cursors.push(request.cursor);
    if (!request.cursor)
      return page({
        matches: Array.from({ length: 50 }, (_, index) => hit(String(index))),
        hasMore: true,
        nextCursor: "page-two",
      });
    if (request.cursor === "page-two")
      return page({ matches: [hit("one")], hasMore: true, nextCursor: "one" });
    if (request.cursor === "one") {
      if (phase === 0) throw new OpenGeniApiError(503, "temporary");
      expect(request.limit).toBe(49);
      return page({ matches: [hit("two")], hasMore: true, nextCursor: "two" });
    }
    if (phase === 1) throw new OpenGeniApiError(429, "throttled");
    expect(request.limit).toBe(48);
    return page({ matches: [hit("three")] });
  });
  try {
    await flush();
    await act(async () => view.state().next());
    await flush();
    phase = 1;
    await act(async () => view.state().retry());
    await flush();
    expect(view.state().page?.matches.map((match) => match.eventId)).toEqual(["one", "two"]);
    phase = 2;
    await act(async () => view.state().retry());
    await flush();
    expect(view.state().page?.matches.map((match) => match.eventId)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(view.state().pageIndex).toBe(1);
    expect(cursors).toEqual([undefined, "page-two", "one", "one", "two", "two"]);
  } finally {
    await view.unmount();
  }
});
