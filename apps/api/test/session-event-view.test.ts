import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/contracts";
import type { ListSessionEventPageOptions, SessionEventPage } from "@opengeni/db";
import { readSessionEventView, SESSION_EVENT_VIEW_MAX_BYTES } from "../src/mcp/session-event-view";

const sessionId = "00000000-0000-4000-8000-000000000001";
const event = (sequence: number, type: SessionEvent["type"], payload: unknown) =>
  ({ sequence, type, payload, turnId: "turn-1" }) as SessionEvent;
function reader(events: SessionEvent[]) {
  return async (options: ListSessionEventPageOptions): Promise<SessionEventPage> => {
    expect(options.payloadMode).toBe("full");
    expect(options.excludeUnclaimedHumanPrompts).toBe(true);
    let matches = events.filter(
      (e) =>
        e.sequence > (options.after ?? 0) &&
        (options.before === undefined || e.sequence < options.before) &&
        options.includeTypes?.includes(e.type),
    );
    if (options.direction === "before") matches.reverse();
    const selected = matches.slice(0, options.limit).sort((a, b) => a.sequence - b.sequence);
    return {
      events: selected,
      hasMore: matches.length > selected.length,
      fullPayloadsExact: true,
      bytes: 0,
      direction: options.direction!,
      coveredSequence: null,
      nextAfter: null,
      nextBefore: null,
      truncatedBy: null,
    };
  };
}
function bounded(page: unknown) {
  expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThanOrEqual(
    SESSION_EVENT_VIEW_MAX_BYTES,
  );
}

