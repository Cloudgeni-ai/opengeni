import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { acquireSearchTestDatabase } from "./session-message-search-fixture";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  listSessionEventPage,
  withWorkspaceRls,
} from "../src";
import type postgres from "postgres";
import { sql } from "drizzle-orm";
import { listSessionEventSlices } from "../src/session-event-slices";
import { LOSSLESS_JSON_STRING_PREFIX, toPostgresLosslessJson } from "../src/lossless-json";
import {
  readSessionEventView,
  SESSION_EVENT_VIEW_MAX_BYTES,
} from "../../../apps/api/src/mcp/session-event-view";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
let workspaceId: string;
let accountId: string;
let sessionId: string;
let otherSessionId: string;
beforeAll(async () => {
  shared = await acquireSearchTestDatabase("session-event-slices");
  client = createDb(shared.appUrl, { max: 2 });
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Slices",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Slices",
    subjectId: crypto.randomUUID(),
  });
  ({ workspaceId, accountId } = access.workspaceGrants[0]!);
  otherSessionId = (await makeSession()).id;
}, 180_000);
const makeSession = () =>
  createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "slice fixture",
    resources: [],
    metadata: {},
    model: "test",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
beforeEach(async () => {
  sessionId = (await makeSession()).id;
});
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function insert(
  sequence: number,
  type: string,
  payload: unknown,
  version: number | null = null,
) {
  await shared.admin`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload, payload_codec_version)
    values (${accountId}, ${workspaceId}, ${sessionId}, ${sequence}, ${type}, ${shared.admin.json(payload as never)}, ${version})`;
}
const read = async (options: Parameters<typeof listSessionEventSlices>[3]) => {
  const page = await listSessionEventSlices(
    client.db,
    workspaceId,
    sessionId,
    options,
    (legacyOptions) => listSessionEventPage(client.db, workspaceId, sessionId, legacyOptions),
  );
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(512 * 1024);
  return page;
};

test("tool filters return scoped calls and exact results, including codec identities", async () => {
  for (const callId of [
    "ordinary",
    "nul\u0000identity",
    "\ud800identity",
    `${LOSSLESS_JSON_STRING_PREFIX}literal`,
  ]) {
    const sequence =
      callId === "ordinary"
        ? 1
        : 3 +
          ["nul\u0000identity", "\ud800identity", `${LOSSLESS_JSON_STRING_PREFIX}literal`].indexOf(
            callId,
          ) *
            2;
    await insert(
      sequence,
      "agent.toolCall.created",
      toPostgresLosslessJson({
        callId,
        name: "scheduled_tasks_create",
        arguments: { prompt: "Review" },
      }),
      1,
    );
    await insert(
      sequence + 1,
      "agent.toolCall.output",
      toPostgresLosslessJson({ callId, output: "Created" }),
      1,
    );
    const result = await readSessionEventView(
      { sessionId, view: "tools", callId, includeOutput: true },
      read,
    );
    expect(result.events).toHaveLength(2);
    expect(result.events.find((item) => item.kind === "result")?.text).toBe("Created");
  }
  const calls = await readSessionEventView(
    { sessionId, view: "tools", toolName: "scheduled_tasks_create", limit: 2 },
    read,
  );
  expect(calls.events).toHaveLength(2);
  expect(calls.events.every((item) => item.kind === "call")).toBe(true);
  const rest = await readSessionEventView({ sessionId, cursor: calls.nextCursor! }, read);
  expect(rest.effectiveLimit).toBe(2);
  expect(rest.events).toHaveLength(2);
  expect(rest.hasMore).toBe(false);
}, 60_000);

