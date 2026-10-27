import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { MessageTimeline, type UserMessageItem } from "../src";
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

  test("one timeline item whose code didn't download offers Reload in its place", async () => {
    const message = (id: string, text: string): UserMessageItem => ({
      kind: "user-message",
      id,
      text,
      resources: [],
      tools: [],
      occurredAt: "2026-01-01T00:00:00.000Z",
    });
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      mounted = await renderComponent(
        <MessageTimeline
          items={[message("first", "First message"), message("second", "Second message")]}
          // The message actions are a lazy part of the timeline; this one failed to download.
          renderMessageActions={(item) =>
            item.id === "second" ? <Throws error={chunkError()} /> : null
          }
        />,
      );
      await flush();
    } finally {
      quiet.mockRestore();
    }
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("First message");
    expect(text).not.toContain("Timeline item unavailable");
    const notices = mounted.container.querySelectorAll('[data-og-load-failure="inline"]');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.textContent).toBe("This part didn't load.Reload");
    expect(notices[0]?.querySelector("button")?.textContent).toBe("Reload");
  });
});
