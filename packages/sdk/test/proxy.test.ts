import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import {
  formatSseEvent,
  proxySessionEventStream,
  resumeSequenceFromRequest,
  sessionEventsToSseResponse,
  sessionEventsToSseStream,
} from "../src/proxy";
import { parseSseStream } from "../src/sse";
import type { SessionEvent } from "../src/types";
import {
  collect,
  hangingBytesStream,
  makeEvent,
  SESSION_ID,
  sseBlock,
  WORKSPACE_ID,
} from "./helpers";

async function* eventsFrom(events: SessionEvent[]): AsyncGenerator<SessionEvent, void, void> {
  for (const event of events) {
    yield event;
  }
}

describe("proxy re-streaming", () => {
  test("formatSseEvent matches the OpenGeni server wire format", () => {
    const event = makeEvent(7);
    expect(formatSseEvent(event)).toBe(
      `id: 7\nevent: agent.message.delta\ndata: ${JSON.stringify(event)}\n\n`,
    );
  });

  test("re-emitted stream round-trips through the SDK parser unchanged", async () => {
    const source = [
      makeEvent(1, "session.created", {}),
      makeEvent(2),
      makeEvent(3, "turn.completed", { ok: true }),
    ];
    const response = sessionEventsToSseResponse(eventsFrom(source));
    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    const messages = await collect(parseSseStream(response.body!));
    expect(messages.map((message) => message.id)).toEqual(["1", "2", "3"]);
    expect(messages.map((message) => message.event)).toEqual([
      "session.created",
      "agent.message.delta",
      "turn.completed",
    ]);
    expect(messages.map((message) => JSON.parse(message.data))).toEqual(source as never);
  });

  test("cancelling the downstream fires onCancel and ends the upstream iterator", async () => {
    const upstreamAbort = new AbortController();
    let finallyRan = false;
    const upstream = (async function* (): AsyncGenerator<SessionEvent, void, void> {
      try {
        yield makeEvent(1);
        await new Promise<void>((resolve) => {
          if (upstreamAbort.signal.aborted) {
            resolve();
            return;
          }
          upstreamAbort.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        finallyRan = true;
      }
    })();
    const stream = sessionEventsToSseStream(upstream, { onCancel: () => upstreamAbort.abort() });
    const reader = stream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel();
    expect(upstreamAbort.signal.aborted).toBe(true);
    // The iterator finishes once onCancel unblocks its pending await.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finallyRan).toBe(true);
  });

  test("upstream errors propagate to the downstream reader", async () => {
    const upstream = (async function* (): AsyncGenerator<SessionEvent, void, void> {
      yield makeEvent(1);
      throw new Error("upstream broke");
    })();
    const reader = sessionEventsToSseStream(upstream).getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow("upstream broke");
  });

  test("emits heartbeat comments while the source is quiet", async () => {
    const upstream = (async function* (): AsyncGenerator<SessionEvent, void, void> {
      yield makeEvent(1);
      await new Promise((resolve) => setTimeout(resolve, 60));
      yield makeEvent(2);
    })();
    const reader = sessionEventsToSseStream(upstream, { heartbeatMs: 10 }).getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value);
    }
    expect(text).toContain(": ping\n\n");
    expect(text).toContain('"sequence":2');
  });

  test("resumeSequenceFromRequest reads after param, then Last-Event-ID", () => {
    expect(resumeSequenceFromRequest(new Request("https://app.test/stream?after=42"))).toBe(42);
    expect(
      resumeSequenceFromRequest(
        new Request("https://app.test/stream", { headers: { "Last-Event-ID": "17" } }),
      ),
    ).toBe(17);
    expect(resumeSequenceFromRequest(new Request("https://app.test/stream?after=junk"))).toBe(0);
    expect(resumeSequenceFromRequest(new Request("https://app.test/stream?after=-3"))).toBe(0);
    expect(resumeSequenceFromRequest(new Request("https://app.test/stream"))).toBe(0);
  });

  test("proxySessionEventStream resumes from the browser request and tears down upstream on disconnect", async () => {
    const upstreamRequests: Array<{ url: string; signal: AbortSignal | undefined }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      upstreamRequests.push({ url: String(input), signal: init?.signal ?? undefined });
      return new Response(
        hangingBytesStream(
          [sseBlock(makeEvent(3)), sseBlock(makeEvent(4))],
          init?.signal ?? undefined,
        ),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      apiKey: "og_test_key",
      fetch: fetchImpl,
    });

    const browserRequest = new Request("https://customer.test/api/sessions/stream?after=2");
    const response = proxySessionEventStream(client, WORKSPACE_ID, SESSION_ID, {
      after: browserRequest,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes('"sequence":4')) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value);
    }
    expect(upstreamRequests[0]!.url).toBe(
      `https://api.example.test/v1/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}/events/stream?after=2`,
    );
    expect(text).toContain("event: agent.message.delta");

    // Browser disconnect: cancelling the proxied body aborts the upstream fetch.
    await reader.cancel();
    expect(upstreamRequests[0]!.signal?.aborted).toBe(true);
  });
});