test("call identity projection preserves aliases, legacy rows and rewritten event kinds", async () => {
  for (const [index, payload] of [
    { callId: "target", call_id: "wrong", id: "wrong" },
    { callId: null, call_id: "target", id: "wrong" },
    { call_id: null, id: "target" },
  ].entries()) {
    await insert(index + 1, "agent.toolCall.output", { ...payload, output: "ok" });
  }
  await shared.admin`update session_events set tool_call_id = null where session_id = ${sessionId} and sequence = 1`;
  await insert(4, "agent.toolCall.output", { callId: "old", output: "ok" });
  await shared.admin`update session_events set payload = '{"callId":"target","output":"ok"}'::jsonb
    where session_id = ${sessionId} and sequence = 4`;
  await insert(5, "custom.event", { callId: "target", output: "ok" });
  await insert(6, "agent.toolCall.created", { callId: "old", name: "old" });
  await shared.admin`update session_events set type = 'custom.event' where session_id = ${sessionId} and sequence = 6`;
  const cleared = await shared.admin`select tool_call_id, tool_name from session_events
    where session_id = ${sessionId} and sequence = 6`;
  expect(cleared[0]).toMatchObject({ tool_call_id: null, tool_name: null });
  const page = await read({ callId: "target", limit: 8 });
  expect(page.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  await shared.admin`update session_events set type = 'agent.toolCall.created'
    where session_id = ${sessionId} and sequence = 6`;
  const restored = await shared.admin`select tool_call_id, tool_name from session_events
    where session_id = ${sessionId} and sequence = 6`;
  expect(restored[0]).toMatchObject({ tool_call_id: "old", tool_name: "old" });
  await insert(7, "agent.toolCall.output", { callId: "", call_id: "target" });
  await insert(8, "agent.toolCall.output", { callId: 42 });
  expect(
    (await read({ callId: "target", limit: 8 })).events.map((event) => event.sequence),
  ).toEqual([1, 2, 3, 4, 5]);
  expect((await read({ callId: "42" })).events.map((event) => event.sequence)).toEqual([8]);
  const other = await listSessionEventSlices(client.db, workspaceId, otherSessionId, {
    callId: "target",
    view: "tools",
  });
  expect(other.events).toEqual([]);
}, 60_000);

test("call identity reads do not detoast excluded tool outputs", async () => {
  await insert(1, "agent.toolCall.output", { callId: "target", output: "ok" });
  await shared.admin`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    select ${accountId}, ${workspaceId}, ${sessionId}, g + 1, 'agent.toolCall.output',
      jsonb_build_object('callId', 'excluded-' || g, 'output',
        (select string_agg(md5(g::text || ':' || k::text), '') from generate_series(1, 1024) k))
    from generate_series(1, 256) g`;
  await shared.admin`analyze session_events`;
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const originalDebug = driver.options.debug;
  let captured: { text: string; params: unknown[] } | undefined;
  try {
    driver.options.debug = (_connection, query, params) => {
      if (query.startsWith('select "id", "sequence", case'))
        captured = { text: query, params: [...params] };
    };
    const page = await read({ view: "tools", callId: "target", direction: "before", limit: 1 });
    expect(page.events.map((event) => event.sequence)).toEqual([1]);
    expect(page.hasMore).toBe(false);
  } finally {
    driver.options.debug = originalDebug;
  }
  if (!captured) throw new Error("Identity query not captured");
  const query = captured;
  const oldText = query.text.replace('coalesce("session_events"."tool_call_id", ', "coalesce(");
  expect(oldText).not.toBe(query.text);
  const explain = (text: string) =>
    withWorkspaceRls(client.db, workspaceId, async (tx) => {
      const fragments = text
        .split(/\$(\d+)/g)
        .map((part, index) =>
          index % 2 === 0 ? sql.raw(part) : sql`${sql.param(query.params[Number(part) - 1])}`,
        );
      const rows = await tx.execute(
        sql`explain (analyze, buffers, format json) ${sql.join(fragments, sql``)}`,
      );
      const plan = (
        rows[0]?.["QUERY PLAN"] as
          | Array<{
              Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number };
              "Execution Time": number;
            }>
          | undefined
      )?.[0];
      if (!plan) throw new Error("Missing plan");
      return plan;
    });
  const before = await explain(oldText);
  const after = await explain(query.text);
  const buffers = (plan: typeof before) =>
    plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"];
  if (process.env.OPENGENI_BENCH_TOOL_NAME === "1")
    console.log(
      JSON.stringify({
        callIdentityFilter: {
          beforeMs: before["Execution Time"],
          afterMs: after["Execution Time"],
          beforeBuffers: buffers(before),
          afterBuffers: buffers(after),
        },
      }),
    );
  expect(buffers(after)).toBeLessThan(buffers(before) / 2);
}, 60_000);

