import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  SESSION_EVENT_PRESENTED_TOOL_LEAVES,
  SESSION_EVENT_STEP_TYPES,
  isPresentedSessionToolName,
} from "@opengeni/contracts/session-history";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  listSessionEventPage,
  listSessionEvents,
  withWorkspaceSubjectRls,
} from "../src";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-event-presented-tool-calls");
  if (!acquired) throw new Error("PostgreSQL required for conversation history reads");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("conversation reads exclude steps but keep presented tool calls", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Conversation history",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Conversation",
    subjectId: `conversation-reader-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const rows: Array<[number, string, Record<string, unknown>]> = [
    [1, "user.message", { text: "question" }],
    [2, "agent.toolCall.created", { id: "c1", name: "exec_command", arguments: {} }],
    [3, "agent.toolCall.output", { id: "c1", output: "ok" }],
    [4, "agent.reasoning.delta", { text: "thinking" }],
    [5, "agent.toolCall.created", { id: "c2", name: "sandbox_file_publish", arguments: {} }],
    [6, "agent.toolCall.output", { id: "c2", output: {} }],
    [7, "agent.toolCall.created", { id: "c3", name: "opengeni__skill_save", arguments: {} }],
    // Only exact leaves count: a longer name ending in a leaf is a step.
    [8, "agent.toolCall.created", { id: "c4", name: "my_skill_save", arguments: {} }],
    [9, "agent.toolCall.created", { id: "c5", name: "mcp__knowledge_save", arguments: {} }],
    [10, "agent.message.completed", { text: "answer" }],
    // A step row without a turn (PTY output): only the sandbox dock reads it.
    [11, "terminal.pty.output.delta", { data: "$ ls" }],
  ];
  const turnId = crypto.randomUUID();
  for (const [sequence, type, payload] of rows) {
    const rowTurnId = type === "terminal.pty.output.delta" ? null : turnId;
    await shared.admin`
      insert into session_events (account_id,workspace_id,session_id,turn_id,sequence,type,payload)
      values (${grant.accountId},${grant.workspaceId},${session.id},${rowTurnId},${sequence},${type},${shared.admin.json(payload as never)})`;
  }
  const excludeTypes = [...SESSION_EVENT_STEP_TYPES];

  const plain = await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, (tx) =>
    listSessionEvents(tx, grant.workspaceId, session.id, { after: 0, limit: 100, excludeTypes }),
  );
  expect(plain.map((event) => event.sequence)).toEqual([1, 10]);
  expect(excludeTypes).toContain("terminal.pty.output.delta");

  const conversation = await withWorkspaceSubjectRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    (tx) =>
      listSessionEvents(tx, grant.workspaceId, session.id, {
        after: 0,
        limit: 100,
        excludeTypes,
        retainPresentedToolCalls: true,
      }),
  );
  expect(conversation.map((event) => event.sequence)).toEqual([1, 5, 7, 9, 10]);

  const page = await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, (tx) =>
    listSessionEventPage(tx, grant.workspaceId, session.id, {
      before: Number.MAX_SAFE_INTEGER,
      limit: 3,
      excludeTypes,
      retainPresentedToolCalls: true,
      payloadMode: "full",
    }),
  );
  expect(page.events.map((event) => event.sequence)).toEqual([7, 9, 10]);
  expect(page.hasMore).toBe(true);

  // Without excluding created rows the option changes nothing.
  const steps = await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, (tx) =>
    listSessionEvents(tx, grant.workspaceId, session.id, {
      after: 0,
      limit: 100,
      includeTypes: excludeTypes,
      retainPresentedToolCalls: true,
    }),
  );
  expect(steps.map((event) => event.sequence)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 11]);
}, 120_000);

test("thousands of PTY rows never reach a conversation read; the dock reads them by type", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Terminal history",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Terminal",
    subjectId: `terminal-reader-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const turnId = crypto.randomUUID();
  // A turn with command output, then 3,000 rows of interactive terminal
  // output and a background command's turnless output, then a question.
  await shared.admin`
    insert into session_events (account_id,workspace_id,session_id,turn_id,sequence,type,payload)
    values
      (${grant.accountId},${grant.workspaceId},${session.id},null,1,'user.message',${shared.admin.json({ text: "run tests" })}),
      (${grant.accountId},${grant.workspaceId},${session.id},${turnId},2,'sandbox.command.output.delta',${shared.admin.json({ stream: "stdout", chunk: "412 pass" })}),
      (${grant.accountId},${grant.workspaceId},${session.id},${turnId},3,'agent.message.completed',${shared.admin.json({ text: "green" })})`;
  await shared.admin`
    insert into session_events (account_id,workspace_id,session_id,turn_id,sequence,type,payload)
    select ${grant.accountId}, ${grant.workspaceId}, ${session.id}, null, 3 + n,
      case when n % 100 = 0 then 'sandbox.command.output.delta' else 'terminal.pty.output.delta' end,
      jsonb_build_object('ptyId', 'p1', 'stream', 'stdout', 'chunk', 'line ' || n)
    from generate_series(1, 3000) as n`;
  await shared.admin`
    insert into session_events (account_id,workspace_id,session_id,turn_id,sequence,type,payload)
    values (${grant.accountId},${grant.workspaceId},${session.id},null,3004,'user.message',${shared.admin.json({ text: "deploy" })})`;

  // The conversation's first page: newest first, 1,000 rows.
  const conversation = await withWorkspaceSubjectRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    (tx) =>
      listSessionEventPage(tx, grant.workspaceId, session.id, {
        before: Number.MAX_SAFE_INTEGER,
        direction: "before",
        limit: 1000,
        excludeTypes: [...SESSION_EVENT_STEP_TYPES],
        retainPresentedToolCalls: true,
        payloadMode: "full",
      }),
  );
  expect(conversation.events.map((event) => event.sequence)).toEqual([1, 3, 3004]);
  expect(conversation.hasMore).toBe(false);

  // The dock's read: the newest output rows of every kind, turn or not.
  const terminal = await withWorkspaceSubjectRls(
    client.db,
    grant.workspaceId,
    grant.subjectId,
    (tx) =>
      listSessionEventPage(tx, grant.workspaceId, session.id, {
        direction: "before",
        limit: 1000,
        includeTypes: ["terminal.pty.output.delta", "sandbox.command.output.delta"],
        payloadMode: "full",
      }),
  );
  expect(terminal.events).toHaveLength(1000);
  expect(terminal.events.at(-1)!.sequence).toBe(3003);
  expect(terminal.hasMore).toBe(true);
  const older = await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, (tx) =>
    listSessionEventPage(tx, grant.workspaceId, session.id, {
      before: 100,
      direction: "before",
      limit: 1000,
      includeTypes: ["terminal.pty.output.delta", "sandbox.command.output.delta"],
      payloadMode: "full",
    }),
  );
  // The turn's command output is in the dock's read too.
  expect(older.events[0]).toMatchObject({ sequence: 2, turnId });
  expect(older.events).toHaveLength(97);
  expect(older.hasMore).toBe(false);
}, 120_000);

