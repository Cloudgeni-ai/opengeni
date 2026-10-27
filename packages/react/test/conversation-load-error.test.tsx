import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { lazy, type ReactElement } from "react";

import { MessageTimeline, type AgentMessageItem, type UserMessageItem } from "../src";
import { ConversationRenderBoundary } from "../src/components/conversation-render-boundary";
import { flush, registerDom, renderComponent, type RenderedComponent } from "./render-hook";

registerDom();

let mounted: RenderedComponent | null = null;

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
});

function Throws({ error }: { error: Error }): never {
  throw error;
}

const chunkError = () =>
  new TypeError(
    "Failed to fetch dynamically imported module: https://app.example.test/assets/chat-4f1.js",
  );

async function renderFailure(error: Error): Promise<HTMLElement> {
  const quiet = spyOn(console, "error").mockImplementation(() => {});
  try {
    mounted = await renderComponent(
      <ConversationRenderBoundary resetKey="chat">
        <Throws error={error} />
      </ConversationRenderBoundary>,
    );
  } finally {
    quiet.mockRestore();
  }
  const alert = mounted.container.querySelector<HTMLElement>('[role="alert"]');
  if (!alert) throw new Error("missing the failure message");
  return alert;
}

describe("a part of the chat that fails to download", () => {
  test("asks for a reload instead of a Try again that would reuse the failed download", async () => {
    const alert = await renderFailure(chunkError());
    expect(alert.textContent).toContain("This didn't load. Check your connection, then reload.");
    const buttons = [...alert.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Reload"]);
  });

  test("other rendering failures keep Try again", async () => {
    const alert = await renderFailure(new Error("unexpected payload"));
    expect(alert.textContent).toContain("This chat couldn't be displayed.");
    const buttons = [...alert.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Try again"]);
  });

  const userMessage = (id: string, text: string): UserMessageItem => ({
    kind: "user-message",
    id,
    text,
    resources: [],
    tools: [],
    occurredAt: "2026-01-01T00:00:00.000Z",
  });
  // A lazy part whose code fails to download, as when its chunk request fails.
  const NotDownloaded = lazy(() => Promise.reject(chunkError()));

  async function renderTimeline(element: ReactElement): Promise<string> {
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      mounted = await renderComponent(element);
      await flush();
      await flush();
    } finally {
      quiet.mockRestore();
    }
    return mounted.container.textContent ?? "";
  }

  test("message actions that didn't download leave the message itself visible", async () => {
    const text = await renderTimeline(
      <MessageTimeline
        items={[userMessage("first", "First message"), userMessage("second", "Second message")]}
        renderMessageActions={(item) => (item.id === "second" ? <NotDownloaded /> : null)}
      />,
    );
    expect(text).toContain("First message");
    expect(text).toContain("Second message");
    expect(text).not.toContain("Timeline item unavailable");
    // Actions repeat on every message, so a missing one stays quiet.
    expect(mounted!.container.querySelectorAll("[data-og-load-failure]")).toHaveLength(0);
  });

  test("an inline preview that didn't download offers Reload beside the message text", async () => {
    const agentMessage: AgentMessageItem = {
      kind: "agent-message",
      id: "answer",
      turnId: "turn",
      text: "Here is the chart.\n\n```opengeni-html\n<p>chart</p>\n```\n\nIt shows the totals.",
      streaming: false,
      occurredAt: "2026-01-01T00:00:00.000Z",
    };
    const text = await renderTimeline(
      <MessageTimeline items={[agentMessage]} renderInteractiveBlock={() => <NotDownloaded />} />,
    );
    expect(text).toContain("Here is the chart.");
    expect(text).toContain("It shows the totals.");
    expect(text).not.toContain("Timeline item unavailable");
    const notices = mounted!.container.querySelectorAll('[data-og-load-failure="inline"]');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.textContent).toBe("This part didn't load.Reload");
  });

  test("a timeline item whose own code didn't download offers Reload in its place", async () => {
    const text = await renderTimeline(
      <MessageTimeline
        items={[userMessage("first", "First message"), userMessage("second", "Second message")]}
        renderMessageText={(value, item) =>
          item.id === "second" ? <Throws error={chunkError()} /> : value
        }
      />,
    );
    expect(text).toContain("First message");
    expect(text).not.toContain("Timeline item unavailable");
    const notices = mounted!.container.querySelectorAll('[data-og-load-failure="inline"]');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.textContent).toBe("This part didn't load.Reload");
  });

  test("other failures in a lazy part still reach the item's own boundary", async () => {
    const text = await renderTimeline(
      <MessageTimeline
        items={[userMessage("first", "First message"), userMessage("second", "Second message")]}
        renderMessageActions={(item) =>
          item.id === "second" ? <Throws error={new Error("bad actions")} /> : null
        }
      />,
    );
    expect(text).toContain("First message");
    expect(text).toContain("Timeline item unavailable");
  });
});
