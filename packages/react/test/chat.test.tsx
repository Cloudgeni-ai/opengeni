import { afterEach, describe, expect, test } from "bun:test";
import { OpenGeniChat } from "../src/chat";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

type Recorded = { url: string; method: string; headers: Record<string, string>; body: unknown };

function nativeSse(chunks: unknown[]): Response {
  const wire = chunks.map((chunk) => `event: chunk\ndata: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(wire, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Stub `fetch`; `respond` answers POSTs, `history` answers the mount-time GET (404 by default). */
function stubFetch(
  respond: (request: Recorded) => Response,
  history: (request: Recorded) => Response = () => new Response("", { status: 404 }),
): Recorded[] {
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
    return request.method === "GET" ? history(entry) : respond(entry);
  }) as typeof fetch;
  return recorded;
}

function posts(recorded: Recorded[]): Recorded[] {
  return recorded.filter((request) => request.method === "POST");
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
  test("restores an approval after reload even without text, and retains it after a failed response", async () => {
    const pending = {
      kind: "approval",
      requestId: "restored-approval",
      name: "delete_file",
      payload: {},
    };
    let succeed = false;
    const requests = stubFetch(
      () =>
        succeed
          ? nativeSse([{ type: "done", reply: { pending: null, status: "completed" } }])
          : new Response("temporary error", { status: 503 }),
      () =>
        new Response(
          JSON.stringify({ messages: [], pending: [pending], status: "requires_action" }),
        ),
    );
    const r = await renderComponent(
      <OpenGeniChat handlerUrl="/api/chat" conversation="restored" />,
    );
    try {
      await flush(10);
      expect(r.container.querySelector(".og-chat-pending")?.textContent).toContain("delete_file");
      await actRun(() =>
        r.container.querySelector<HTMLButtonElement>(".og-chat-pending button")!.click(),
      );
      await flush(10);
      expect(posts(requests)[0]?.body).toEqual({
        requestId: "restored-approval",
        decision: "approve",
      });
      expect(r.container.querySelector(".og-chat-pending")).not.toBeNull();
      succeed = true;
      await actRun(() =>
        r.container.querySelector<HTMLButtonElement>(".og-chat-pending button")!.click(),
      );
      await flush(10);
      expect(r.container.querySelector(".og-chat-pending")).toBeNull();
    } finally {
      await r.unmount();
    }
  });

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

    expect(posts(requests)).toHaveLength(1);
    expect(posts(requests)[0]).toMatchObject({
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
            {
              type: "done",
              reply: {
                text: "May I?",
                status: "pending",
                pending: {
                  kind: "approval",
                  requestId: "call_9",
                  name: "delete_file",
                  payload: {},
                },
              },
            },
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

    expect(posts(requests)[1]).toMatchObject({
      url: "http://localhost:3000/api/chat/respond",
      body: { requestId: "call_9", decision: "approve" },
    });
    expect(r.container.querySelector(".og-chat-pending")).toBeNull();
    expect(r.container.querySelector(".og-chat-assistant")?.textContent).toContain("May I? Done.");
    await r.unmount();
  });

  test("restores the conversation history from GET on mount and when the conversation changes", async () => {
    const histories: Record<string, unknown[]> = {
      c_9: [
        { role: "user", text: "earlier question", sequence: 2 },
        { role: "assistant", text: "earlier **answer**", sequence: 5 },
      ],
      c_10: [{ role: "user", text: "other thread", sequence: 2 }],
    };
    const requests = stubFetch(
      () => nativeSse([{ type: "done", reply: { text: "", status: "completed" } }]),
      (request) => {
        const conversation = request.headers["x-opengeni-conversation"] ?? "";
        return new Response(
          JSON.stringify({
            conversation,
            sessionId: "22222222-2222-4222-8222-222222222222",
            created: true,
            messages: histories[conversation] ?? [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    const r = await renderComponent(
      <OpenGeniChat handlerUrl="/api/chat" conversation="c_9" headers={{ "x-user": "u_42" }} />,
    );
    await flush(10);

    expect(requests[0]).toMatchObject({
      url: "http://localhost:3000/api/chat",
      method: "GET",
      headers: { "x-opengeni-conversation": "c_9", "x-user": "u_42" },
    });
    expect(r.container.querySelector(".og-chat-user")?.textContent).toBe("earlier question");
    const assistant = r.container.querySelector(".og-chat-assistant")!;
    expect(assistant.textContent).toContain("earlier answer");
    expect(assistant.querySelector("strong")?.textContent).toBe("answer");
    expect(r.container.querySelector("textarea")?.disabled).toBeFalsy();
    expect(r.container.querySelector("button[type=submit]")).not.toBeNull();

    await r.rerender(
      <OpenGeniChat handlerUrl="/api/chat" conversation="c_10" headers={{ "x-user": "u_42" }} />,
    );
    await flush(10);
    expect(requests.filter((request) => request.method === "GET")).toHaveLength(2);
    expect([...r.container.querySelectorAll(".og-chat-user")].map((el) => el.textContent)).toEqual([
      "other thread",
    ]);
    expect(r.container.querySelector(".og-chat-assistant")).toBeNull();
    await r.unmount();
  });

  test("keeps working when the host does not serve history", async () => {
    stubFetch(() => nativeSse([{ type: "done", reply: { text: "", status: "completed" } }]));
    const r = await renderComponent(<OpenGeniChat handlerUrl="/api/chat" conversation="c_9" />);
    await flush(10);
    expect(r.container.querySelector(".og-chat-error")).toBeNull();
    expect(r.container.querySelectorAll(".og-chat-user")).toHaveLength(0);
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
