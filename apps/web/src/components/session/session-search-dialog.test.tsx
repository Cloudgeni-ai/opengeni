import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { act, StrictMode, type ComponentType } from "react";
import { OpenGeniApiError } from "@opengeni/sdk/browser";
import {
  registerDom,
  renderComponent,
  flush,
} from "../../../../../packages/react/test/render-hook";

registerDom();
let titleReads = 0;
let messageReads = 0;
let failure = 503;
let selectedFailure: number | null = null;
let messageGate: Promise<void> | null = null;
let titlePagination = false;
const queries: string[] = [];
const titleRequests: Array<{
  parentSessionId?: string | null;
  cursor?: string;
  archiveStatus?: string;
}> = [];
const messageRequests: Array<{ sessionId?: string; parentSessionId?: string | null }> = [];
const navigations: Array<{ search: Record<string, unknown> }> = [];
const client = {
  listSessionPage: async (
    _workspace: string,
    options: {
      search: string;
      signal: AbortSignal;
      parentSessionId?: string | null;
      cursor?: string;
      archiveStatus?: string;
    },
  ) => {
    titleReads++;
    titleRequests.push(options);
    queries.push(options.search);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return {
      pinned: [],
      sessions: [
        { id: "s", title: "needle title", updatedAt: "2026-01-01", initialMessage: "" },
        ...(options.parentSessionId === null
          ? []
          : [{ id: "c", title: "needle child", updatedAt: "2026-01-01", initialMessage: "" }]),
      ],
      nextCursor: titlePagination && !options.cursor ? "title-next" : null,
    };
  },
  searchSessionMessages: async (
    _workspace: string,
    options: { sessionId?: string; parentSessionId?: string | null },
  ) => {
    messageReads++;
    messageRequests.push(options);
    if (messageGate) await messageGate;
    const status = options.sessionId ? (selectedFailure ?? failure) : failure;
    if (status === 200)
      return {
        matches: [],
        hasMore: false,
        nextCursor: null,
        matchedOccurrenceCount: 0,
        countIsExact: true,
      };
    throw new OpenGeniApiError(status, "private diagnostics");
  },
  listEvents: async () => [],
};
let Dialog: ComponentType<{
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>;
beforeAll(async () => {
  mock.module("@/context", () => ({
    useAppContext: () => ({ client, accessContext: { subjectId: "reader" } }),
  }));
  mock.module("@tanstack/react-router", () => ({
    useNavigate: () => (options: { search: Record<string, unknown> }) => {
      navigations.push(options);
    },
  }));
  Dialog = (await import("./session-search-dialog")).default;
});

test("parent scope is the default and switching scope updates both search sources", async () => {
  failure = 200;
  selectedFailure = 200;
  titlePagination = true;
  const view = await renderComponent(<Dialog workspaceId="w" open onOpenChange={() => {}} />);
  try {
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search session titles and messages"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "needle",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "e", bubbles: true }));
    });
    await flush(280);
    await flush(20);
    expect(titleRequests.at(-1)?.parentSessionId).toBeNull();
    expect(
      messageRequests.filter((request) => !request.sessionId).at(-1)?.parentSessionId,
    ).toBeNull();
    expect(document.querySelectorAll("[data-search-result]").length).toBe(1);
    await act(async () =>
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "More title results")!
        .click(),
    );
    await flush(20);
    expect(titleRequests.at(-1)?.cursor).toBe("title-next");
    const selectScope = async (label: string) =>
      act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>('[data-slot="segmented-control-item"]')]
          .find((button) => button.textContent === label)!
          .click(),
      );
    await selectScope("All sessions");
    await flush(20);
    expect(titleRequests.at(-1)).not.toHaveProperty("parentSessionId");
    expect(titleRequests.at(-1)?.cursor).toBeUndefined();
    expect(messageRequests.filter((request) => !request.sessionId).at(-1)).not.toHaveProperty(
      "parentSessionId",
    );
    expect(document.querySelectorAll("[data-search-result]").length).toBe(2);
    await selectScope("Parent sessions");
    expect(document.body.textContent).not.toContain("needle child");
    await flush(20);
    expect(document.querySelectorAll("[data-search-result]").length).toBe(1);
    expect(titleRequests.at(-1)?.parentSessionId).toBeNull();
    expect(titleRequests.at(-1)?.cursor).toBeUndefined();
    expect(document.querySelector('[aria-label="Search session status"]')).not.toBeNull();
    const status = document.querySelector<HTMLSelectElement>(
      '[aria-label="Search session status"]',
    )!;
    await act(async () => {
      status.value = "archived";
      status.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush(20);
    await selectScope("All sessions");
    await flush(20);
    expect(titleRequests.at(-1)?.archiveStatus).toBe("archived");
    expect(titleRequests.at(-1)?.cursor).toBeUndefined();
  } finally {
    titlePagination = false;
    await view.unmount();
  }
});

