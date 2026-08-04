import { afterEach, describe, expect, test } from "bun:test";
import {
  Markdown,
  MessageTimeline,
  UserMessageBody,
  type TimelineItem,
  type UserMessageItem,
} from "../src";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const originalResizeObserver = globalThis.ResizeObserver;

afterEach(() => {
  globalThis.ResizeObserver = originalResizeObserver;
});

function longMarkdown(): string {
  const unbroken = `https://example.test/${"continuously-wrapped-segment-".repeat(24)}`;
  return [
    "# A complete long prompt",
    "",
    "This paragraph stays lossless even while the rendered presentation is collapsed. ".repeat(8),
    "",
    "- First list item",
    "- Second list item with **bold** and _emphasis_",
    "- Third list item",
    "",
    "> A block quote whose complete source remains mounted.",
    "",
    "```ts",
    "const unicode = 'こんにちは · مرحبا · 👩🏽‍💻';",
    "console.log(unicode);",
    "```",
    "",
    unbroken,
    "",
    "Final paragraph after the long URL.",
  ].join("\n");
}

function user(id: string, text: string): UserMessageItem {
  return {
    kind: "user-message",
    id,
    text,
    resources: [],
    tools: [],
    occurredAt: "2026-08-04T20:00:00.000Z",
  };
}

function agent(text: string): TimelineItem {
  return {
    kind: "agent-message",
    id: "assistant-stream",
    turnId: "turn-1",
    text,
    streaming: true,
    occurredAt: "2026-08-04T20:00:01.000Z",
  };
}

describe("UserMessageBody", () => {
  test("keeps the complete Markdown subtree mounted behind an accessible disclosure", async () => {
    const text = longMarkdown();
    const r = await renderComponent(
      <UserMessageBody messageId="message-long" text={text}>
        <Markdown>{text}</Markdown>
      </UserMessageBody>,
    );

    const button = r.container.querySelector<HTMLButtonElement>(
      "[data-og-user-message-disclosure]",
    );
    const clip = r.container.querySelector<HTMLElement>("[data-og-user-message-clip]");
    expect(button?.textContent).toBe("Show more");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.getAttribute("aria-controls")).toBe(clip?.id);
    expect(r.container.querySelector("[data-og-user-message-fade]")).not.toBeNull();
    expect(r.container.textContent).toContain("こんにちは · مرحبا · 👩🏽‍💻");
    expect(r.container.textContent).toContain("Final paragraph after the long URL.");
    expect(r.container.querySelector("pre code")?.textContent).toContain("console.log(unicode)");

    await actRun(() => button?.click());
    expect(button?.textContent).toBe("Show less");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(r.container.querySelector("[data-og-user-message-fade]")).toBeNull();
    expect(r.container.textContent).toContain("Final paragraph after the long URL.");

    await actRun(() => button?.click());
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    await r.unmount();
  });

  test("uses rendered height when layout measurement is available", async () => {
    const callbacks: ResizeObserverCallback[] = [];
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    const r = await renderComponent(
      <UserMessageBody messageId="measured" text="Short source with tall rendered children">
        <div>Measured content</div>
      </UserMessageBody>,
    );
    const content = r.container.querySelector<HTMLElement>("[data-og-user-message-content]")!;
    const threshold = r.container.querySelector<HTMLElement>("[aria-hidden='true']")!;
    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 480 });
    Object.defineProperty(threshold, "offsetHeight", { configurable: true, value: 224 });

    await actRun(() => callbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(r.container.querySelector("[data-og-user-message-disclosure]")).not.toBeNull();

    Object.defineProperty(content, "scrollHeight", { configurable: true, value: 180 });
    await actRun(() => callbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    expect(r.container.querySelector("[data-og-user-message-disclosure]")).toBeNull();
    await r.unmount();
  });

  test("leaves ordinary messages unchanged", async () => {
    const r = await renderComponent(
      <UserMessageBody messageId="short" text="Ordinary prompt">
        <p>Ordinary prompt</p>
      </UserMessageBody>,
    );
    expect(r.container.querySelector("[data-og-user-message-disclosure]")).toBeNull();
    expect(r.container.textContent).toBe("Ordinary prompt");
    await r.unmount();
  });
});

describe("MessageTimeline user-message disclosure", () => {
  test("retains per-message expansion through assistant streaming and history prepend", async () => {
    const text = longMarkdown();
    const initial = [user("long-user", text), agent("Streaming response")];
    const r = await renderComponent(<MessageTimeline items={initial} />);
    await flush();
    const button = r.container.querySelector<HTMLButtonElement>(
      "[data-og-user-message-disclosure]",
    )!;
    await actRun(() => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");

    await r.rerender(
      <MessageTimeline
        items={[
          user("older", "Earlier message"),
          user("long-user", text),
          agent("Streaming response grew without changing the user message"),
        ]}
      />,
    );
    await flush();
    expect(
      r.container
        .querySelector("[data-og-message-id='long-user'] [data-og-user-message-disclosure]")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(r.container.textContent).toContain("Earlier message");
    expect(r.container.textContent).toContain("Streaming response grew");
    await r.unmount();
  });

  test("keeps voice identity and attachments outside the collapsed text region", async () => {
    const text = longMarkdown();
    const voiceItem: TimelineItem = {
      ...user("voice-user", text),
      resources: [
        { kind: "repository", uri: "https://github.com/example/repository.git", ref: "main" },
      ],
      presentation: {
        kind: "realtime_voice_handoff",
        context: "Complete voice execution context",
      },
    };
    const r = await renderComponent(
      <MessageTimeline
        items={[voiceItem]}
        renderMessageText={(messageText, item) =>
          item.kind === "user-message" ? (
            <div data-testid="custom-user-message">
              <div data-testid="voice-identity">Voice handoff</div>
              <div data-testid="attachments">
                {item.resources.map((resource) =>
                  resource.kind === "repository" ? resource.uri : resource.fileId,
                )}
              </div>
              <UserMessageBody messageId={item.id} text={messageText}>
                <Markdown>{messageText}</Markdown>
              </UserMessageBody>
              <div data-testid="voice-context">{item.presentation?.context}</div>
            </div>
          ) : (
            messageText
          )
        }
      />,
    );
    await flush();
    const clip = r.container.querySelector("[data-og-user-message-clip]")!;
    const voice = r.container.querySelector("[data-testid='voice-identity']")!;
    const attachments = r.container.querySelector("[data-testid='attachments']")!;
    const context = r.container.querySelector("[data-testid='voice-context']")!;
    expect(clip.contains(voice)).toBe(false);
    expect(clip.contains(attachments)).toBe(false);
    expect(clip.contains(context)).toBe(false);
    expect(voice.textContent).toBe("Voice handoff");
    expect(attachments.textContent).toContain("repository.git");
    expect(context.textContent).toBe("Complete voice execution context");
    expect(
      r.container.querySelector("[data-og-user-message-disclosure]")?.getAttribute("aria-expanded"),
    ).toBe("false");
    await r.unmount();
  });
});
