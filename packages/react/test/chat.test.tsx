import { afterEach, describe, expect, test } from "bun:test";
import { OpenGeniChat } from "../src/chat";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown };

function nativeSse(chunks: unknown[]): Response {
  const wire = chunks.map((chunk) => `event: chunk\ndata: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(wire, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function stubFetch(respond: (request: Recorded) => Response): Recorded[] {
  const recorded: Recorded[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(
      input instanceof Request ? input : new URL(String(input), "http://localhost:3000"),
      init,
    );
    const entry: Recorded = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    recorded.push(entry);
    return respond(entry);
  }) as typeof fetch;
  return recorded;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function setTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("OpenGeniChat", () => {
  test("posts the message to the handler and renders the streamed reply", async () => {
    const requests = stubFetch(() =>
      nativeSse([
        { type: "tool", name: "search", status: "started", callId: "c1" },
        { type: "text", text: "Hel" },
        { type: "text", text: "lo **there**" },
        {
          type: "done",
          reply: { text: "Hello there", status: "completed", pending: null, events: [] },
        },
      ]),
    );
    const r = await renderComponent(
      <OpenGeniChat handlerUrl="/api/chat" conversation="c_9" headers={{ "x-user": "u_42" }} />,
    );
    const textarea = r.container.querySelector("textarea")!;
    await actRun(() => setTextarea(textarea, "hello"));
    await actRun(() => r.container.querySelector("form")!.requestSubmit());
    await flush(10);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "http://localhost:3000/api/chat",
      method: "POST",
      headers: {
        "x-opengeni-chat-format": "native",
        "x-opengeni-conversation": "c_9",
        "x-user": "u_42",
      },
      body: { message: "hello" },
    });
    expect(r.container.querySelector(".og-chat-user")?.textContent).toBe("hello");
    const assistant = r.container.querySelector(".og-chat-assistant")!;
    expect(assistant.textContent).toContain("Used search");
    expect(assistant.textContent).toContain("Hello there");
    expect(assistant.querySelector("strong")?.textContent).toBe("there");
    expect(textarea.value).toBe("");
    await r.unmount();
  });

  test("shows a pending approval card and answers it through the respond route", async () => {
    let calls = 0;
    const requests = stubFetch(() => {
      calls += 1;
      return calls === 1
        ? nativeSse([
            { type: "text", text: "May I?" },
            {
              type: "pending",
              pending: { kind: "approval", requestId: "call_9", name: "delete_file", payload: {} },
            },
            { type: "done", reply: { text: "May I?", status: "pending" } },
          ])
        : nativeSse([
            { type: "text", text: " Done." },
            { type: "done", reply: { text: "Done.", status: "completed", pending: null } },
          ]);
    });
    const r = await renderComponent(<OpenGeniChat handlerUrl="/api/chat/" />);
    await actRun(() => setTextarea(r.container.querySelector("textarea")!, "delete it"));
    await actRun(() => r.container.querySelector("form")!.requestSubmit());
    await flush(10);

    const card = r.container.querySelector(".og-chat-pending")!;
    expect(card.textContent).toContain("delete_file");
    const approve = [...card.querySelectorAll("button")].find((b) => b.textContent === "Approve")!;
    await actRun(() => approve.click());
    await flush(10);

    expect(requests[1]).toMatchObject({
      url: "http://localhost:3000/api/chat/respond",
      body: { requestId: "call_9", decision: "approve" },
    });
    expect(r.container.querySelector(".og-chat-pending")).toBeNull();
    expect(r.container.querySelector(".og-chat-assistant")?.textContent).toContain("May I? Done.");
    await r.unmount();
  });

  test("surfaces a failed request without leaving the composer stuck", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    const r = await renderComponent(<OpenGeniChat handlerUrl="/api/chat" />);
    await actRun(() => setTextarea(r.container.querySelector("textarea")!, "hi"));
    await actRun(() => r.container.querySelector("form")!.requestSubmit());
    await flush(10);
    expect(r.container.querySelector(".og-chat-error")?.textContent).toContain("500");
    expect(r.container.querySelector("textarea")?.disabled).toBeFalsy();
    await r.unmount();
  });
});
