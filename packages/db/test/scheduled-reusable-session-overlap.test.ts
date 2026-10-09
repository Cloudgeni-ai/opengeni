import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  addSessionSystemUpdateWithSourceMutation,
  bootstrapWorkspace,
  createDb,
  createSession,
} from "../src/index";

// Contract: a skip-overlap schedule that reuses one session skips only while
// that session still has work in progress. A failed last occurrence must not
// make every later occurrence skip forever.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-reusable-session-overlap");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function reusableSession(status: string) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Reusable schedule",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Reusable schedule",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: "Scheduled check",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: `subject-${suffix}` },
  });
  // Fixture the settled outcome of the previous occurrence directly.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update session_turns set status = 'failed', finished_at = now()
      where session_id = ${session.id}::uuid`;
    await tx`update sessions set status = ${status}, active_turn_id = null
      where id = ${session.id}::uuid`;
  });
  return { ...scope, sessionId: session.id };
}

async function nextOccurrence(target: Awaited<ReturnType<typeof reusableSession>>) {
  const rejections: (string | null)[] = [];
  const result = await addSessionSystemUpdateWithSourceMutation(
    client.db,
    {
      accountId: target.accountId,
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
      kind: "child_terminal_result",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: `scheduled-${crypto.randomUUID()}`,
      summary: "Next scheduled occurrence",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "idle",
      },
    },
    async (_tx, _wakeEventId, _updateId, rejection) => {
      rejections.push(rejection);
    },
    { requireIdleSession: true },
  );
  return { reason: result.reason, rejections };
}

test.each([
  ["idle", "added"],
  ["failed", "added"],
  ["running", "session_not_idle"],
  ["requires_action", "session_not_idle"],
  ["waiting_capacity", "session_not_idle"],
])("a reusable session that is %s admits the next occurrence: %s", async (status, expected) => {
  const target = await reusableSession(status);
  const occurrence = await nextOccurrence(target);
  expect(occurrence.reason as string).toBe(expected);
  expect(occurrence.rejections).toEqual([expected === "added" ? null : "session_not_idle"]);
});
