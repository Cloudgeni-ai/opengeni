import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { UserMessageItem } from "../src";
import type { ActivityItem } from "../src/timeline/types";
import type { RenderedComponent } from "./render-hook";

// Lazy parts inside timeline items whose code fails to download, as when their
// chunk request fails. The mocked module yields the browser's download error
// where the part would render, which reaches the same boundaries as a failed
// import and also holds when another file in the process loaded it first.
const notDownloaded = (name: string) => () => ({
  default: function NotDownloaded(): never {
    throw new TypeError(
      `Failed to fetch dynamically imported module: https://app.example.test/assets/${name}-4f1.js`,
    );
  },
});
const ATTACHMENTS = "../src/app/components/session/message-resource-attachments";
const PLATFORM_ROW = "../src/timeline/platform-activity-row";
// Copies of the real modules, put back afterwards for any later file in the
// same process (CI runs each file alone).
const realAttachments = { ...(await import(ATTACHMENTS)) };
const realPlatformRow = { ...(await import(PLATFORM_ROW)) };
mock.module(ATTACHMENTS, notDownloaded("message-resource-attachments"));
mock.module(PLATFORM_ROW, notDownloaded("platform-activity-row"));
afterAll(() => {
  mock.module(ATTACHMENTS, () => realAttachments);
  mock.module(PLATFORM_ROW, () => realPlatformRow);
});

const { MessageTimeline } = await import("../src");
const { UserMessageBody } = await import("../src/app/components/session/banners");
const { ActivityRail } = await import("../src/timeline/activity-rail");
const { flush, registerDom, renderComponent } = await import("./render-hook");

registerDom();

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
});

const message = (id: string, text: string, resources: UserMessageItem["resources"]) =>
  ({
    kind: "user-message",
    id,
    text,
    resources,
    tools: [],
    occurredAt: "2026-01-01T00:00:00.000Z",
  }) satisfies UserMessageItem;

describe("a user message whose attachments' code didn't download", () => {
  test("keeps the message, its text and its repository chips, and offers Reload for the files", async () => {
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      mounted = await renderComponent(
        <MessageTimeline
          items={[
            message("first", "Earlier message", []),
            message("second", "Summarise the attached notes", [
              { kind: "file", fileId: "file-1" },
              { kind: "repository", uri: "https://github.com/example/project.git", ref: "main" },
            ]),
          ]}
          renderMessageText={(_text, item) =>
            item.kind === "user-message" ? (
              <UserMessageBody workspaceId="workspace-1" sessionId="session-1" item={item} />
            ) : null
          }
        />,
      );
      await flush();
      await flush();
    } finally {
      quiet.mockRestore();
    }
    const container = mounted.container;
    const text = container.textContent ?? "";
    expect(text).toContain("Earlier message");
    expect(text).toContain("Summarise the attached notes");
    expect(text).not.toContain("Timeline item unavailable");
    // Both messages keep their bubbles.
    expect(container.querySelectorAll('[data-testid="timeline-user"]')).toHaveLength(2);
    // The repository chip stays; only the files give way to one Reload notice.
    expect(text).toContain("project");
    const notices = container.querySelectorAll('[data-og-load-failure="inline"]');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.textContent).toBe("This part didn't load.Reload");
    expect(notices[0]?.closest('[data-testid="timeline-user"]')).not.toBeNull();
  });
});

describe("a work row whose code didn't download", () => {
  test("gives way to a Reload notice while the rest of the rail stays", async () => {
    const items: ActivityItem[] = [
      {
        kind: "reasoning",
        id: "thought",
        turnId: "turn-1",
        text: "Considering options",
        streaming: false,
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
      {
        kind: "tool-call",
        id: "tool",
        turnId: "turn-1",
        callId: "call-tool",
        name: "exec_command",
        status: "complete",
        occurredAt: "2026-01-01T00:00:01.000Z",
        arguments: { command: "echo rail-still-here" },
        output: undefined,
        raw: undefined,
      },
    ];
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      mounted = await renderComponent(<ActivityRail items={items} bare />);
      await flush();
      await flush();
    } finally {
      quiet.mockRestore();
    }
    const container = mounted.container;
    expect(container.querySelector('[data-og-item="tool"]')).not.toBeNull();
    const thought = container.querySelector('[data-og-item="thought"]');
    expect(thought?.querySelector('[data-og-load-failure="inline"]')?.textContent).toBe(
      "This part didn't load.Reload",
    );
    expect(container.querySelectorAll("[data-og-load-failure]")).toHaveLength(1);
  });
});
