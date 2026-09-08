import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { SessionModelContextResponse } from "@opengeni/sdk";

GlobalRegistrator.register();
const { createRoot } = await import("react-dom/client");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const getSessionModelContext = mock(async (): Promise<SessionModelContextResponse> => response);
const client = { getSessionModelContext };
mock.module("@/context", () => ({ useAppContext: () => ({ client }) }));
mock.module("sonner", () => ({ toast: { error: mock(), success: mock() } }));
const { ModelContextInspectorPane } = await import("./model-context-inspector");
const { ContextTextReader, textBlocks } = await import("./context-text-reader");
const response: SessionModelContextResponse = {
  sessionId: "s",
  turnId: "t",
  attemptId: "a",
  snapshot: {
    version: 1,
    source: "model_request",
    capturedAt: "2026-09-08T12:00:00.000Z",
    requestIndex: 2,
    instructions: "",
    layers: [],
    tools: [],
    skills: [],
    tokens: { instructions: 1, tools: 1, prefix: 2 },
    providerRequest: {
      provider: "test",
      body: '{"instructions":"EXACT SENT TEXT","input":[{"role":"user","content":"Hello"}]}',
      parts: [
        { key: "instructions", estimatedTokens: 4, utf8Bytes: 17 },
        { key: "input", estimatedTokens: 8, utf8Bytes: 30 },
      ],
    },
  },
};
afterAll(() => {
  mock.restore();
  GlobalRegistrator.unregister();
});

describe("model context inspector", () => {
  test("discloses captured content, labels estimates and never substitutes unrelated usage", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(
          <ModelContextInspectorPane
            workspaceId="w"
            sessionId="s"
            events={[
              { type: "agent.model.usage", sequence: 9, payload: { inputTokens: 99999 } } as never,
            ]}
          />,
        ),
      );
      expect(container.textContent).toContain("Captured request · tokens estimated");
      expect(container.textContent).toContain("~4");
      expect(container.textContent).not.toContain("99,999");
      expect(container.textContent).toContain("Hello");
      expect(container.textContent).not.toContain("derived");
      expect(container.textContent).not.toContain("bytes");
      expect(container.textContent).not.toContain("EXACT SENT TEXT");
      const button = [...container.querySelectorAll("button")].find((item) =>
        item.textContent?.startsWith("Instructions"),
      )!;
      await act(async () => button.click());
      expect(container.textContent).toContain("EXACT SENT TEXT");
      expect(button.getAttribute("aria-pressed")).toBe("true");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("legacy prefixes are explicitly incomplete", async () => {
    getSessionModelContext.mockResolvedValueOnce({
      ...response,
      snapshot: {
        ...response.snapshot!,
        providerRequest: undefined,
        instructions: "legacy prefix",
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<ModelContextInspectorPane workspaceId="w" sessionId="old" events={[]} />),
      );
      expect(container.textContent).toContain("This older capture contains only instructions.");
      expect(container.textContent).toContain("The full request was not recorded");
      expect(
        [...container.querySelectorAll("button")].some((button) =>
          button.textContent?.includes("Copy request"),
        ),
      ).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  test("large captures keep list and single-item DOM bounded", async () => {
    const input = Array.from({ length: 6000 }, (_, index) => ({
      role: "user",
      content: `message ${index}`,
    }));
    input[5999] = { role: "user", content: "HUGE-START " + "x".repeat(1_000_000) + " HUGE-END" };
    getSessionModelContext.mockResolvedValueOnce({
      ...response,
      snapshot: {
        ...response.snapshot!,
        providerRequest: {
          provider: "test",
          body: JSON.stringify({ input }),
          parts: [
            {
              key: "input",
              utf8Bytes: 0,
              estimatedTokens: 300000,
              itemEstimatedTokens: input.map((_, i) => (i === 5999 ? 250000 : 4)),
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const button = (text: string) =>
      [...container.querySelectorAll("button")].find((item) => item.textContent === text)!;
    try {
      await act(async () =>
        root.render(<ModelContextInspectorPane workspaceId="w" sessionId="large" events={[]} />),
      );
      expect(container.querySelectorAll("[data-context-row]").length).toBe(30);
      expect(container.textContent!.length).toBeLessThan(15000);
      expect(container.textContent).toContain("6,000 items");
      expect(container.textContent).toContain("HUGE-START");
      await act(async () =>
        (container.querySelector("[data-context-row]") as HTMLButtonElement).click(),
      );
      expect(container.textContent!.length).toBeLessThan(30000);
      expect(container.textContent).not.toContain("Previous text");
      expect(container.querySelector('input[type="number"]')).toBeNull();
      await act(async () => button("Back to results").click());
      await act(async () => button("Next").click());
      expect(container.querySelectorAll("[data-context-row]").length).toBe(30);
      expect(container.textContent).toContain("31–60 of 6,000");
      expect(container.textContent).not.toContain("HUGE-START");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
  test("reader preserves full source and reveals search only on request", async () => {
    const text =
      "İ Opening paragraph.\n\n" +
      "Readable paragraph.\n\n".repeat(1000) +
      "End marker. End marker. [literal]";
    expect(
      textBlocks(text)
        .map((block) => block.text)
        .join(""),
    ).toBe(text);
    const unbroken = "😀".repeat(100000);
    expect(
      textBlocks(unbroken)
        .map((block) => block.text)
        .join(""),
    ).toBe(unbroken);
    expect(textBlocks(unbroken).every((block) => block.text.length <= 2000)).toBe(true);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<ContextTextReader text={text} />));
      expect(container.textContent).toContain(text);
      expect(container.querySelector("input")).toBeNull();
      expect(container.textContent).not.toContain("Part 1");
      const find = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Find",
      )!;
      await act(async () => find.click());
      const input = container.querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "End marker",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.querySelector("mark")?.textContent).toBe("End marker");
      expect(container.textContent).toContain("1/2");
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      expect(container.textContent).toContain("2/2");
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "[literal]",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(container.querySelector("mark")?.textContent).toBe("[literal]");
      const jump = mock();
      container.querySelector("mark")!.scrollIntoView = jump;
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      expect(jump).toHaveBeenCalled();

      await act(async () =>
        (container.querySelector('[aria-label="Close find"]') as HTMLButtonElement).click(),
      );
      expect(container.querySelector("input")).toBeNull();
      expect(container.textContent).toContain(text);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
