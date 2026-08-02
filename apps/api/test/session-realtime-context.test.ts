import { describe, expect, test } from "bun:test";
import {
  CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT,
  CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS,
} from "@opengeni/codex";
import { projectSessionRealtimeInitialItems } from "../src/session-realtime-context";

describe("ordinary-session realtime context projection", () => {
  test("projects complete role-bearing messages in durable position order", () => {
    expect(
      projectSessionRealtimeInitialItems([
        {
          position: 2,
          item: {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "I " },
              { type: "output_text", text: "can help." },
            ],
          },
        },
        {
          position: 0,
          item: { type: "message", role: "user", content: "Remember this." },
        },
        {
          position: 1,
          item: {
            type: "function_call",
            callId: "call-1",
            name: "session_send_message",
          },
        },
      ]),
    ).toEqual([
      { role: "user", text: "Remember this." },
      { role: "assistant", text: "I can help." },
    ]);
  });

  test("excludes non-text media, tool protocol, system, and unfinished messages", () => {
    expect(
      projectSessionRealtimeInitialItems([
        { position: 0, item: { type: "reasoning", content: "private" } },
        {
          position: 1,
          item: { type: "message", role: "system", content: "ephemeral" },
        },
        {
          position: 2,
          item: {
            type: "message",
            role: "assistant",
            status: "in_progress",
            content: [{ type: "output_text", text: "partial" }],
          },
        },
        {
          position: 3,
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: "data:image/png;base64,opaque",
              },
              { type: "input_text", text: "visible text" },
            ],
          },
        },
        {
          position: 4,
          item: { type: "function_call_result", output: "tool output" },
        },
      ]),
    ).toEqual([{ role: "user", text: "visible text" }]);
  });

  test("adds prior voice continuity as inert role-labeled context", () => {
    const projected = projectSessionRealtimeInitialItems(
      [{ position: 0, item: { type: "message", role: "user", content: "Durable request." } }],
      [
        { role: "user", text: "What happened?" },
        { role: "assistant", text: "I delegated the check." },
      ],
    );
    expect(projected[0]).toEqual({ role: "user", text: "Durable request." });
    expect(projected[1]).toMatchObject({ role: "user" });
    expect(projected[1]?.text).toContain("Remain completely silent when this session starts.");
    expect(projected[1]?.text).toContain("USER: What happened?");
    expect(projected[1]?.text).toContain("ASSISTANT: I delegated the check.");
  });

  test("keeps the newest complete tail under exact upstream limits", () => {
    const rows = Array.from(
      { length: CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT + 10 },
      (_, index) => ({
        position: index,
        item: { type: "message", role: "user", content: `message-${index}` },
      }),
    );
    const projected = projectSessionRealtimeInitialItems(rows);
    expect(projected).toHaveLength(CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT);
    expect(projected[0]?.text).toBe("message-10");
    expect(projected.at(-1)?.text).toBe("message-137");
  });

  test("UTF-8-safely truncates one oversized newest message to 8,192 estimated tokens", () => {
    const projected = projectSessionRealtimeInitialItems([
      {
        position: 0,
        item: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "🙂".repeat(20_000) }],
        },
      },
    ]);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.text.startsWith("…[earlier content truncated]\n")).toBe(true);
    expect(new TextEncoder().encode(projected[0]!.text).byteLength).toBeLessThanOrEqual(
      CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS * 4,
    );
    expect(projected[0]?.text.endsWith("🙂")).toBe(true);
  });
});
