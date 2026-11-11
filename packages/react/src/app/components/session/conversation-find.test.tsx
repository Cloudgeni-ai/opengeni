import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { TimelineSearchTarget } from "../../../session-ui";
import type { ConversationSearchPage } from "../../lib/use-conversation-search";
import type { SessionSearchRoute } from "../../lib/session-search-route";

const page: ConversationSearchPage = {
  matches: [0, 12, 24].map((offset) => ({
    sessionId: "session",
    sessionTitle: "Session",
    eventId: "event",
    sequence: 7,
    turnId: null,
    role: "user",
    messageId: null,
    messageMatchOffset: offset,
    snippet: { text: "test", matchStart: 0, matchEnd: 4 },
  })),
  nextCursor: null,
  hasMore: false,
  scannedMessages: 1,
  matchedMessageCount: 1,
  matchedOccurrenceCount: 3,
  countIsExact: true,
};
type SearchRequest = {
  query: string;
  sessionId?: string;
  order?: "oldest" | "newest";
  limit?: number;
  cursor?: string;
};
let search: (
  workspaceId: string,
  request: SearchRequest,
) => Promise<ConversationSearchPage> = async () => page;
const client = {
  searchSessionMessages: (workspaceId: string, request: SearchRequest) =>
    search(workspaceId, request),
};

/** A paged in-memory search API with the server's traversal orders: newest
 * visits messages newest first, occurrences inside a message in text order. */
function pagedSearch(occurrences: Array<{ sequence: number; offset: number }>) {
  const requests: SearchRequest[] = [];
  const respond = async (_workspaceId: string, request: SearchRequest) => {
    requests.push(request);
    const ordered = [...occurrences].sort((a, b) =>
      request.order === "newest"
        ? b.sequence - a.sequence || a.offset - b.offset
        : a.sequence - b.sequence || a.offset - b.offset,
    );
    const start = request.cursor ? Number(request.cursor) : 0;
    const slice = ordered.slice(start, start + (request.limit ?? 20));
    const end = start + slice.length;
    const hasMore = end < ordered.length;
    return {
      matches: slice.map((occurrence) => ({
        sessionId: "session",
        sessionTitle: "Session",
        eventId: `event-${occurrence.sequence}`,
        sequence: occurrence.sequence,
        turnId: null,
        role: "user" as const,
        messageId: null,
        messageMatchOffset: occurrence.offset,
        snippet: { text: "needle", matchStart: 0, matchEnd: 6 },
      })),
      nextCursor: hasMore ? String(end) : null,
      hasMore,
      scannedMessages: end,
      matchedMessageCount: end,
      matchedOccurrenceCount: end,
      countIsExact: !hasMore,
    };
  };
  return { requests, respond };
}

async function mountFind(initial: SessionSearchRoute) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const targets: Array<TimelineSearchTarget | null> = [];
  const jumps: number[] = [];
  const onTarget = (target: TimelineSearchTarget | null) => targets.push(target);
  const onJump = async (sequence: number) => {
    jumps.push(sequence);
    return true;
  };
  const onClose = () => {};
  const render = (open: boolean) =>
    act(async () =>
      root.render(
        <ConversationFind
          workspaceId="workspace"
          sessionId="session"
          open={open}
          focusRevision={0}
          initial={initial}
          showBackToSessionSearch={false}
          onTarget={onTarget}
          onJump={onJump}
          onClose={onClose}
        />,
      ),
    );
  await render(true);
  // The visible counter; a spoken alternative, when present, is separate.
  const counter = () => {
    const status = host.querySelector('[role="status"]');
    return (
      status?.querySelector('[aria-hidden="true"]')?.textContent ??
      status?.textContent ??
      ""
    ).trim();
  };
  const settle = async (until: () => boolean) => {
    for (let attempt = 0; attempt < 400 && !until(); attempt++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    expect(until()).toBe(true);
  };
  const press = (key: string, shiftKey = false) =>
    act(async () => {
      host
        .querySelector("input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
    });
  const click = (label: string) =>
    act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
  return {
    host,
    targets,
    jumps,
    counter,
    settle,
    press,
    click,
    render,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
let ConversationFind: ComponentType<{
  workspaceId: string;
  sessionId: string;
  open: boolean;
  focusRevision: number;
  initial: SessionSearchRoute;
  showBackToSessionSearch: boolean;
  onClose: () => void;
  onTarget: (target: TimelineSearchTarget | null) => void;
  onJump: (sequence: number, options?: { signal?: AbortSignal }) => Promise<boolean>;
}>;

beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mock.module("../../app-context", () => ({
    useAppContext: () => ({ client, accessContext: { subjectId: "reader" } }),
  }));
  ConversationFind = (await import("./conversation-find")).default;
});
afterEach(() => {
  search = async () => page;
});
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

test.each([false, true])(
  "mounted replacement route preserves its exact occurrence (StrictMode=%s)",
  async (strict) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const targets: Array<TimelineSearchTarget | null> = [];
    const onTarget = (target: TimelineSearchTarget | null) => targets.push(target);
    const onJump = async () => true;
    const render = (initial: SessionSearchRoute) =>
      act(async () => {
        const child = (
          <ConversationFind
            workspaceId="workspace"
            sessionId="session"
            open
            focusRevision={0}
            initial={initial}
            showBackToSessionSearch={false}
            onTarget={onTarget}
            onJump={onJump}
            onClose={() => {}}
          />
        );
        root.render(strict ? <StrictMode>{child}</StrictMode> : child);
      });
    const flush = (ms = 20) =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      });
    try {
      await render({ find: "old", matchSequence: 7, matchOffset: 12 });
      await flush();
      expect(targets.at(-1)).toMatchObject({ query: "old", offset: 12 });
      await render({ find: "new", matchSequence: 7, matchOffset: 24 });
      await flush(300);
      await flush();
      expect(targets.at(-1)).toMatchObject({ query: "new", offset: 24 });
      expect(host.textContent).toContain("3 / 3");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  },
);

