import { describe, expect, test } from "bun:test";
import { OpenGeniClient, createSessionProxyHandler } from "../src/index";
import { sessionEventsToSseStream } from "../src/proxy";
import { makeEvent, SESSION_ID, WORKSPACE_ID } from "./helpers";

const PRODUCT = "https://product.example.test";
const CHAT_ACCEPT = "application/json; opengeni-session=chat";
const USAGE = {
  creditsMicros: 41_230,
  tokens: { input: 18_200, output: 950 },
  breakdown: { model: 39_100, webSearch: 2_130, imageGeneration: 0, other: 0 },
};
const completed = makeEvent(7, "turn.completed", { status: "completed", usage: USAGE });
const message = makeEvent(6, "agent.message.completed", { text: "hello" });

describe("credit usage stays with the product server", () => {
  test("the session proxy marks every relayed read as a chat read, so Opengeni leaves usage out", async () => {
    const accepts: Array<[string, string | null]> = [];
    const service = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "og_org_key",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        accepts.push([new URL(request.url).pathname, request.headers.get("accept")]);
        return Response.json([]);
      },
    });
    const handler = createSessionProxyHandler(service, {
      resolve: () => ({ workspaceId: WORKSPACE_ID, user: "u_42", source: "northwind" }),
    });
    const send = async (path: string, init?: RequestInit) =>
      await handler(
        new Request(`${PRODUCT}/api/opengeni/v1/workspaces/${WORKSPACE_ID}${path}`, {
          ...init,
          headers: { origin: PRODUCT, "content-type": "application/json", ...init?.headers },
        }),
      );
    await send(`/sessions/${SESSION_ID}/events`, { headers: { accept: "application/json" } });
    await send(`/sessions/${SESSION_ID}/turns`);
    await send("/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    const relayed = accepts.filter(([path]) => /\/(events|turns|chat\/completions)$/.test(path));
    expect(relayed.map(([path]) => path.split("/").slice(-1)[0])).toEqual([
      "events",
      "turns",
      "completions",
    ]);
    for (const [, accept] of relayed) {
      expect(accept?.split(",").map((value) => value.trim())).toContain(CHAT_ACCEPT);
    }
  });

  test("the re-emit helper leaves usage out of the browser stream by default", async () => {
    async function* events() {
      yield message;
      yield completed;
    }
    const text = await new Response(sessionEventsToSseStream(events())).text();
    expect(text).not.toContain('creditsMicros":');
    expect(text).toContain('"payload":{"status":"completed"}');
  });

  test("a trusted consumer can keep it", async () => {
    async function* events() {
      yield completed;
    }
    const text = await new Response(
      sessionEventsToSseStream(events(), { includeCreditUsage: true }),
    ).text();
    expect(text).toContain('"creditsMicros":41230');
  });
});
