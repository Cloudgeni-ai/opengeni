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
  test("cursor-only paging retains the requested size and oversized requests fail explicitly", async () => {
    const rows = Array.from({ length: 13 }, (_, n) =>
      event(n + 1, "agent.message.completed", { text: `Message ${n}` }),
    );
    const first = await readSessionEventView({ sessionId, limit: 4 }, reader(rows));
    const second = await readSessionEventView(
      { sessionId, cursor: first.nextCursor! },
      reader(rows),
    );
    expect(second.effectiveLimit).toBe(4);
    expect(second.events).toHaveLength(4);
    expect(second.events.map((item) => item.sequence)).toEqual([6, 7, 8, 9]);
    await expect(readSessionEventView({ sessionId, limit: 200 }, reader(rows))).rejects.toThrow();
  });

  test("exact named calls bypass unrelated history and continue to result by call ID", async () => {
    const rows = [
      event(1, "agent.toolCall.created", {
        callId: "create",
        name: "scheduled_tasks_create",
        arguments: { prompt: "Review" },
      }),
      event(2, "agent.toolCall.output", { callId: "create", output: "Created" }),
      event(3, "agent.toolCall.created", { callId: "list", name: "scheduled_tasks_list" }),
    ];
    const calls = await readSessionEventView(
      { sessionId, view: "tools", toolName: "scheduled_tasks_create", includeArguments: true },
      reader(rows),
    );
    expect(calls.events).toMatchObject([
      { sequence: 1, name: "scheduled_tasks_create", callId: "create" },
    ]);
    const result = await readSessionEventView(
      { sessionId, view: "tools", callId: "create", includeOutput: true },
      reader(rows),
    );
    expect(result.events.find((item) => item.kind === "result")?.text).toBe("Created");
    const named = await readSessionEventView(
      { sessionId, view: "tools", toolName: "scheduled_tasks_create", includeOutput: true },
      reader(rows),
    );
    expect(named.events.map((item) => [item.kind, item.callId, item.text])).toEqual([
      ["call", "create", undefined],
      ["result", "create", "Created"],
    ]);
  });

  test("named outputs report a call whose result is not recorded yet", async () => {
    const page = await readSessionEventView(
      { sessionId, view: "tools", toolName: "slow", includeOutput: true },
      reader([event(1, "agent.toolCall.created", { callId: "pending", name: "slow" })]),
    );
    expect(page.events).toEqual([
      {
        sequence: 1,
        turnId: "turn-1",
        callId: "pending",
        kind: "call",
        name: "slow",
        outputFound: false,
      },
    ]);
    expect(page.hasMore).toBe(false);
  });

  test("named outputs stop before a result that does not fit and resume there", async () => {
    const rows = [1, 2, 3].flatMap((n) => [
      event(n * 10, "agent.toolCall.created", { callId: `c${n}`, name: "report" }),
      event(n * 10 + 1, "agent.toolCall.output", { id: `c${n}`, output: `${n}`.repeat(5000) }),
    ]);
    const read = reader(rows);
    const seen: string[] = [];
    let page = await readSessionEventView(
      { sessionId, view: "tools", toolName: "report", includeOutput: true, limit: 3 },
      read,
    );
    for (let count = 0; ; count += 1) {
      expect(count).toBeLessThan(10);
      bounded(page);
      for (const item of page.events) if (item.kind === "result") seen.push(String(item.callId));
      if (!page.nextCursor) break;
      page = await readSessionEventView({ sessionId, cursor: page.nextCursor }, read);
    }
    expect(seen.sort()).toEqual(["c1", "c2", "c3"]);
  });

  // Follow nextCursor to the end, reassembling each call's arguments and result.
  async function readNamedStream(
    input: Parameters<typeof readSessionEventView>[0],
    read: ReturnType<typeof reader>,
  ) {
    const args = new Map<string, string>();
    const results = new Map<string, string>();
    const readOutput: string[] = [];
    let page = await readSessionEventView(input, read);
    for (let count = 0; ; count += 1) {
      expect(count).toBeLessThan(40);
      bounded(page);
      for (const item of page.events) {
        const into = item.kind === "result" ? results : args;
        into.set(String(item.callId), (into.get(String(item.callId)) ?? "") + (item.text ?? ""));
        if (item.readOutput) readOutput.push(String(item.callId));
      }
      if (!page.nextCursor) return { args, results, readOutput, last: page };
      page = await readSessionEventView({ sessionId, cursor: page.nextCursor }, read);
    }
  }

  for (const direction of ["before", "after"] as const) {
    test(`an oversized named result continues and then returns to the named stream (${direction})`, async () => {
      const big = "z".repeat(30000);
      const rows = [1, 2, 3].flatMap((n) => [
        event(n * 10, "agent.toolCall.created", { callId: `c${n}`, name: "report" }),
        event(n * 10 + 1, "agent.toolCall.output", {
          id: `c${n}`,
          output: n === (direction === "before" ? 3 : 1) ? big : `out${n}`,
        }),
      ]);
      const read = reader(rows);
      const first = await readSessionEventView(
        { sessionId, view: "tools", toolName: "report", includeOutput: true, limit: 3, direction },
        read,
      );
      expect(first.events[1]).toMatchObject({ kind: "result", fragment: { complete: false } });
      // The plain position still names the next named call.
      expect(direction === "before" ? first.nextBefore : first.nextAfter).toBe(
        direction === "before" ? 30 : 10,
      );
      const { results, last } = await readNamedStream(
        { sessionId, view: "tools", toolName: "report", includeOutput: true, limit: 3, direction },
        read,
      );
      expect(Object.fromEntries(results)).toEqual(
        direction === "before"
          ? { c1: "out1", c2: "out2", c3: big }
          : { c1: big, c2: "out2", c3: "out3" },
      );
      expect(last.hasMore).toBe(false);
    });

    test(`an argument fragment keeps named outputs on later pages (${direction})`, async () => {
      const body = "y".repeat(30000);
      const rows = [1, 2].flatMap((n) => [
        event(n * 10, "agent.toolCall.created", {
          callId: `w${n}`,
          name: "write",
          arguments: { body: n === 2 ? body : "small" },
        }),
        event(n * 10 + 1, "agent.toolCall.output", { id: `w${n}`, output: `ok${n}` }),
      ]);
      const { args, results, readOutput } = await readNamedStream(
        {
          sessionId,
          view: "tools",
          toolName: "write",
          includeArguments: true,
          includeOutput: true,
          limit: 3,
          direction,
        },
        reader(rows),
      );
      expect(args.get("w2")).toBe(JSON.stringify({ body }));
      // w1's result is still returned after w2's arguments; w2's result is
      // one exact read away, named on the fragmented call.
      expect(results.get("w1")).toBe("ok1");
      expect(readOutput).toEqual(["w2"]);
    });
  }

  test("named outputs budget for a long call identity instead of failing", async () => {
    const callId = "\u0001".repeat(340);
    for (let size = 5800; size <= 6400; size += 10) {
      const rows = [
        event(10, "agent.toolCall.created", {
          callId,
          name: "t",
          arguments: { a: "q".repeat(size) },
        }),
        event(11, "agent.toolCall.output", { id: callId, output: "r".repeat(9000) }),
      ];
      const page = await readSessionEventView(
        { sessionId, view: "tools", toolName: "t", includeArguments: true, includeOutput: true },
        reader(rows),
      );
      bounded(page);
      const result = page.events.find((item) => item.kind === "result");
      expect(result ? true : page.events[0]?.readOutput !== undefined).toBe(true);
    }
  });

  test("named outputs say why a result cannot be looked up", async () => {
    const longId = "\u0001".repeat(400);
    const page = await readSessionEventView(
      {
        sessionId,
        view: "tools",
        toolName: "t",
        includeOutput: true,
        limit: 3,
        direction: "after",
      },
      reader([
        event(1, "agent.toolCall.created", { name: "t", identityOmitted: true }),
        event(2, "agent.toolCall.created", { callId: longId, name: "t" }),
        event(3, "agent.toolCall.output", { id: longId, output: "done" }),
      ]),
    );
    expect(page.events.map((item) => item.outputUnavailable)).toEqual([
      "call_identity_omitted",
      "call_id_exceeds_lookup_budget",
    ]);
    expect(page.events.some((item) => "outputFound" in item)).toBe(false);
  });

  test("a retyped cursor refusal recovers its position", async () => {
    const read = reader([event(1, "user.message", { text: "x".repeat(20000) })]);
    const page = await readSessionEventView({ sessionId }, read);
    const decoded = Buffer.from(page.nextCursor!, "base64url").toString();
    expect(JSON.parse(decoded).sequence).toBe(1);
    const retyped = Buffer.from(decoded.replace('"sequence"', '"sequeence"')).toString("base64url");
    const error = await readSessionEventView({ sessionId, cursor: retyped }, read).catch(
      (caught: Error) => caught,
    );
    expect(String(error)).toContain(
      JSON.stringify({
        sessionId,
        view: "conversation",
        direction: "before",
        before: 2,
        limit: 10,
      }),
    );
  });

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
  test("default returns ten complete messages, including labelled commentary, without audit scaffolding", async () => {
    const rows = Array.from({ length: 22 }, (_, n) =>
      event(n + 1, "agent.message.completed", {
        text: `complete ${n}`,
        messageId: `msg_${n}`,
        phase: "commentary",
      }),
    );
    rows.push(
      event(23, "agent.message.delta", { text: "partial" }),
      event(24, "agent.toolCall.output", { output: "noise" }),
    );
    const page = await readSessionEventView({ sessionId }, reader(rows));
    expect(page.events).toHaveLength(10);
    // The provider message id is identity, not conversation; the phase tells a
    // reader which messages are progress notes.
    expect(page.events[0]).toEqual({
      sequence: 13,
      turnId: "turn-1",
      role: "assistant",
      phase: "commentary",
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
