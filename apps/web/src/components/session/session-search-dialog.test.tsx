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
const queries: string[] = [];
const client = {
  listSessionPage: async (_workspace: string, options: { search: string; signal: AbortSignal }) => {
    titleReads++;
    queries.push(options.search);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return {
      pinned: [],
      sessions: [{ id: "s", title: "needle title", updatedAt: "2026-01-01", initialMessage: "" }],
      nextCursor: null,
    };
  },
  searchSessionMessages: async (_workspace: string, options: { sessionId?: string }) => {
    messageReads++;
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
  mock.module("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
  Dialog = (await import("./session-search-dialog")).default;
});
afterAll(() => mock.restore());

test("StrictMode draft undo preserves results; isolated retries recover safely after denial", async () => {
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
