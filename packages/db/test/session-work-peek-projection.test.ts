import { afterAll, beforeAll, expect, test } from "bun:test";
import type postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  peekSessionWork,
} from "../src/index";
import { submitTestHumanPrompt } from "../../../test/integration/helpers/session-control";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-work-peek-projection");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("idle and owned observations never load unused session/turn/attempt payloads", async () => {
  const id = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: id,
      accountName: "Peek projection",
      workspaceExternalSource: "test",
      workspaceExternalId: id,
      workspaceName: "Peek projection",
      subjectId: `peek-${id}`,
    })
  ).workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "x".repeat(65_536),
    metadata: { large: "x".repeat(65_536) },
    resources: [],
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const capture = async (accountId: string | undefined) => {
    const queries: string[] = [];
    driver.options.debug = (_connection, query) => {
      queries.push(query);
    };
    try {
      const value = await peekSessionWork(
        client.db,
        grant.workspaceId,
        session.id,
        true,
        accountId,
      );
      return { value, queries };
    } finally {
      driver.options.debug = false;
    }
  };
  const assertProjection = (queries: string[], table: string, expectedColumns: string[]) => {
    const selected = queries.filter(
      (query) => query.startsWith("select ") && query.includes(` from "${table}" where`),
    );
    expect(selected.length).toBeGreaterThan(0);
    const allowed = new Set(expectedColumns);
    for (const query of selected) {
      const fields = query.slice("select ".length, query.indexOf(" from "));
      const columns = [...fields.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
      expect(columns.length).toBeGreaterThan(0);
      expect(columns.every((column) => allowed.has(column))).toBe(true);
    }
  };
  const sessionColumns = [
    "id",
    "account_id",
    "status",
    "active_turn_id",
    "last_sequence",
    "admission_block",
    "compact_requested",
    "input_wait_turn_id",
    "input_wait_until",
  ];
  for (const accountId of [undefined, grant.accountId]) {
    const idle = await capture(accountId);
    expect(idle.value).toEqual({ kind: "idle" });
    assertProjection(idle.queries, "sessions", sessionColumns);
    assertProjection(idle.queries, "session_event_cursors", ["last_sequence"]);
  }
  expect((await capture(crypto.randomUUID())).value).toEqual({ kind: "unavailable" });
  await submitTestHumanPrompt(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    subjectId: grant.subjectId,
    text: "y".repeat(65_536),
    resources: [],
    tools: [],
    reasoningEffortFallback: "medium",
  });
  const attemptId = crypto.randomUUID(),
    workflowId = `peek-${id}`;
  const workflowRunId = crypto.randomUUID(),
    dispatchId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    attemptId,
    workflowId,
    workflowRunId,
    dispatchId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Expected live attempt");
  const owned = await capture(grant.accountId);
  expect(owned.value).toEqual({
    kind: "attempt-owned",
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
    activityRef: { workflowId, workflowRunId, activityId: dispatchId, quiesced: false },
  });
  assertProjection(owned.queries, "sessions", sessionColumns);
  assertProjection(owned.queries, "session_turns", [
    "id",
    "session_id",
    "status",
    "metadata",
    "trigger_event_id",
    "execution_generation",
    "active_attempt_id",
    "scheduled_task_run_id",
  ]);
  assertProjection(owned.queries, "session_turn_attempts", [
    "id",
    "temporal_workflow_id",
    "temporal_workflow_run_id",
    "temporal_activity_id",
    "quiesced_at",
  ]);
  await expect(capture(undefined)).rejects.toThrow(`still owned by attempt ${attemptId}`);
});
