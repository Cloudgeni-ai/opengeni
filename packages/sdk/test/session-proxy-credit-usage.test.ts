import { describe, expect, test } from "bun:test";
import { OpenGeniClient, createSessionProxyHandler } from "../src/index";
import { sessionEventsToSseStream } from "../src/proxy";
import {
  stripCreditUsageFromEventStream,
  stripCreditUsageFromJsonText,
} from "../src/session-proxy-usage";
import { bytesStream, makeEvent, SESSION_ID, sseBlock, WORKSPACE_ID } from "./helpers";

const PRODUCT = "https://product.example.test";
const USAGE = {
  creditsMicros: 41_230,
  tokens: { input: 18_200, output: 950 },
  breakdown: { model: 39_100, webSearch: 2_130, imageGeneration: 0, other: 0 },
};
const completed = makeEvent(7, "turn.completed", { status: "completed", usage: USAGE });
const failed = makeEvent(8, "turn.failed", { reason: "model_error", usage: USAGE });
const message = makeEvent(6, "agent.message.completed", {
  text: 'The bill said "creditsMicros" and "cost".',
});
const turn = { id: "t1", status: "completed", prompt: "hi", usage: USAGE };
const completion = {
  id: "chatcmpl-1",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" } }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.00123 },
};
const finalChunk = {
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.00123 },
};

/** Splits the text into small chunks, so lines span chunk boundaries. */
function chunked(text: string, size = 7): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

function setup() {
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const session = `/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}`;
    if (path === `${session}/events/stream`) {
      return new Response(
        bytesStream(chunked([message, completed, failed].map((event) => sseBlock(event)).join(""))),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    if (path === `${session}/events`) return Response.json([message, completed, failed]);
    if (path === `${session}/turns`) return Response.json({ turns: [turn] });
    if (path === `/v1/workspaces/${WORKSPACE_ID}/chat/completions`) {
      const body = (await request.json()) as { stream?: boolean };
      if (!body.stream) return Response.json(completion);
      return new Response(
        bytesStream(chunked(`data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`)),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  };
  const service = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "og_org_key",
    fetch,
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
  return { send };
}

describe("the session proxy keeps credit usage from the browser", () => {
  test("event pages and turns lose `usage`; everything else is unchanged", async () => {
    const { send } = setup();
    const events = (await (await send(`/sessions/${SESSION_ID}/events`)).json()) as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;
    expect(events.map((event) => event.payload)).toEqual([
      message.payload as Record<string, unknown>,
      { status: "completed" },
      { reason: "model_error" },
    ]);
    const turns = (await (await send(`/sessions/${SESSION_ID}/turns`)).json()) as {
      turns: Array<Record<string, unknown>>;
    };
    expect(turns.turns).toEqual([{ id: "t1", status: "completed", prompt: "hi" }]);
  });

  test("the live event stream loses `usage`, even when lines span chunks", async () => {
    const { send } = setup();
    const response = await send(`/sessions/${SESSION_ID}/events/stream`);
    const text = await response.text();
    expect(text).not.toContain('creditsMicros":');
    expect(text).toContain(sseBlock(message));
    expect(text).toContain(
      sseBlock({ ...completed, payload: { status: "completed" } } as typeof completed),
    );
  });

  test("chat completions lose `usage.cost`, streamed and not", async () => {
    const { send } = setup();
    const whole = (await (
      await send("/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      })
    ).json()) as { usage: Record<string, unknown> };
    expect(whole.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    const streamed = await (
      await send("/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    ).text();
    expect(streamed).toContain('"total_tokens":12}');
    expect(streamed).not.toContain('"cost"');
    expect(streamed).toContain("data: [DONE]");
  });

  test("bodies without usage pass through byte for byte", async () => {
    const text = '{ "a" : 1, "usage": {"input": 2} }';
    expect(stripCreditUsageFromJsonText(text)).toBe(text);
    const stream = 'event: x\r\ndata: {"cost": 1}\r\n\r\n: ping\n\n';
    const out = await new Response(
      stripCreditUsageFromEventStream(bytesStream(chunked(stream, 3))),
    ).text();
    expect(out).toBe(stream);
  });

  test("the re-emit helper leaves usage out of the browser stream", async () => {
    async function* events() {
      yield message;
      yield completed;
    }
    const text = await new Response(sessionEventsToSseStream(events())).text();
    expect(text).not.toContain('creditsMicros":');
    expect(text).toContain('"payload":{"status":"completed"}');
  });
});
