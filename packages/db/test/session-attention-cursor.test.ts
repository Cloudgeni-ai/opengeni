import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  withWorkspaceSubjectRls,
  type AppendEventInput,
} from "../src";
import { sessionEventCursors } from "../src/schema";
import {
  MEANINGFUL_SESSION_EVENT_TYPES,
  meaningfulSessionSequenceSql,
} from "../src/session-meaningful-events";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("attention-cursor");
  if (!acquired) throw new Error("Real application-role PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const id = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: id,
    accountName: "Attention cursor",
    workspaceExternalSource: "test",
    workspaceExternalId: id,
    workspaceName: "Attention cursor",
    subjectId: `test:${id}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Synthetic request",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { grant, session };
}

test("the app-role attention cursor equals the indexed history predicate for every admitted event kind", async () => {
  const { grant, session } = await fixture();
  const [usage] = await appendSessionEvents(client.db, grant.workspaceId, session.id, [
    { type: "agent.model.usage", payload: {} },
  ]);
  const cases: AppendEventInput[] = [
    ...MEANINGFUL_SESSION_EVENT_TYPES.map((type) => ({
      type,
      payload: { text: "Answer", output: "Answer" },
    })),
    { type: "agent.message.completed", payload: { text: "Progress", phase: "commentary" } },
    { type: "agent.message.completed", payload: { text: "" } },
    { type: "turn.completed", payload: { output: null, result: "Fallback" } },
    { type: "turn.completed", payload: { output: null, reply: "Choose" } },
    { type: "turn.completed", payload: { output: "" } },
    { type: "turn.completed", payload: { output: "", result: "Ignored" } },
    { type: "turn.completed", payload: { output: "Maintenance", maintenance: false } },
    { type: "turn.completed", payload: { output: "Limit", segmentLimit: true } },
    {
      type: "agent.model.usage",
      payload: {},
      turnAssociation: "duplicate",
      duplicateOfEventId: usage!.id,
      duplicateReason: "replayed_client_event",
    },
    { type: "turn.failed", payload: {}, turnAssociation: "late_rejected" as const },
    { type: "agent.message.delta", payload: { text: "token" } },
    { type: "workspace.revision.captured", payload: {} },
  ];
  for (const input of cases) {
    await appendSessionEvents(client.db, grant.workspaceId, session.id, [input]);
    const [row] = await withWorkspaceSubjectRls(
      client.db,
      grant.workspaceId,
      grant.subjectId,
      (tx) =>
        tx
          .select({
            cursor: sessionEventCursors.lastMeaningfulSequence,
            indexed: meaningfulSessionSequenceSql(
              sessionEventCursors.workspaceId,
              sessionEventCursors.sessionId,
            ),
          })
          .from(sessionEventCursors)
          .where(sql`${sessionEventCursors.sessionId} = ${session.id}`),
    );
    expect(row).toBeDefined();
    expect(row!.cursor).toBe(row!.indexed);
  }
}, 60_000);

test("batched raw activity and a rolled-back append leave the attention frontier unchanged", async () => {
  const { grant, session } = await fixture();
  const [answer] = await appendSessionEvents(client.db, grant.workspaceId, session.id, [
    { type: "agent.message.completed", payload: { text: "Answer" } },
  ]);
  const raw = await appendSessionEvents(
    client.db,
    grant.workspaceId,
    session.id,
    Array.from({ length: 512 }, () => ({
      type: "agent.message.delta",
      payload: { text: "token" },
    })),
  );
  const cursor = () => shared.admin`select last_sequence, last_meaningful_sequence, revision
    from session_event_cursors where session_id=${session.id}`;
  const [before] = await cursor();
  expect(before!.last_sequence).toBe(raw.at(-1)!.sequence);
  expect(before!.last_meaningful_sequence).toBe(answer!.sequence);
  await expect(
    shared.admin.begin(async (tx) => {
      await tx`insert into session_events(account_id,workspace_id,session_id,sequence,type,payload)
      values(${grant.accountId},${grant.workspaceId},${session.id},${raw.at(-1)!.sequence + 1},'turn.failed','{}'::jsonb)`;
      throw new Error("Synthetic rollback");
    }),
  ).rejects.toThrow("Synthetic rollback");
  const [after] = await cursor();
  expect(after).toEqual(before);
}, 60_000);
