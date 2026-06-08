import { describe, expect, test } from "bun:test";
import { authHeadersForAccessKey, resolveApiBaseUrl, streamSessionEvents } from "./api";
import type { SessionEvent } from "./types";

describe("web API auth helpers", () => {
  test("builds bearer authorization headers from a client-side access key", () => {
    expect(authHeadersForAccessKey(null)).toEqual({});
    expect(authHeadersForAccessKey("secret")).toEqual({ authorization: "Bearer secret" });
    expect(authHeadersForAccessKey("secret", { mode: "configuredToken", headerName: "authorization", scheme: "bearer" })).toEqual({ authorization: "Bearer secret" });
    expect(authHeadersForAccessKey("secret", { mode: "deploymentKey", headerName: "x-opengeni-access-key" })).toEqual({ "x-opengeni-access-key": "secret" });
  });

  test("defaults to same-origin API paths for deployed web builds", () => {
    expect(resolveApiBaseUrl(undefined)).toBe("");
    expect(resolveApiBaseUrl("https://opengeni.example.com/")).toBe("https://opengeni.example.com");
  });
});

describe("web API SSE helpers", () => {
  test("reconnects after a clean stream close using the latest event sequence", async () => {
    const restoreWindow = installTestWindow();
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const received: number[] = [];
    const states: string[] = [];
    const abort = new AbortController();
    let fetchCount = 0;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requests.push(requestUrl(input));
      fetchCount += 1;
      if (fetchCount === 1) {
        return sseResponse([event(6)]);
      }
      if (fetchCount === 2) {
        return sseResponse([event(7)]);
      }
      throw new Error("unexpected extra reconnect");
    }) as unknown as typeof fetch;

    try {
      await streamSessionEvents("workspace-id", "session-id", 5, (incoming) => {
        received.push(incoming.sequence);
        if (incoming.sequence === 7) {
          abort.abort();
        }
      }, {
        signal: abort.signal,
        reconnectDelayMs: 0,
        maxReconnectDelayMs: 0,
        onState: (state) => states.push(state),
      });
    } finally {
      globalThis.fetch = originalFetch;
      restoreWindow();
    }

    expect(received).toEqual([6, 7]);
    expect(fetchCount).toBe(2);
    expect(new URL(requests[0]!).searchParams.get("after")).toBe("5");
    expect(new URL(requests[1]!).searchParams.get("after")).toBe("6");
    expect(states).not.toContain("error");
  });

  test("does not retry terminal authorization failures forever", async () => {
    const restoreWindow = installTestWindow();
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("missing key", { status: 401 });
    }) as unknown as typeof fetch;

    try {
      await expect(streamSessionEvents("workspace-id", "session-id", 5, () => undefined, {
        reconnectDelayMs: 0,
        maxReconnectDelayMs: 0,
      })).rejects.toThrow("API 401: missing key");
    } finally {
      globalThis.fetch = originalFetch;
      restoreWindow();
    }

    expect(fetchCount).toBe(1);
  });
});

function event(sequence: number): SessionEvent {
  return {
    id: `event-${sequence}`,
    workspaceId: "workspace-id",
    sessionId: "session-id",
    sequence,
    type: "agent.message.delta",
    payload: { text: `event ${sequence}` },
    occurredAt: `2026-05-28T00:00:${String(sequence).padStart(2, "0")}.000Z`,
  };
}

function sseResponse(events: SessionEvent[]): Response {
  return new Response(events.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" || input instanceof URL ? String(input) : input.url;
}

function installTestWindow(): () => void {
  const original = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "https://web.test" } },
  });
  return () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: original,
    });
  };
}
