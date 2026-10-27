import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { ConversationRenderBoundary } from "../src/components/conversation-render-boundary";
import { registerDom, renderComponent, type RenderedComponent } from "./render-hook";

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
    const alert = await renderFailure(
      new TypeError(
        "Failed to fetch dynamically imported module: https://app.example.test/assets/chat-4f1.js",
      ),
    );
    expect(alert.textContent).toContain(
      "Part of this chat didn't load. Check your connection, then reload.",
    );
    const buttons = [...alert.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Reload"]);
  });

  test("other rendering failures keep Try again", async () => {
    const alert = await renderFailure(new Error("unexpected payload"));
    expect(alert.textContent).toContain("This chat couldn't be displayed.");
    const buttons = [...alert.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Try again"]);
  });
});
