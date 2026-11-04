import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ComponentType } from "react";

GlobalRegistrator.register({ url: "https://app.test/" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const workspaceId = "11111111-1111-4111-8111-111111111111";
const subjectId = `switcher-${crypto.randomUUID()}`;
const client = {
  listSessionSummaryPage: async () => ({ pinned: [], sessions: [], nextCursor: null }),
  getSession: async () => {
    throw new Error("not needed");
  },
};

const row = (id: string, title: string, parentSessionId: string | null = null) => ({
  id,
  workspaceId,
  parentSessionId,
  title,
  titleSource: "user",
  status: "idle",
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
});

let ChatSwitcher: ComponentType<Record<string, unknown>>;
let directory: typeof import("../../lib/actions/chat-directory");
let switcher: typeof import("../../lib/actions/chat-switcher");

beforeAll(async () => {
  mock.module("../../app-context", () => ({ useAppContext: () => ({ client }) }));
  ChatSwitcher = (await import("./chat-switcher")).default as never;
  directory = await import("../../lib/actions/chat-directory");
  switcher = await import("../../lib/actions/chat-switcher");
});

afterAll(async () => {
  mock.restore();
  await GlobalRegistrator.unregister();
});

test("a sub-agent chat the person opened shows in the list, saying which chat it belongs to", async () => {
  directory.rememberChats(subjectId, [row("lead", "Release lead")] as never);
  directory.recordChatVisit(subjectId, row("worker", "Fix flaky test", "lead") as never);
  directory.recordChatVisit(subjectId, row("lead", "Release lead") as never);
  const state = switcher.openChatSwitcher(
    directory.readChatDirectory(subjectId, workspaceId),
    "lead",
    false,
  )!;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const noop = () => {};
  await act(async () => {
    root.render(
      <ChatSwitcher
        state={{ ...state, visible: true }}
        subjectId={subjectId}
        workspaceId={workspaceId}
        workspaces={[]}
        currentChatId="lead"
        platform="mac"
        onHover={noop}
        onDirectoryChange={noop}
        onPick={noop}
        onDismiss={noop}
      />,
    );
  });
  const options = [...document.querySelectorAll('[data-og-chat-switcher] [role="option"]')];
  expect(options.map((option) => option.querySelector("span.truncate")?.textContent)).toEqual([
    "Release lead",
    "Fix flaky test",
  ]);
  expect(options[1]?.getAttribute("aria-selected")).toBe("true");
  expect(options[1]?.querySelector("[data-chat-parent]")?.textContent).toBe("in Release lead");
  expect(options[0]?.querySelector("[data-chat-parent]")).toBeNull();
  await act(async () => root.unmount());
  host.remove();
});