test("named tool filters preserve legacy names, rewritten payloads and codec identities", async () => {
  await insert(1, "agent.toolCall.created", { callId: "legacy", name: "wanted", arguments: {} });
  await shared.admin`update session_events set tool_name = null where session_id = ${sessionId} and sequence = 1`;
  await insert(2, "agent.toolCall.created", { callId: "updated", name: "old", arguments: {} });
  await shared.admin`update session_events set payload = ${shared.admin.json({ callId: "updated", name: "wanted", arguments: {} })}
    where session_id = ${sessionId} and sequence = 2`;
  const unrelated = await makeSession();
  await shared.admin`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    values (${accountId}, ${workspaceId}, ${unrelated.id}, 1, 'agent.toolCall.created', '{"name":"wanted","callId":"other"}')`;
  const page = await read({ view: "tools", toolName: "wanted", direction: "before" });
  expect(page.events.map((event) => event.sequence)).toEqual([1, 2]);
  for (const [index, name] of [
    "nul\u0000name",
    "\ud800name",
    `${LOSSLESS_JSON_STRING_PREFIX}literal`,
  ].entries()) {
    await insert(
      3 + index,
      "agent.toolCall.created",
      toPostgresLosslessJson({ callId: `encoded-${index}`, name, arguments: {} }),
      1,
    );
    const result = await readSessionEventView({ sessionId, view: "tools", toolName: name }, read);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.sequence).toBe(3 + index);
  }
}, 60_000);

test("named tool identity reads do not detoast excluded arguments", async () => {
  await insert(1, "agent.toolCall.created", { callId: "target", name: "wanted", arguments: {} });
  // Incompressible argument bodies exercise TOAST, not just an inline JSON key.
  await shared.admin`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload)
    select ${accountId}, ${workspaceId}, ${sessionId}, g + 1, 'agent.toolCall.created',
      jsonb_build_object('callId', 'excluded-' || g, 'name', 'other', 'arguments',
        (select string_agg(md5(g::text || ':' || k::text), '') from generate_series(1, 1024) k))
    from generate_series(1, 256) g`;
  await shared.admin`analyze session_events`;
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const originalDebug = driver.options.debug;
  let captured: { text: string; params: unknown[] } | undefined;
  try {
    driver.options.debug = (_connection, query, params) => {
      if (query.startsWith('select "id", "sequence", case'))
        captured = { text: query, params: [...params] };
    };
    const page = await read({ view: "tools", toolName: "wanted", direction: "before", limit: 1 });
    expect(page.events.map((event) => event.sequence)).toEqual([1]);
    expect(page.hasMore).toBe(false);
  } finally {
    driver.options.debug = originalDebug;
  }
  if (!captured) throw new Error("Identity query not captured");
  const query = captured;
  const legacy = query.text.replace(
    'coalesce("session_events"."tool_name", "session_events"."payload"->>\'name\')',
    '"session_events"."payload"->>\'name\'',
  );
  const explain = (text: string) =>
    withWorkspaceRls(client.db, workspaceId, async (tx) => {
      const fragments = text
        .split(/\$(\d+)/g)
        .map((part, index) =>
          index % 2 === 0 ? sql.raw(part) : sql`${sql.param(query.params[Number(part) - 1])}`,
        );
      const rows = await tx.execute(
        sql`explain (analyze, buffers, format json) ${sql.join(fragments, sql``)}`,
      );
      const plans = rows[0]?.["QUERY PLAN"] as
        | Array<{
            Plan: { "Shared Hit Blocks": number; "Shared Read Blocks": number };
            "Execution Time": number;
          }>
        | undefined;
      if (!plans?.[0]) throw new Error("Identity query plan not returned");
      return plans[0];
    });
  const before = await explain(legacy);
  const after = await explain(query.text);
  const buffers = (plan: typeof before) =>
    plan.Plan["Shared Hit Blocks"] + plan.Plan["Shared Read Blocks"];
  if (process.env.OPENGENI_BENCH_TOOL_NAME === "1")
    console.log(
      JSON.stringify({
        toolNameFilter: {
          beforeMs: before["Execution Time"],
          afterMs: after["Execution Time"],
          beforeBuffers: buffers(before),
          afterBuffers: buffers(after),
        },
      }),
    );
  expect(query.text).toContain(
    'coalesce("session_events"."tool_name", "session_events"."payload"->>\'name\')',
  );
  expect(buffers(after)).toBeLessThan(buffers(before) / 2);
}, 60_000);

