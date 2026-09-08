import { afterEach, expect, test } from "bun:test";
import { OpenGeniChat } from "../src/chat";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function history(user: string): Response {
  return Response.json({
    messages: [{ role: "assistant", text: `${user} private transcript` }],
    pending: [{ kind: "approval", requestId: user, name: `${user}_tool`, payload: {} }],
  });
}

function draft(container: HTMLElement, text: string): void {
  const textarea = container.querySelector("textarea")!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
    textarea,
    text,
  );
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

test("changed header values clear private state while equivalent headers preserve it", async () => {
  const requestedUsers: string[] = [];
  const bobHistory = Promise.withResolvers<Response>();
  globalThis.fetch = (async (_url, init) => {
    const user = new Headers(init?.headers).get("x-user")!;
    requestedUsers.push(user);
    return user === "bob" ? bobHistory.promise : history(user);
  }) as typeof fetch;
  const r = await renderComponent(
    <OpenGeniChat
      handlerUrl="/chat"
      conversation="same"
      headers={{ "X-User": "alice", "X-Tenant": "acme" }}
    />,
  );
  try {
    await flush();
    await actRun(() => draft(r.container, "Alice unsent private draft"));
    await r.rerender(
      <OpenGeniChat
        handlerUrl="/chat"
        conversation="same"
        headers={{ "x-tenant": "acme", "x-user": "alice" }}
      />,
    );
    expect(requestedUsers).toEqual(["alice"]);
    expect(r.container.querySelector("textarea")!.value).toContain("Alice unsent");
    expect(r.container.textContent).toContain("alice private transcript");
    expect(r.container.textContent).toContain("alice_tool");

    await r.rerender(
      <OpenGeniChat handlerUrl="/chat" conversation="same" headers={{ "x-user": "bob" }} />,
    );
    expect(requestedUsers).toEqual(["alice", "bob"]);
    expect(r.container.querySelector(".og-chat-messages")!.textContent).toBe("");
    expect(r.container.querySelector(".og-chat-pending")).toBeNull();
    expect(r.container.querySelector("textarea")!.value).toBe("");
    expect(r.container.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(
      true,
    );
    await actRun(() => bobHistory.resolve(history("bob")));
    expect(r.container.textContent).toContain("bob private transcript");
    expect(r.container.textContent).not.toContain("alice");
  } finally {
    await r.unmount();
  }
});

test.each(["callback", "cookie"] as const)(
  "%s authentication can change with the same conversation and stable header callback",
  async (mode) => {
    let user = "alice";
    const headers = () => (mode === "callback" ? { "x-user": user } : {});
    const requests: { method: string; user: string | null; body: unknown }[] = [];
    globalThis.fetch = (async (_url, init) => {
      requests.push({
        method: init!.method!,
        user: new Headers(init?.headers).get("x-user"),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return init?.method === "GET"
        ? history(user)
        : new Response('event: chunk\ndata: {"type":"done","reply":{"pending":null}}\n\n');
    }) as typeof fetch;
    const component = () => (
      <OpenGeniChat
        handlerUrl="/chat"
        conversation="same"
        headers={headers}
        authKey={mode === "cookie" ? user : undefined}
      />
    );
    const r = await renderComponent(component());
    try {
      await flush();
      expect(r.container.textContent).toContain("alice private transcript");
      user = "bob";
      await r.rerender(component());
      await flush();
      expect(requests.filter((request) => request.method === "GET")).toHaveLength(2);
      expect(r.container.textContent).not.toContain("alice");
      expect(r.container.textContent).toContain("bob private transcript");
      await actRun(() =>
        r.container.querySelector<HTMLButtonElement>(".og-chat-pending button")!.click(),
      );
      expect(requests.at(-1)).toEqual({
        method: "POST",
        user: mode === "callback" ? "bob" : null,
        body: { requestId: "bob", decision: "approve" },
      });
    } finally {
      await r.unmount();
    }
  },
);

test.each(["history", "stream", "error"] as const)(
  "a late %s from the previous user cannot modify the new conversation",
  async (kind) => {
    const late = Promise.withResolvers<Response>();
    let oldSignal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_url, init) => {
      const user = new Headers(init?.headers).get("x-user")!;
      if (user === "alice" && (kind === "history" || init?.method === "POST")) {
        oldSignal = init?.signal;
        return late.promise;
      }
      return history(user);
    }) as typeof fetch;
    const component = (user: string) => (
      <OpenGeniChat handlerUrl="/chat" conversation="same" headers={{ "x-user": user }} />
    );
    const r = await renderComponent(component("alice"));
    try {
      await flush();
      if (kind !== "history") {
        await actRun(() => draft(r.container, "Alice request"));
        await actRun(() => r.container.querySelector("form")!.requestSubmit());
      }
      await r.rerender(component("bob"));
      await flush();
      expect(oldSignal?.aborted).toBe(true);
      await actRun(() =>
        late.resolve(
          kind === "history"
            ? history("alice")
            : kind === "error"
              ? new Response("late failure", { status: 503 })
              : new Response(
                  'event: chunk\ndata: {"type":"text","text":"Alice late text"}\n\n' +
                    'event: chunk\ndata: {"type":"pending","pending":{"kind":"approval","requestId":"alice","name":"alice_tool"}}\n\n',
                ),
        ),
      );
      await flush();
      expect(r.container.textContent).not.toMatch(/alice/i);
      expect(r.container.textContent).toContain("bob private transcript");
      expect(r.container.querySelector(".og-chat-pending")!.textContent).toContain("bob_tool");
      expect(r.container.querySelector(".og-chat-error")).toBeNull();
      await actRun(() => draft(r.container, "Bob request"));
      expect(r.container.querySelector<HTMLButtonElement>("button[type=submit]")!.disabled).toBe(
        false,
      );
    } finally {
      await r.unmount();
    }
  },
);