afterAll(() => mock.restore());

test("StrictMode draft undo preserves results; isolated retries recover safely after denial", async () => {
  failure = 503;
  selectedFailure = null;
  const view = await renderComponent(
    <StrictMode>
      <Dialog workspaceId="w" open onOpenChange={() => {}} />
    </StrictMode>,
  );
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Search session titles and messages"]',
  )!;
  const type = async (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "e", bubbles: true }));
    });
  try {
    await type("needle");
    await flush(280);
    await flush(20);
    expect(document.querySelectorAll("[data-search-result]").length).toBe(1);
    expect(document.body.textContent).not.toContain("private diagnostics");
    const titlesBefore = titleReads;
    await type("needlex");
    expect(document.body.textContent).toContain("Showing results for “needle”");
    expect(document.querySelectorAll("[data-search-result]").length).toBe(1);
    await type("needle");
    await flush(280);
    expect(titleReads).toBe(titlesBefore);
    expect(queries).not.toContain("needlex");
    const clickRetry = async () =>
      act(async () =>
        [...document.querySelectorAll("button")]
          .find((button) => button.textContent === "Retry search")!
          .click(),
      );
    const messagesBefore = messageReads;
    await clickRetry();
    await flush(20);
    expect(messageReads).toBeGreaterThan(messagesBefore);
    expect(titleReads).toBe(titlesBefore);
    expect(document.querySelectorAll("[data-search-result]").length).toBe(1);
    failure = 403;
    await clickRetry();
    await flush(20);
    expect(document.querySelectorAll("[data-search-result]").length).toBe(0);
    expect(document.body.textContent).not.toContain("needle title");
    expect(document.querySelector('[aria-label="Conversation preview"]')).toBeNull();
    failure = 503;
    await clickRetry();
    await flush(20);
    expect(document.querySelectorAll("[data-search-result]").length).toBe(0);
    expect(document.body.textContent).not.toContain("needle title");
    failure = 200;
    let releaseMessages!: () => void;
    messageGate = new Promise<void>((resolve) => {
      releaseMessages = resolve;
    });
    await clickRetry();
    await flush(20);
    // The healthy title read has returned, but live message authorization has
    // not: neither that title nor the old selected preview may be exposed.
    expect(document.querySelectorAll("[data-search-result]").length).toBe(0);
    expect(document.body.textContent).not.toContain("needle title");
    expect(document.querySelector('[aria-label="Conversation preview"]')).toBeNull();
    await act(async () => {
      messageGate = null;
      releaseMessages();
    });
    await flush(20);
    expect(document.querySelectorAll("[data-search-result]").length).toBe(1);
    // A denial originating only in the selected preview must also recover.
    // StrictMode must not revive its previous denial on the second render.
    selectedFailure = 403;
    await type("needle again");
    await flush(280);
    await flush(20);
    await flush(20);
    expect(document.querySelectorAll("[data-search-result]").length).toBe(0);
    selectedFailure = 200;
    await clickRetry();
    await flush(20);
    await flush(20);
    expect(document.querySelectorAll("[data-search-result]").length).toBe(1);
    await type("");
    expect(document.querySelectorAll("[data-search-result]").length).toBe(0);
  } finally {
    await view.unmount();
  }
});

test("opening a title hit marks the conversation as reached from session search", async () => {
  failure = 200;
  selectedFailure = 200;
  const view = await renderComponent(<Dialog workspaceId="w" open onOpenChange={() => {}} />);
  try {
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search session titles and messages"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "needle",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "e", bubbles: true }));
    });
    await flush(280);
    await flush(220);
    await flush(220);
    const open = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Open session",
    );
    expect(open).toBeDefined();
    await act(async () => open!.click());
    expect(navigations.at(-1)?.search).toEqual({
      find: "needle",
      searchOrigin: "session-search",
    });
  } finally {
    await view.unmount();
  }
});