test("an authority scope change discards a pending replacement-route occurrence", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const targets: Array<TimelineSearchTarget | null> = [];
  const onTarget = (target: TimelineSearchTarget | null) => targets.push(target);
  const onJump = async () => true;
  const render = (workspaceId: string, initial: SessionSearchRoute) =>
    act(async () => {
      root.render(
        <StrictMode>
          <ConversationFind
            workspaceId={workspaceId}
            sessionId="session"
            open
            focusRevision={0}
            initial={initial}
            showBackToSessionSearch={false}
            onTarget={onTarget}
            onJump={onJump}
            onClose={() => {}}
          />
        </StrictMode>,
      );
    });
  const flush = (ms = 20) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  try {
    await render("original", { find: "old", matchSequence: 7, matchOffset: 12 });
    await flush();
    await render("original", { find: "new", matchSequence: 7, matchOffset: 12 });
    await render("other", { find: "new", matchSequence: 7, matchOffset: 12 });
    await flush(300);
    await flush();
    // The discarded occurrence gives way to the ordinary start: the newest match.
    expect(targets.at(-1)).toMatchObject({ query: "new", offset: 24 });
    expect(host.textContent).toContain("3 / 3");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("deep-link occurrence stays selected, Enter moves matches, Escape clears without another jump", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const targets: Array<TimelineSearchTarget | null> = [];
  const jumps: number[] = [];
  let open = true;
  const onTarget = (target: TimelineSearchTarget | null) => targets.push(target);
  const onJump = async (sequence: number) => {
    jumps.push(sequence);
    return true;
  };
  const render = () =>
    root.render(
      <ConversationFind
        workspaceId="workspace"
        sessionId="session"
        open={open}
        focusRevision={0}
        initial={{ find: "test", matchSequence: 7, matchOffset: 12 }}
        showBackToSessionSearch={false}
        onTarget={onTarget}
        onJump={onJump}
        onClose={() => {
          open = false;
          render();
        }}
      />,
    );
  try {
    await act(async () => render());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(targets.at(-1)?.offset).toBe(12);
    expect(host.textContent).toContain("2 / 3");
    const beforeDraft = jumps.length;
    const beforeTargets = targets.length;
    const typeDraft = async (value: string) =>
      act(async () => {
        const input = host.querySelector("input")!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "e", bubbles: true }));
      });
    await typeDraft("testx");
    expect(host.textContent).toContain("Showing matches for “test”");
    await typeDraft("test");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 280));
    });
    expect(jumps.length).toBe(beforeDraft);
    expect(targets.length).toBe(beforeTargets);
    expect(host.textContent).toContain("2 / 3");
    await act(async () =>
      host
        .querySelector("input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(targets.at(-1)?.offset).toBe(24);
    expect(host.textContent).toContain("3 / 3");
    await act(async () =>
      host
        .querySelector("input")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
        ),
    );
    expect(targets.at(-1)?.offset).toBe(12);
    const beforeClose = jumps.length;
    await act(async () =>
      host
        .querySelector("input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(targets.at(-1)).toBeNull();
    expect(jumps.length).toBe(beforeClose);
    expect(host.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("closing while navigation is pending aborts it and suppresses late highlight", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const targets: Array<TimelineSearchTarget | null> = [];
  let signal: AbortSignal | undefined;
  let finish!: (value: boolean) => void;
  const onJump = async (_sequence: number, options?: { signal?: AbortSignal | undefined }) => {
    signal = options?.signal;
    return await new Promise<boolean>((resolve) => {
      finish = resolve;
    });
  };
  const onTarget = (target: TimelineSearchTarget | null) => targets.push(target);
  const render = (open: boolean) =>
    root.render(
      <ConversationFind
        workspaceId="workspace"
        sessionId="session"
        open={open}
        focusRevision={0}
        initial={{ find: "test", matchSequence: 7 }}
        showBackToSessionSearch={false}
        onTarget={onTarget}
        onJump={onJump}
        onClose={() => render(false)}
      />,
    );
  try {
    await act(async () => render(true));
    expect(signal?.aborted).toBe(false);
    await act(async () => render(false));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(true));
    expect(targets.every((target) => target === null)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("return link appears only while the find bar was opened from session search", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (showBackToSessionSearch: boolean) =>
    act(async () => {
      root.render(
        <ConversationFind
          workspaceId="workspace"
          sessionId="session"
          open
          focusRevision={0}
          initial={{}}
          showBackToSessionSearch={showBackToSessionSearch}
          onTarget={() => {}}
          onJump={async () => true}
          onClose={() => {}}
        />,
      );
    });
  try {
    await render(false);
    expect(host.querySelector("section")?.textContent).not.toContain("Showing matches for");
    expect(host.textContent).not.toContain("Back to session search");
    await render(true);
    const back = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Back to session search",
    );
    expect(back).toBeDefined();
    let requestedWorkspace: string | undefined;
    const onSearch = (event: Event) => {
      requestedWorkspace = (event as CustomEvent<{ workspaceId: string }>).detail.workspaceId;
    };
    window.addEventListener("opengeni:open-session-search", onSearch);
    try {
      await act(async () => back!.click());
      expect(requestedWorkspace).toBe("workspace");
    } finally {
      window.removeEventListener("opengeni:open-session-search", onSearch);
    }
    await render(false);
    expect(host.textContent).not.toContain("Back to session search");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("Find starts at the newest match and counts the whole session, not the first 50", async () => {
  const server = pagedSearch(
    Array.from({ length: 120 }, (_, index) => ({ sequence: index + 1, offset: 4 })),
  );
  search = server.respond;
  const find = await mountFind({ find: "needle" });
  try {
    await find.settle(() => find.counter() === "120 / 120");
    expect(find.targets.at(-1)).toMatchObject({ sequence: 120, offset: 4, query: "needle" });
    expect(find.jumps).toEqual([120]);
    expect(server.requests.every((request) => request.order === "newest")).toBe(true);
  } finally {
    await find.unmount();
  }
});

test("Previous from the first match wraps to the newest and Next from the newest wraps to the first", async () => {
  search = pagedSearch(
    Array.from({ length: 120 }, (_, index) => ({ sequence: index + 1, offset: 0 })),
  ).respond;
  const find = await mountFind({ find: "needle" });
  try {
    await find.settle(() => find.counter() === "120 / 120");
    await find.press("Enter");
    await find.settle(() => find.counter() === "1 / 120");
    expect(find.targets.at(-1)?.sequence).toBe(1);
    await find.press("Enter", true);
    await find.settle(() => find.counter() === "120 / 120");
    expect(find.targets.at(-1)?.sequence).toBe(120);
    await find.click("Previous match");
    await find.settle(() => find.counter() === "119 / 120");
    await find.click("Next match");
    await find.settle(() => find.counter() === "120 / 120");
    await find.click("Next match");
    await find.settle(() => find.counter() === "1 / 120");
    await find.click("Previous match");
    await find.settle(() => find.counter() === "120 / 120");
    expect(find.targets.at(-1)?.sequence).toBe(120);
  } finally {
    await find.unmount();
  }
});

test("a newest message with more matches than one page still lands on its last occurrence", async () => {
  search = pagedSearch([
    ...Array.from({ length: 4 }, (_, index) => ({ sequence: index + 1, offset: 0 })),
    ...Array.from({ length: 70 }, (_, index) => ({ sequence: 5, offset: index * 10 })),
  ]).respond;
  const find = await mountFind({ find: "needle" });
  try {
    await find.settle(() => find.counter() === "74 / 74");
    expect(find.targets.at(-1)).toMatchObject({ sequence: 5, offset: 690 });
    await find.press("Enter", true);
    await find.settle(() => find.counter() === "73 / 74");
    expect(find.targets.at(-1)).toMatchObject({ sequence: 5, offset: 680 });
  } finally {
    await find.unmount();
  }
});

test("in a very long history the newest match comes first and the oldest stays reachable", async () => {
  const server = pagedSearch(
    Array.from({ length: 2_100 }, (_, index) => ({ sequence: index + 1, offset: 0 })),
  );
  search = server.respond;
  const find = await mountFind({ find: "needle" });
  try {
    // Background counting stops after many matches; the place is not known yet.
    await find.settle(() => find.counter() === "? / 2050+");
    expect(find.host.querySelector('[role="status"]')?.textContent).toContain(
      "More than 2050 matches, still counting",
    );
    expect(find.targets.at(-1)?.sequence).toBe(2_100);
    await find.press("Enter", true);
    await find.settle(() => find.targets.at(-1)?.sequence === 2_099);
    await find.press("Enter");
    await find.settle(() => find.targets.at(-1)?.sequence === 2_100);
    // Next from the newest wraps to the oldest match with one oldest-first
    // request, without paging through the history in between.
    const newestPages = server.requests.length;
    await find.press("Enter");
    await find.settle(() => find.counter() === "1 / 2050+");
    expect(find.targets.at(-1)?.sequence).toBe(1);
    expect(server.requests.slice(newestPages)).toEqual([
      { query: "needle", sessionId: "session", order: "oldest", limit: 1 },
    ]);
    // Previous from the oldest wraps back to the newest, and Next returns.
    await find.press("Enter", true);
    await find.settle(() => find.targets.at(-1)?.sequence === 2_100);
    await find.press("Enter");
    await find.settle(() => find.targets.at(-1)?.sequence === 1);
    expect(server.requests.length).toBe(newestPages + 1);
    // Next from the oldest loads the history it skipped, then knows its place.
    await find.press("Enter");
    await find.settle(() => find.counter() === "2 / 2100");
    expect(find.targets.at(-1)?.sequence).toBe(2);
    expect(server.requests.at(-1)?.cursor).toBe("2050");
  } finally {
    await find.unmount();
  }
});

test("closing and reopening Find lands on the newest match and highlights it again", async () => {
  search = pagedSearch(
    Array.from({ length: 5 }, (_, index) => ({ sequence: index + 1, offset: 0 })),
  ).respond;
  const find = await mountFind({ find: "needle" });
  try {
    await find.settle(() => find.counter() === "5 / 5");
    await find.press("Enter", true);
    await find.settle(() => find.counter() === "4 / 5");
    await find.render(false);
    expect(find.targets.at(-1)).toBeNull();
    await find.render(true);
    await find.settle(() => find.counter() === "5 / 5");
    expect(find.targets.at(-1)).toMatchObject({ sequence: 5, query: "needle" });
    expect(find.jumps.at(-1)).toBe(5);
  } finally {
    await find.unmount();
  }
});

test("a failed load during a move releases the arrows and Retry continues", async () => {
  const server = pagedSearch(
    Array.from({ length: 2_100 }, (_, index) => ({ sequence: index + 1, offset: 0 })),
  );
  let failures = 1;
  search = async (workspaceId, request) => {
    if (request.order === "oldest" && failures-- > 0) throw new Error("network");
    return server.respond(workspaceId, request);
  };
  const find = await mountFind({ find: "needle" });
  try {
    await find.settle(() => find.counter() === "? / 2050+");
    await find.press("Enter");
    await find.settle(() => !!find.host.querySelector('[role="alert"]'));
    // The move is dropped: no endless "Searching…", and the arrows work.
    await find.settle(() => find.counter() === "? / 2050+");
    expect(
      find.host.querySelector<HTMLButtonElement>('[aria-label="Previous match"]')!.disabled,
    ).toBe(false);
    expect(find.targets.at(-1)?.sequence).toBe(2_100);
    await act(async () =>
      [...find.host.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry")!
        .click(),
    );
    await find.settle(() => !find.host.querySelector('[role="alert"]'));
    await find.press("Enter");
    await find.settle(() => find.counter() === "1 / 2050+");
    expect(find.targets.at(-1)?.sequence).toBe(1);
  } finally {
    await find.unmount();
  }
});

test("a failed page keeps the matches found so far and Retry resumes after them", async () => {
  const server = pagedSearch(
    Array.from({ length: 80 }, (_, index) => ({ sequence: index + 1, offset: 0 })),
  );
  let failures = 1;
  search = async (workspaceId, request) => {
    if (request.cursor && failures-- > 0) throw new Error("network");
    return server.respond(workspaceId, request);
  };
  const find = await mountFind({ find: "needle" });
  try {
    await find.settle(() => !!find.host.querySelector('[role="alert"]'));
    expect(find.targets.at(-1)?.sequence).toBe(80);
    await act(async () =>
      [...find.host.querySelectorAll("button")]
        .find((button) => button.textContent === "Retry")!
        .click(),
    );
    await find.settle(() => find.counter() === "80 / 80");
    expect(server.requests.map((request) => request.cursor)).toEqual([undefined, "50"]);
  } finally {
    await find.unmount();
  }
});