async function seedToolNameSession() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Tool name column",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Tool names",
    subjectId: `tool-name-reader-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { grant, session };
}

test("presented tool calls are classified by tool_name, falling back to the payload only when NULL", async () => {
  const { grant, session } = await seedToolNameSession();
  const turnId = crypto.randomUUID();
  const large = "x".repeat(64 * 1024);
  const rows: Array<[number, string, Record<string, unknown>]> = [
    [1, "user.message", { text: "question" }],
    [2, "agent.toolCall.created", { id: "c1", name: "exec_command", arguments: { large } }],
    [3, "agent.toolCall.output", { id: "c1", name: "exec_command", output: "ok" }],
    [4, "agent.toolCall.created", { id: "c2", name: "opengeni__generate_image", arguments: {} }],
    [5, "agent.toolCall.created", { id: "c3", name: "sandbox_file_publish", arguments: {} }],
    [6, "agent.toolCall.created", { id: "c4", name: "write_stdin", arguments: {} }],
    [7, "agent.toolCall.created", { id: "c5", name: "mcp__session_create", arguments: {} }],
    [8, "agent.toolCall.created", { id: "c6", name: "not_skill_save", arguments: {} }],
    [9, "agent.toolCall.created", { id: "c7", arguments: {} }],
    [10, "agent.toolCall.created", { id: "c8", name: "knowledge_save", arguments: {} }],
    [11, "agent.toolCall.created", { id: "c9", name: "apply_patch", arguments: {} }],
    [12, "agent.message.completed", { text: "answer" }],
  ];
  for (const [sequence, type, payload] of rows) {
    await shared.admin`
      insert into session_events (account_id,workspace_id,session_id,turn_id,sequence,type,payload)
      values (${grant.accountId},${grant.workspaceId},${session.id},${turnId},${sequence},${type},${shared.admin.json(payload as never)})`;
  }
  const names = async () =>
    (
      await shared.admin<{ sequence: number; tool_name: string | null }[]>`
        select sequence, tool_name from session_events
        where workspace_id = ${grant.workspaceId} and session_id = ${session.id}
        order by sequence`
    ).map((row) => [row.sequence, row.tool_name]);
  // The insert trigger names created rows only; other types keep NULL.
  expect(await names()).toEqual([
    [1, null],
    [2, "exec_command"],
    [3, null],
    [4, "opengeni__generate_image"],
    [5, "sandbox_file_publish"],
    [6, "write_stdin"],
    [7, "mcp__session_create"],
    [8, "not_skill_save"],
    [9, null],
    [10, "knowledge_save"],
    [11, "apply_patch"],
    [12, null],
  ]);

  // Rows written before migration 0889 were never named: clear the column on
  // a presented (5, 10) and a non-presented (6) call to model them.
  await shared.admin`
    update session_events set tool_name = null
    where workspace_id = ${grant.workspaceId} and session_id = ${session.id}
      and sequence in (5, 6, 10)`;
  // A named row is classified by its column, not its payload: these rows
  // disagree on purpose, which only an operator could cause.
  await shared.admin`
    update session_events set tool_name = case sequence
      when 2 then 'knowledge_archive' when 4 then 'exec_command' end
    where workspace_id = ${grant.workspaceId} and session_id = ${session.id}
      and sequence in (2, 4)`;

  const excludeTypes = [...SESSION_EVENT_STEP_TYPES];
  const read = (options: { after?: number; before?: number; limit: number }) =>
    withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, (tx) =>
      listSessionEventPage(tx, grant.workspaceId, session.id, {
        ...options,
        excludeTypes,
        retainPresentedToolCalls: true,
        payloadMode: "full",
      }),
    );
  const all = await read({ after: 0, limit: 100 });
  expect(all.events.map((event) => event.sequence)).toEqual([1, 2, 5, 7, 10, 12]);
  expect(all.hasMore).toBe(false);

  // Backward pages across named and un-backfilled rows report hasMore.
  const newest = await read({ before: Number.MAX_SAFE_INTEGER, limit: 2 });
  expect(newest.events.map((event) => event.sequence)).toEqual([10, 12]);
  expect(newest.hasMore).toBe(true);
  const middle = await read({ before: 10, limit: 2 });
  expect(middle.events.map((event) => event.sequence)).toEqual([5, 7]);
  expect(middle.hasMore).toBe(true);
  const oldest = await read({ before: 5, limit: 2 });
  expect(oldest.events.map((event) => event.sequence)).toEqual([1, 2]);
  expect(oldest.hasMore).toBe(false);
  // Forward pages agree.
  const forward = await read({ after: 2, limit: 3 });
  expect(forward.events.map((event) => event.sequence)).toEqual([5, 7, 10]);
  expect(forward.hasMore).toBe(true);

  // A payload rewrite renames the row through the update trigger.
  await shared.admin`
    update session_events set payload = ${shared.admin.json({ id: "c4", name: "skill_save", arguments: {} } as never)}
    where workspace_id = ${grant.workspaceId} and session_id = ${session.id} and sequence = 6`;
  expect((await names()).find(([sequence]) => sequence === 6)).toEqual([6, "skill_save"]);
  const renamed = await read({ after: 0, limit: 100 });
  expect(renamed.events.map((event) => event.sequence)).toEqual([1, 2, 5, 6, 7, 10, 12]);
}, 120_000);

test("SQL tool-name classification equals isPresentedSessionToolName, named or not", async () => {
  const { grant, session } = await seedToolNameSession();
  const turnId = crypto.randomUUID();
  const names = [
    "skill_save",
    "opengeni__skill_save",
    "x___skill_save",
    "__skill_save",
    "skill_save__",
    "my_skill_save",
    "x__skill__save",
    // `_` and `%` are LIKE wildcards: these must not match.
    "skillXsave",
    "x__skillXsave",
    "x__skill%",
    "%",
    "a%b__generate_image",
    "back\\slash__session_create",
    "SKILL_SAVE",
    "skill_save ",
    "skill_save\n",
    "",
    "image_generation_call",
    "mcp__server__session_send_message",
  ];
  // Each name twice: odd sequences keep the trigger-filled column, even ones
  // are un-backfilled and fall back to the payload.
  for (const [index, name] of names.entries()) {
    for (const offset of [1, 2]) {
      await shared.admin`
        insert into session_events (account_id,workspace_id,session_id,turn_id,sequence,type,payload)
        values (${grant.accountId},${grant.workspaceId},${session.id},${turnId},${index * 2 + offset},
          'agent.toolCall.created',${shared.admin.json({ id: `c${index}`, name, arguments: {} } as never)})`;
    }
  }
  await shared.admin`
    update session_events set tool_name = null
    where workspace_id = ${grant.workspaceId} and session_id = ${session.id} and sequence % 2 = 0`;
  expect(
    (
      await shared.admin<{ named: number }[]>`
        select count(tool_name)::int as named from session_events
        where workspace_id = ${grant.workspaceId} and session_id = ${session.id}`
    )[0]!.named,
  ).toBe(names.length);

  const kept = await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, (tx) =>
    listSessionEvents(tx, grant.workspaceId, session.id, {
      after: 0,
      limit: 100,
      excludeTypes: [...SESSION_EVENT_STEP_TYPES],
      retainPresentedToolCalls: true,
    }),
  );
  const expected = names.flatMap((name, index) =>
    isPresentedSessionToolName(name) ? [index * 2 + 1, index * 2 + 2] : [],
  );
  expect(kept.map((event) => event.sequence)).toEqual(expected);
  expect(expected.length).toBe(2 * 8);
  // The regex the filter used before migration 0889 agrees on every row.
  const previousFilter = `^(.*__)?(${SESSION_EVENT_PRESENTED_TOOL_LEAVES.join("|")})$`;
  const previous = await shared.admin<{ sequence: number }[]>`
    select sequence from session_events
    where workspace_id = ${grant.workspaceId} and session_id = ${session.id}
      and (payload ->> 'name') ~ ${previousFilter}
    order by sequence`;
  expect(previous.map((row) => row.sequence)).toEqual(expected);
}, 120_000);

test("the application writer fills tool_name under row-level security", async () => {
  const { grant, session } = await seedToolNameSession();
  await appendSessionEvents(client.db, grant.workspaceId, session.id, [
    {
      type: "agent.toolCall.created",
      payload: { id: "w1", name: "opengeni__sandbox_file_publish", arguments: {} },
    },
    { type: "agent.toolCall.output", payload: { id: "w1", name: "x", output: {} } },
  ]);
  const rows = await shared.admin<{ type: string; tool_name: string | null }[]>`
    select type, tool_name from session_events
    where workspace_id = ${grant.workspaceId} and session_id = ${session.id}
      and type like 'agent.toolCall.%'
    order by sequence`;
  expect([...rows]).toEqual([
    { type: "agent.toolCall.created", tool_name: "opengeni__sandbox_file_publish" },
    { type: "agent.toolCall.output", tool_name: null },
  ]);
}, 120_000);
