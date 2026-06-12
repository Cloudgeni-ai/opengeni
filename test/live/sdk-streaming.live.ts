import { describe, expect, test } from "bun:test";
import { OpenGeniClient, type SessionEvent } from "@opengeni/sdk";

// Live SDK streaming smoke against a deployed OpenGeni API.
//
// Requires:
//   OPENGENI_ENABLE_LIVE_TESTS=true
//   OPENGENI_LIVE_SDK_BASE_URL=https://...        (deployed API base URL)
//   OPENGENI_LIVE_SDK_API_KEY=...                 (workspace-scoped API key)
//   OPENGENI_LIVE_SDK_WORKSPACE_ID=...            (workspace the key is scoped to)
const baseUrl = process.env.OPENGENI_LIVE_SDK_BASE_URL;
const apiKey = process.env.OPENGENI_LIVE_SDK_API_KEY;
const workspaceId = process.env.OPENGENI_LIVE_SDK_WORKSPACE_ID;
const live = process.env.OPENGENI_ENABLE_LIVE_TESTS === "true" && Boolean(baseUrl && apiKey && workspaceId);

describe("live SDK streaming", () => {
  test.skipIf(!live)("creates a session and streams an ordered, gap-free turn", async () => {
    const client = new OpenGeniClient({ baseUrl: baseUrl!, apiKey: apiKey! });

    const session = await client.createSession(workspaceId!, {
      initialMessage: "Reply with exactly: sdk-live-ok. Do not run any tools or commands.",
      sandboxBackend: "none",
      metadata: { origin: "sdk-streaming-live-test" },
    });
    expect(session.workspaceId).toBe(workspaceId!);

    // Stream from the beginning; the SSE handler replays durable events first,
    // then goes live, so this exercises replay + live tail in one connection.
    const controller = new AbortController();
    const seen: SessionEvent[] = [];
    const terminalTypes = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);
    const timeout = setTimeout(() => controller.abort(), 270_000);
    try {
      for await (const event of client.streamEvents(workspaceId!, session.id, { signal: controller.signal })) {
        seen.push(event);
        if (terminalTypes.has(event.type)) {
          controller.abort();
        }
      }
    } finally {
      clearTimeout(timeout);
    }

    // Ordered, no gaps, no dupes: per-session sequences are contiguous from 1.
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.map((event) => event.sequence)).toEqual(seen.map((_, index) => index + 1));
    const types = seen.map((event) => event.type);
    expect(types[0]).toBe("session.created");
    expect(types).toContain("turn.started");
    expect(types).toContain("turn.completed");
    expect(types.some((type) => type === "agent.message.delta" || type === "agent.message.completed")).toBe(true);

    // The agent's output reached the stream.
    const text = seen
      .filter((event) => event.type === "agent.message.completed" || event.type === "agent.message.delta")
      .map((event) => (event.payload as { text?: string }).text ?? "")
      .join("");
    expect(text.toLowerCase()).toContain("sdk-live-ok");

    // Resume-by-sequence against the live deployment: a fresh stream opened
    // mid-sequence must replay exactly the suffix, without dupes or gaps.
    const resumeAfter = seen.length - 2;
    const resumeController = new AbortController();
    const resumed: SessionEvent[] = [];
    const resumeTimeout = setTimeout(() => resumeController.abort(), 30_000);
    try {
      for await (const event of client.streamEvents(workspaceId!, session.id, {
        after: resumeAfter,
        signal: resumeController.signal,
      })) {
        resumed.push(event);
        if (event.sequence >= seen.length) {
          resumeController.abort();
        }
      }
    } finally {
      clearTimeout(resumeTimeout);
    }
    expect(resumed.map((event) => event.sequence)).toEqual([seen.length - 1, seen.length]);
    expect(resumed.map((event) => event.id)).toEqual(seen.slice(-2).map((event) => event.id));

    // Durable replay endpoint agrees with what was streamed.
    const replayed = await client.listEvents(workspaceId!, session.id, { after: 0, limit: 1000 });
    expect(replayed.slice(0, seen.length).map((event) => event.id)).toEqual(seen.map((event) => event.id));
  }, 300_000);
});