describe("session event content views", () => {
  for (const direction of ["after", "before"] as const) {
    test(`whole-message continuation visits every event once (${direction})`, async () => {
      const rows = Array.from({ length: 25 }, (_, n) =>
        event(n + 1, "agent.message.completed", { text: `message ${n}` }),
      );
      const seen: number[] = [];
      let page = await readSessionEventView({ sessionId, direction, limit: 4 }, reader(rows));
      for (let pages = 0; ; pages++) {
        expect(pages).toBeLessThan(10);
        seen.push(...page.events.map((item) => item.sequence));
        if (!page.hasMore) break;
        expect(
          JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString()).sequence,
        ).toBeNull();
        page = await readSessionEventView(
          { sessionId, cursor: page.nextCursor!, limit: 4 },
          reader(rows),
        );
      }
      expect(seen.length).toBe(25);
      expect([...seen].sort((a, b) => a - b)).toEqual(rows.map((item) => item.sequence));
    });
  }
  test("rejects a crafted continuation offset inside a surrogate pair", async () => {
    const read = reader([event(1, "agent.message.completed", { text: "🙂".repeat(10000) })]);
    const page = await readSessionEventView({ sessionId }, read);
    const cursor = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString());
    cursor.offset = 1;
    await expect(
      readSessionEventView(
        {
          sessionId,
          cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
        },
        read,
      ),
    ).rejects.toThrow("splits a surrogate pair");
  });
  test("escape-heavy call IDs cannot inflate continuation tokens", async () => {
    const callId = "\u0000".repeat(300);
    const read = reader([
      event(1, "agent.toolCall.output", { id: callId, output: "x".repeat(20000) }),
    ]);
    const page = await readSessionEventView(
      { sessionId, view: "tools", callId, includeOutput: true },
      read,
    );
    expect(page.nextCursor!.length).toBeLessThan(4096);
    bounded(page);
    await expect(
      readSessionEventView({ sessionId, view: "tools", callId: "\u0000".repeat(512) }, read),
    ).rejects.toThrow("encoded cursor budget");
  });
  test("source projection loss stays explicit and stale/duplicate messages are not conversation", async () => {
    const read = reader([
      event(1, "agent.message.completed", { text: "retained projected text" }),
      {
        ...event(2, "agent.message.completed", { text: "duplicate" }),
        duplicateOfEventId: "original",
      },
    ]);
    const page = await readSessionEventView({ sessionId }, async (options) => ({
      ...(await read(options)),
      fullPayloadsExact: false,
    }));
    expect(page.sourceExact).toBe(false);
    expect(page.events.map((e) => e.text)).toEqual(["retained projected text"]);
  });
  test("default returns ten complete messages, including commentary, without audit scaffolding", async () => {
    const rows = Array.from({ length: 22 }, (_, n) =>
      event(n + 1, "agent.message.completed", { text: `complete ${n}`, phase: "commentary" }),
    );
    rows.push(
      event(23, "agent.message.delta", { text: "partial" }),
      event(24, "agent.toolCall.output", { output: "noise" }),
    );
    const page = await readSessionEventView({ sessionId }, reader(rows));
    expect(page.events).toHaveLength(10);
    expect(page.events[0]).toEqual({
      sequence: 13,
      turnId: "turn-1",
      role: "assistant",
      text: "complete 12",
    });
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor!.length).toBeLessThan(4096);
    const older = await readSessionEventView({ sessionId, cursor: page.nextCursor! }, reader(rows));
    expect(older.events.map((e) => e.sequence)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    bounded(page);
  });

  test("after changes position, not default view or payload detail", async () => {
    const text = "complete ".repeat(600);
    const page = await readSessionEventView(
      { sessionId, after: 0 },
      reader([
        event(1, "agent.message.delta", { text: "raw" }),
        event(2, "user.message", { text }),
      ]),
    );
    expect(page.view).toBe("conversation");
    expect(page.events.map((e) => e.text)).toEqual([text]);
    bounded(page);
  });

  for (const direction of ["before", "after"] as const) {
    test(`lossless bounded Unicode and escaped-text continuation (${direction})`, async () => {
      const text = '界🙂\u0000\n\\"'.repeat(9000);
      const rows = [
        event(1, "user.message", { text: "first" }),
        event(2, "agent.message.completed", { text }),
        event(3, "agent.message.completed", { text: "last" }),
      ];
      const read = reader(rows);
      let page = await readSessionEventView({ sessionId, direction, limit: 10 }, read);
      const parts: string[] = [];
      const other: string[] = [];
      for (let count = 0; ; count++) {
        expect(count).toBeLessThan(100);
        bounded(page);
        for (const item of page.events) {
          if (item.sequence === 2) parts.push(item.text!);
          else other.push(item.text!);
        }
        if (!page.nextCursor) break;
        expect(page.nextCursor.length).toBeLessThan(4096);
        page = await readSessionEventView({ sessionId, cursor: page.nextCursor }, read);
      }
      expect(parts.join("")).toBe(text);
      expect(other.sort()).toEqual(["first", "last"]);
    });
  }

  test("prefers fewer whole messages over clipping all rows", async () => {
    const text = "x".repeat(6000);
    const page = await readSessionEventView(
      { sessionId, after: 0 },
      reader([event(1, "user.message", { text }), event(2, "agent.message.completed", { text })]),
    );
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.text).toBe(text);
    expect(page.events[0]!.fragment).toBeUndefined();
    expect(page.nextCursor).not.toBeNull();
  });

  test("results choose final turn output once and exclude commentary/maintenance", async () => {
    const page = await readSessionEventView(
      { sessionId, view: "results" },
      reader([
        event(1, "agent.message.completed", { text: "progress", phase: "commentary" }),
        event(2, "agent.message.completed", { text: "answer" }),
        event(3, "turn.completed", { output: "answer" }),
        event(4, "turn.completed", { output: "maintenance", maintenance: true }),
        event(5, "turn.failed", { error: "action required" }),
      ]),
    );
    expect(page.events.map((e) => e.text)).toEqual(["answer", '{"error":"action required"}']);
  });

  test("tools are compact by default, exact callId opt-in returns a single value representation", async () => {
    const read = reader([
      event(1, "agent.toolCall.created", {
        id: "exact",
        name: "tool",
        arguments: { command: "do" },
        raw: "duplicate",
      }),
      event(2, "agent.toolCall.output", { id: "exact-other", output: "wrong" }),
      event(3, "agent.toolCall.output", { id: "exact", output: { ok: true }, raw: "duplicate" }),
    ]);
    const compact = await readSessionEventView({ sessionId, view: "tools", callId: "exact" }, read);
    expect(compact.events).toHaveLength(2);
    expect(compact.events.every((e) => e.text === undefined)).toBe(true);
    const full = await readSessionEventView(
      { sessionId, view: "tools", callId: "exact", includeArguments: true, includeOutput: true },
      read,
    );
    expect(full.events.map((e) => e.text)).toEqual(['{"command":"do"}', '{"ok":true}']);
    expect(JSON.stringify(full)).not.toContain("duplicate");
  });

  test("sparse callId scans stay bounded and resume rather than claim absence", async () => {
    const rows = Array.from({ length: 600 }, (_, n) =>
      event(n + 1, "agent.toolCall.output", { id: n === 599 ? "target" : "other", output: "ok" }),
    );
    const read = reader(rows);
    const page = await readSessionEventView(
      { sessionId, view: "tools", callId: "target", after: 0 },
      read,
    );
    expect(page.events).toEqual([]);
    expect(page.hasMore).toBe(true);
    const next = await readSessionEventView({ sessionId, cursor: page.nextCursor! }, read);
    expect(next.events[0]?.callId).toBe("target");
    expect(next.hasMore).toBe(false);
  });

  test("rejects cross-session, view and detail cursor changes and oversized/malformed tokens", async () => {
    const read = reader([event(1, "user.message", { text: "x".repeat(20000) })]);
    const page = await readSessionEventView({ sessionId }, read);
    for (const changes of [
      { sessionId: "00000000-0000-4000-8000-000000000002" },
      { view: "tools" as const },
      { includeOutput: true },
      { after: 99 },
    ]) {
      await expect(
        readSessionEventView({ sessionId, cursor: page.nextCursor!, ...changes }, read),
      ).rejects.toThrow("cannot change");
    }
    await expect(
      readSessionEventView({ sessionId, cursor: "x".repeat(4097) }, read),
    ).rejects.toThrow("4096");
    await expect(readSessionEventView({ sessionId, cursor: "invalid" }, read)).rejects.toThrow(
      "Invalid",
    );
    const cursor = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString());
    for (const change of [
      { v: 3 },
      { offset: -1 },
      { offset: 2_147_483_648 },
      { sequence: null, offset: 1 },
      { sequence: cursor.selection.after },
    ]) {
      await expect(
        readSessionEventView(
          {
            sessionId,
            cursor: Buffer.from(JSON.stringify({ ...cursor, ...change })).toString("base64url"),
          },
          read,
        ),
      ).rejects.toThrow("Invalid");
    }
  });
});
