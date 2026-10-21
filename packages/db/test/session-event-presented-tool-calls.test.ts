import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { SESSION_EVENT_STEP_TYPES } from "@opengeni/contracts/session-history";
import {
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
    // A step row without a turn (PTY output): no turn's step read finds it.
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
  expect(conversation.map((event) => event.sequence)).toEqual([1, 5, 7, 9, 10, 11]);

  const page = await withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, (tx) =>
    listSessionEventPage(tx, grant.workspaceId, session.id, {
      before: Number.MAX_SAFE_INTEGER,
      limit: 3,
      excludeTypes,
      retainPresentedToolCalls: true,
      payloadMode: "full",
    }),
  );
  expect(page.events.map((event) => event.sequence)).toEqual([9, 10, 11]);
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
