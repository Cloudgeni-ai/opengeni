import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { TimelineSearchTarget } from "@opengeni/react/session-ui";
import type { ConversationSearchPage } from "@/lib/use-conversation-search";
import type { SessionSearchRoute } from "@/lib/session-search-route";

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
const client = { searchSessionMessages: async () => page };
let ConversationFind: ComponentType<{
  workspaceId: string;
  sessionId: string;
  open: boolean;
  focusRevision: number;
  initial: SessionSearchRoute;
  onClose: () => void;
  onTarget: (target: TimelineSearchTarget | null) => void;
  onJump: (sequence: number, options?: { signal?: AbortSignal }) => Promise<boolean>;
}>;

beforeAll(async () => {
  GlobalRegistrator.register();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mock.module("@/context", () => ({
    useAppContext: () => ({ client, accessContext: { subjectId: "reader" } }),
  }));
  ConversationFind = (await import("./conversation-find")).default;
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
    await render("original", { find: "new", matchSequence: 7, matchOffset: 24 });
    await render("other", { find: "new", matchSequence: 7, matchOffset: 24 });
    await flush(300);
    await flush();
    expect(targets.at(-1)).toMatchObject({ query: "new", offset: 0 });
    expect(host.textContent).toContain("1 / 3");
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
  const onJump = async (_sequence: number, options?: { signal?: AbortSignal }) => {
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
