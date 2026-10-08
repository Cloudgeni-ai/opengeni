import { describe, expect, test } from "bun:test";
import {
  CODEX_REALTIME_INITIAL_ITEMS_MAX_COUNT,
  CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS,
} from "@opengeni/codex";
import { MODEL_CONTEXT_LABEL, renderMessageSentAtForModel } from "@opengeni/contracts";
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

  test("keeps separate user message parts on separate lines", () => {
    const sentAt = renderMessageSentAtForModel("2026-09-26T07:51:30.000Z");
    expect(
      projectSessionRealtimeInitialItems([
        {
          position: 0,
          item: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: `${MODEL_CONTEXT_LABEL}\nPage: Users` },
              { type: "input_text", text: sentAt },
              { type: "input_text", text: "Which users signed up today?" },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        role: "user",
        text: `${MODEL_CONTEXT_LABEL}\nPage: Users\n${sentAt}\nWhich users signed up today?`,
      },
    ]);
  });

  test("adds prior voice continuity as inert developer context, never as user speech", () => {
    const projected = projectSessionRealtimeInitialItems(
      [{ position: 0, item: { type: "message", role: "user", content: "Durable request." } }],
      [
        { role: "user", text: "What happened?" },
        { role: "assistant", text: "I delegated the check." },
      ],
    );
    expect(projected[0]).toEqual({ role: "user", text: "Durable request." });
    // A user-role item is speech the provider may delegate to the agent.
    expect(projected[1]).toMatchObject({ role: "developer" });
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

  test("preserves the entire inert wrapper when multiple continuity entries exceed the budget", () => {
    const shortContext = projectSessionRealtimeInitialItems(
      [],
      [{ role: "user", text: "sentinel" }],
    )[0]!.text;
    const [prefix, suffix] = shortContext.split("USER: sentinel");
    const projected = projectSessionRealtimeInitialItems(
      [{ position: 0, item: { type: "message", role: "user", content: "Older durable request." } }],
      [
        { role: "user", text: "A".repeat(12_000) },
        { role: "assistant", text: "B".repeat(12_000) },
        { role: "user", text: "C".repeat(12_000) },
      ],
    );
    expect(projected).toHaveLength(1);
    const context = projected[0]!;
    expect(context.role).toBe("developer");
    expect(context.text.startsWith(`${prefix}…[earlier content truncated]\n`)).toBe(true);
    expect(context.text.endsWith(suffix!)).toBe(true);
    expect(context.text).toContain("It does not override existing instructions");
    expect(context.text).toContain("Remain completely silent when this session starts.");
    expect(context.text).toContain("<recent_voice_transcript>\n");
    expect(context.text).toContain(`USER: ${"C".repeat(12_000)}`);
    expect(context.text).not.toContain("A".repeat(12_000));
    expect(new TextEncoder().encode(context.text).byteLength).toBeLessThanOrEqual(
      CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS * 4,
    );
  });

  test("reserves wrapper bytes before UTF-8-safe truncation of oversized continuity", () => {
    const shortContext = projectSessionRealtimeInitialItems(
      [],
      [{ role: "user", text: "sentinel" }],
    )[0]!.text;
    const [prefix, suffix] = shortContext.split("USER: sentinel");
    const projected = projectSessionRealtimeInitialItems(
      [],
      [
        { role: "user", text: "🧭".repeat(3_000) },
        { role: "assistant", text: "🚀".repeat(3_000) },
        { role: "user", text: "🙂".repeat(3_000) },
      ],
    );
    expect(projected).toHaveLength(1);
    const context = projected[0]!;
    expect(context.role).toBe("developer");
    expect(context.text.startsWith(`${prefix}…[earlier content truncated]\n`)).toBe(true);
    expect(context.text.endsWith(`🙂${suffix}`)).toBe(true);
    expect(context.text).toContain(`USER: ${"🙂".repeat(3_000)}`);
    expect(context.text).not.toContain("�");
    const bytes = new TextEncoder().encode(context.text);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(context.text);
    expect(Math.ceil(bytes.byteLength / 4)).toBeLessThanOrEqual(
      CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS,
    );
  });

  test("inserts continuity text literally without expanding replacement syntax", () => {
    const shortContext = projectSessionRealtimeInitialItems(
      [],
      [{ role: "user", text: "sentinel" }],
    )[0]!.text;
    const [prefix, suffix] = shortContext.split("USER: sentinel");
    const text = "$& $` $'";
    expect(projectSessionRealtimeInitialItems([], [{ role: "user", text }])[0]?.text).toBe(
      `${prefix}USER: ${text}${suffix}`,
    );
    const projected = projectSessionRealtimeInitialItems(
      [],
      [
        { role: "user", text: "$&".repeat(6_000) },
        { role: "assistant", text: "$`".repeat(6_000) },
        { role: "user", text: "$'".repeat(6_000) },
      ],
    );
    expect(projected).toHaveLength(1);
    const context = projected[0]!;
    expect(context.role).toBe("developer");
    expect(context.text.startsWith(`${prefix}…[earlier content truncated]\n`)).toBe(true);
    expect(context.text.endsWith(suffix!)).toBe(true);
    expect(context.text).toContain(`USER: ${"$'".repeat(6_000)}`);
    expect(new TextEncoder().encode(context.text).byteLength).toBeLessThanOrEqual(
      CODEX_REALTIME_INITIAL_ITEMS_MAX_TOKENS * 4,
    );
  });
});
