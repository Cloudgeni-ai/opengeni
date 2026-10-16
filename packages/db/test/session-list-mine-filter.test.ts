import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "../src/schema";
import {
  bootstrapWorkspace,
  createSession,
  listSessionEntriesForSubject,
  registerDbBinding,
  withWorkspaceSessionActivityRls,
} from "../src";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../src/lossless-json";

let shared: SharedTestDatabase;
let driver: postgres.Sql;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-list-mine-filter");
  if (!acquired) throw new Error("Application-role PostgreSQL fixture unavailable");
  shared = acquired;
  driver = postgres(shared.appUrl, {
    max: 1,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
  db = drizzle(driver, { schema });
  registerDbBinding(db, { rlsStrategy: "force" });
}, 180_000);

afterAll(async () => {
  await driver?.end();
  await shared?.release();
}, 60_000);

test("mine keeps workstreams the subject started or messaged, anywhere in the tree", async () => {
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Synthetic mine filter",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Synthetic mine filter",
    subjectId: `mine-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  const me = grant.subjectId;
  const someoneElse = `other-${identity}`;
  const session = (createdBy: { kind: "subject" | "service"; subjectId: string }) =>
    createSession(db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Synthetic workstream",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy,
    });
  const child = async (rootId: string) => {
    const id = crypto.randomUUID();
    await withWorkspaceSessionActivityRls(db, grant.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into sessions(id, account_id, workspace_id, initial_message, model,
          reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
          parent_session_id, root_session_id, status, created_by_kind, created_by_subject_id)
        values (${id}, ${grant.accountId}, ${grant.workspaceId}, 'Synthetic child',
          'test-model', 'medium', 'standard', 'none', ${id},
          jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null),
          ${rootId}, ${rootId}, 'idle', 'service', 'agent-spawner')`);
    });
    return id;
  };
  const turn = async (
    sessionId: string,
    initiator: { kind: "subject" | "service"; subjectId: string },
    source: "user" | "api" | "system",
    surface: string | null,
  ) => {
    await shared.admin`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, execution_generation, position, prompt, model, reasoning_effort, latency_mode,
        sandbox_backend, source, surface, initiator_kind, initiator_subject_id,
        initiating_human_subject_id
      ) values (
        ${crypto.randomUUID()}, ${grant.accountId}, ${grant.workspaceId}, ${sessionId},
        ${crypto.randomUUID()}, ${`mine-${crypto.randomUUID()}`}, 'completed', 1, 1,
        'synthetic prompt', 'test-model', 'medium', 'standard', 'none', ${source}, ${surface},
        ${initiator.kind}, ${initiator.subjectId},
        ${initiator.kind === "subject" ? initiator.subjectId : null}
      )`;
  };

  const started = await session({ kind: "subject", subjectId: me });
  const messagedInChild = await session({ kind: "service", subjectId: "scheduler" });
  const messagedChild = await child(messagedInChild.id);
  await turn(messagedChild, { kind: "subject", subjectId: me }, "user", "web");
  const viaApi = await session({ kind: "service", subjectId: "scheduler" });
  await turn(viaApi.id, { kind: "subject", subjectId: me }, "api", null);
  const relayedByAgent = await session({ kind: "service", subjectId: "scheduler" });
  await turn(relayedByAgent.id, { kind: "subject", subjectId: me }, "user", "agent");
  const continuation = await session({ kind: "service", subjectId: "scheduler" });
  await turn(continuation.id, { kind: "service", subjectId: "scheduler" }, "system", null);
  const theirs = await session({ kind: "subject", subjectId: someoneElse });
  await turn(theirs.id, { kind: "subject", subjectId: someoneElse }, "user", "web");

  const roots = await listSessionEntriesForSubject(db, grant.workspaceId, {
    subjectId: me,
    parentSessionId: null,
    limit: 50,
    includePinned: false,
    includeTotals: true,
    materializeSnapshot: true,
    mineOnly: true,
  });
  expect(roots.mineOnly).toBe(true);
  expect(new Set(roots.sessions.map((row) => row.id))).toEqual(
    new Set([started.id, messagedInChild.id, viaApi.id]),
  );
  expect(roots.totals?.groups.reduce((sum, group) => sum + group.total, 0)).toBe(4);

  // A matching root's children list in full; the filter is per workstream.
  const children = await listSessionEntriesForSubject(db, grant.workspaceId, {
    subjectId: me,
    parentSessionId: messagedInChild.id,
    limit: 50,
    includePinned: false,
    materializeSnapshot: true,
    mineOnly: true,
  });
  expect(children.sessions.map((row) => row.id)).toEqual([messagedChild]);

  // Without the filter every visible root is listed.
  const everyone = await listSessionEntriesForSubject(db, grant.workspaceId, {
    subjectId: me,
    parentSessionId: null,
    limit: 50,
    includePinned: false,
    materializeSnapshot: true,
  });
  expect(everyone.mineOnly).toBeUndefined();
  expect(everyone.sessions).toHaveLength(6);

  // The turn probe matches the partial index predicate exactly.
  const plan = await shared.admin.begin(async (tx) => {
    await tx`set local enable_seqscan = off`;
    return await tx.unsafe(
      `explain (format json) select 1 from session_turns t
       where t.workspace_id = $1 and t.initiator_subject_id = $2 and t.session_id = $3
         and t.initiator_kind = 'subject' and t.source in ('user', 'api')
         and t.surface is distinct from 'agent'`,
      [grant.workspaceId, me, viaApi.id],
    );
  });
  expect(JSON.stringify(plan)).toContain("session_turns_human_prompt_subject_idx");
}, 120_000);
