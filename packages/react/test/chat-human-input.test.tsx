import { afterEach, expect, test } from "bun:test";
import { OpenGeniChat } from "../src/chat";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";
registerDom();
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test("multi-select human questions must let the user select two answers", async () => {
  const submitted: unknown[] = [];
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith("/respond")) {
      submitted.push(JSON.parse(String(init?.body)));
      return new Response(
        'event: chunk\ndata: {"type":"done","reply":{"pending":null,"status":"completed"}}\n\n',
      );
    }
    if (init?.method === "GET") return new Response("", { status: 404 });
    return new Response(
      `event: chunk\ndata: ${JSON.stringify({
        type: "pending",
        pending: {
          kind: "human_input",
          requestId: "q1",
          name: null,
          payload: {
            id: "q1",
            allowSkip: false,
            expiresAt: null,
            questions: [
              {
                id: "choice",
                kind: "multi_select",
                prompt: "Choose two",
                required: true,
                validation: { minSelections: 2 },
                options: [
                  { id: "a", label: "A" },
                  { id: "b", label: "B" },
                ],
              },
            ],
          },
        },
      })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  const r = await renderComponent(<OpenGeniChat handlerUrl="/chat" conversation="one" />);
  try {
    const input = r.container.querySelector("textarea")!;
    await actRun(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input,
        "hello",
      );
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await actRun(() => r.container.querySelector("form")!.requestSubmit());
    await flush(10);
    expect(r.container.querySelector(".og-chat-pending")).not.toBeNull();
    const checks = r.container.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect(checks.length).toBe(3); // The two options plus Other.
    const form = r.container.querySelector<HTMLFormElement>(".og-chat-pending form")!;
    await actRun(() => form.requestSubmit());
    expect(submitted).toEqual([]);
    expect(r.container.textContent).toContain("Choose at least 2");
    await actRun(() => checks[0]!.click());
    await actRun(() => checks[1]!.click());
    await actRun(() => form.requestSubmit());
    await flush(10);
    expect(submitted).toEqual([
      { requestId: "q1", answers: [{ questionId: "choice", values: ["a", "b"] }] },
    ]);
  } finally {
    await r.unmount();
  }
});
