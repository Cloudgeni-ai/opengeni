import { describe, expect, test } from "bun:test";
import { OpenGeni } from "../src/chat";
import { BASE_URL, ORGANIZATION_ID, fakeServer } from "./chat-helpers";

/**
 * Some fetch implementations (Next.js's patched fetch on Node) keep the SSE
 * body open after the turn settles and only settle `cancel()` once the request
 * signal aborts. Unwinding must abort first and never wait on that cancel.
 */
function neverEndingStreamFetch(base: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await base(input, init);
    if (!String(input instanceof Request ? input.url : input).includes("/events/stream")) {
      return response;
    }
    const wire = new Uint8Array(await response.arrayBuffer());
    const signal = init?.signal ?? undefined;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (!sent) {
          sent = true;
          controller.enqueue(wire);
          return;
        }
        // Never ends: no heartbeat, no close.
        await new Promise<void>(() => {});
      },
      cancel: async () => {
        // Cancel settles only after the request is aborted.
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });
    return new Response(body, { status: 200, headers: response.headers });
  }) as typeof fetch;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([promise, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
}

describe("chat stream unwinding", () => {
  test("send() settles after done even when the SSE body never ends", async () => {
    const server = fakeServer();
    const og = new OpenGeni({
      apiKey: "og_key",
      organizationId: ORGANIZATION_ID,
      baseUrl: BASE_URL,
      fetch: neverEndingStreamFetch(server.fetch),
    });
    const chat = await og.chat({ tenant: "acme", user: "u_42", conversation: "c_1" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reply = await withTimeout(chat.send(`hello ${attempt}`), 2_000);
      expect(reply === "timeout" ? reply : reply.text).toBe("Hello");
    }
  });

  test("breaking out of stream() after done returns promptly", async () => {
    const server = fakeServer();
    const og = new OpenGeni({
      apiKey: "og_key",
      organizationId: ORGANIZATION_ID,
      baseUrl: BASE_URL,
      fetch: neverEndingStreamFetch(server.fetch),
    });
    const chat = await og.chat({ tenant: "acme", user: "u_42", conversation: "c_2" });
    const consume = async () => {
      for await (const chunk of chat.stream("hi")) {
        if (chunk.type === "done") return chunk.reply.text;
      }
      return null;
    };
    expect(await withTimeout(consume(), 2_000)).toBe("Hello");
  });
});