for (const direction of ["after", "before"] as const) {
  test(`real PostgreSQL reconstructs >1MiB legacy and canonical scalar text (${direction})`, async () => {
    const sequence = 1;
    const legacy = "🙂界" + "x".repeat(1_048_577);
    const canonical = "a\u0000🙂\ud800\\\n" + "x".repeat(1_048_577);
    await insert(sequence, "agent.message.completed", { text: legacy });
    await insert(
      sequence + 1,
      "agent.message.completed",
      toPostgresLosslessJson({ text: canonical }),
      1,
    );
    const reconstructed = new Map<number, string[]>();
    let cursor: string | undefined;
    for (let n = 0; ; n++) {
      expect(n).toBeLessThan(5000);
      const page = await readSessionEventView(
        cursor
          ? { sessionId, cursor }
          : { sessionId, direction, after: sequence - 1, before: sequence + 2 },
        read,
      );
      expect(Buffer.byteLength(JSON.stringify(page, null, 2))).toBeLessThanOrEqual(
        SESSION_EVENT_VIEW_MAX_BYTES,
      );
      expect(page.sourceExact).toBe(true);
      for (const item of page.events) {
        const parts = reconstructed.get(item.sequence) ?? [];
        parts.push(item.text!);
        reconstructed.set(item.sequence, parts);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(reconstructed.get(sequence)?.join("")).toBe(legacy);
    expect(reconstructed.get(sequence + 1)?.join("")).toBe(canonical);
  }, 180_000);
}

test("structured results keep the existing budget and legacy cursors keep UTF-16 offsets", async () => {
  const output = { body: "structured".repeat(2000) };
  await insert(1, "agent.toolCall.output", { callId: "structured", output });
  let cursor: string | undefined;
  let actual = "";
  do {
    const page = await readSessionEventView(
      cursor
        ? { sessionId, cursor }
        : {
            sessionId,
            view: "tools",
            includeOutput: true,
            after: 0,
          },
      read,
    );
    expect(page.sourceExact).toBe(true);
    actual += page.events.map((event) => event.text ?? "").join("");
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(actual).toBe(JSON.stringify(output));
  const text = "🙂prefix" + "x".repeat(20_000);
  await insert(2, "agent.message.completed", { text });
  const legacyCursor = Buffer.from(
    JSON.stringify({
      v: 1,
      selection: {
        sessionId,
        view: "conversation",
        includeArguments: false,
        includeOutput: false,
        callId: null,
        direction: "after",
        after: 1,
        before: null,
      },
      sequence: 2,
      offset: 8,
    }),
  ).toString("base64url");
  const page = await readSessionEventView({ sessionId, cursor: legacyCursor }, read);
  expect(page.events[0]?.text).toBe(text.slice(8, 8 + page.events[0]!.text!.length));
  await insert(3, "agent.toolCall.output", {
    callId: "error",
    output: { isError: true, content: [] },
  });
  const compact = await readSessionEventView({ sessionId, view: "tools", after: 2 }, read);
  expect(compact.events[0]?.isError).toBe(true);
  expect(compact.events[0]?.text).toBeUndefined();
});

test("legacy marker remains literal, malformed canonical marker remains literal, and offsets are checked", async () => {
  const literal = LOSSLESS_JSON_STRING_PREFIX + "YQA=";
  const malformed = LOSSLESS_JSON_STRING_PREFIX + "YQB=";
  await insert(1, "agent.message.completed", { text: literal });
  await insert(2, "agent.message.completed", { text: malformed }, 1);
  await insert(3, "agent.message.completed", toPostgresLosslessJson({ text: "🙂\u0000" }), 1);
  const page = await read({
    after: 0,
    before: 4,
    includeTypes: ["agent.message.completed"],
    view: "conversation",
  });
  expect(page.events.map((event) => (event.payload as { text: string }).text)).toEqual([
    literal,
    malformed,
    "🙂\u0000",
  ]);
  await expect(
    read({ after: 2, before: 4, sourceSequence: 3, sourceOffset: 1, view: "conversation" }),
  ).rejects.toThrow("surrogate pair");
  await expect(
    read({ after: 2, before: 4, sourceSequence: 3, sourceOffset: 99, view: "conversation" }),
  ).rejects.toThrow("offset");
  const other = await listSessionEventSlices(client.db, workspaceId, otherSessionId, {
    after: 0,
    sourceSequence: 3,
    sourceOffset: 0,
    view: "conversation",
  });
  expect(other.events).toEqual([]);
});

test("large result/tool scalar slots remain resumable; structured omissions are explicit", async () => {
  const text = "result ".repeat(320_000);
  await insert(1, "turn.completed", { output: text });
  await insert(2, "agent.toolCall.output", { callId: "large", output: text });
  await insert(3, "agent.toolCall.output", { callId: "structured", output: { body: text } });
  for (const view of ["results", "tools"] as const) {
    const page = await readSessionEventView(
      {
        sessionId,
        view,
        after: 0,
        before: 3,
        ...(view === "tools" ? { callId: "large", includeOutput: true } : {}),
      },
      read,
    );
    expect(page.events[0]!.text).toBe(text.slice(0, page.events[0]!.text!.length));
    expect(page.nextCursor).not.toBeNull();
    expect(page.sourceExact).toBe(true);
  }
  const omitted = await readSessionEventView(
    { sessionId, view: "tools", after: 2, includeOutput: true },
    read,
  );
  expect(omitted.events[0]!.text).toBeUndefined();
  expect(omitted.events[0]!.sourceOmitted).toBeDefined();
  expect(omitted.sourceExact).toBe(false);
  await insert(4, "turn.completed", { output: { body: text } });
  const structuredResult = await readSessionEventView(
    { sessionId, view: "results", after: 3 },
    read,
  );
  expect(structuredResult.events[0]!.sourceOmitted).toBeDefined();
  expect(structuredResult.events[0]!.text).toBeUndefined();
  await insert(5, "agent.toolCall.output", {
    callId: "x".repeat(10_000),
    id: "target",
    output: "wrong",
  });
  const precedence = await readSessionEventView(
    { sessionId, view: "tools", after: 4, callId: "target", includeOutput: true },
    read,
  );
  expect(precedence.events).toEqual([]);
  await insert(
    6,
    "agent.toolCall.output",
    toPostgresLosslessJson({
      callId: "\u0000".repeat(1000),
      name: "\u0000".repeat(1000),
      output: "readable",
    }),
    1,
  );
  const identity = await readSessionEventView(
    { sessionId, view: "tools", after: 5, includeOutput: true },
    read,
  );
  expect(identity.events[0]!.identityOmitted).toBe(true);
  expect(identity.events[0]!.text).toBe("readable");
  expect(Buffer.byteLength(JSON.stringify(identity, null, 2))).toBeLessThanOrEqual(
    SESSION_EVENT_VIEW_MAX_BYTES,
  );
});
