import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
} from "../src";

const source = readFileSync(
  new URL("../drizzle/0886_remove_duplicate_session_identity_indexes.sql", import.meta.url),
  "utf8",
);
let shared: RestrictedRuntimeTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase(
    "duplicate-session-indexes",
    "public",
  );
  if (!acquired) throw new Error("Duplicate-index migration requires real PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test("the strict owner removes only duplicates and ordinary session/attempt admission keeps its foreign keys", async () => {
  const indexes = await shared.admin<{ relname: string }[]>`
    select relname from pg_class where relname in ('sessions_workspace_id_idx',
      'sessions_workspace_id_uq', 'session_turns_workspace_id_idx', 'session_turns_workspace_id_uq')
    order by relname`;
  expect(indexes.map((row) => row.relname)).toEqual([
    "session_turns_workspace_id_idx",
    "sessions_workspace_id_idx",
  ]);
  const constraints = await shared.admin<{ table_name: string; references: number }[]>`
    select i.relname AS table_name, count(*)::int AS references
    from pg_constraint c join pg_class i on i.oid = c.conindid
    where i.relname in ('sessions_workspace_id_idx', 'session_turns_workspace_id_idx')
      and c.contype = 'f' and c.convalidated
    group by i.relname order by i.relname`;
  expect(constraints).toHaveLength(2);
  expect(constraints.every((row) => row.references > 0)).toBe(true);
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "Index migration",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "Index migration",
    subjectId: `index-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "initial",
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    resources: [],
    metadata: {},
  });
  const started = await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  expect(
    await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: session.id,
      workflowId: started.temporalWorkflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    }),
  ).toMatchObject({ action: "claimed" });
  // Re-running as the real, non-superuser owner is harmless.
  await shared.admin.begin(async (tx) => {
    await tx.unsafe(`set local role "${shared.ownerRole}"`);
    await tx.unsafe(source);
  });
});

test.each([
  "CREATE UNIQUE INDEX sessions_workspace_id_uq ON sessions (id, workspace_id)",
  "CREATE UNIQUE INDEX sessions_workspace_id_uq ON sessions (workspace_id, id) INCLUDE (status)",
  "CREATE UNIQUE INDEX sessions_workspace_id_uq ON sessions (workspace_id, id) WHERE status = 'idle'",
  "CREATE UNIQUE INDEX sessions_workspace_id_uq ON sessions (workspace_id, id) NULLS NOT DISTINCT",
])("drift refuses removal: %s", async (definition) => {
  await expect(
    shared.admin.begin(async (tx) => {
      await tx.unsafe(`set local role "${shared.ownerRole}"`);
      await tx.unsafe(definition);
      await tx.unsafe(source);
    }),
  ).rejects.toThrow("non-equivalent index");
});

test("a new constraint dependency refuses removal", async () => {
  await expect(
    shared.admin.begin(async (tx) => {
      await tx.unsafe(`set local role "${shared.ownerRole}"`);
      await tx`create unique index sessions_workspace_id_uq on sessions (workspace_id, id)`;
      await tx`alter table sessions add constraint sessions_workspace_id_uq
      unique using index sessions_workspace_id_uq`;
      await tx.unsafe(source);
    }),
  ).rejects.toThrow("with dependencies");
});

test("a missing retained index refuses removal", async () => {
  await expect(
    shared.admin.begin(async (tx) => {
      await tx.unsafe(`set local role "${shared.ownerRole}"`);
      await tx`create unique index sessions_workspace_id_uq on sessions (workspace_id, id)`;
      await tx`alter index sessions_workspace_id_idx rename to missing_retained_fixture`;
      await tx.unsafe(source);
    }),
  ).rejects.toThrow("without retained index");
});

test("a busy table aborts before checking or removing indexes", async () => {
  await shared.admin.begin(async (tx) => {
    await tx.unsafe(`set local role "${shared.ownerRole}"`);
    await tx`create unique index sessions_workspace_id_uq on sessions (workspace_id, id)`;
  });
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = shared.admin.begin(async (tx) => {
    await tx`lock table sessions in access share mode`;
    ready.resolve();
    await release.promise;
  });
  try {
    await ready.promise;
    await expect(
      shared.admin.begin(async (tx) => {
        await tx.unsafe(`set local role "${shared.ownerRole}"`);
        await tx.unsafe(source);
      }),
    ).rejects.toMatchObject({ code: "55P03" });
    const [row] =
      await shared.admin`select to_regclass('sessions_workspace_id_uq') is not null as retained`;
    expect(row!.retained).toBe(true);
  } finally {
    release.resolve();
    await blocker;
  }
  await shared.admin.begin(async (tx) => {
    await tx.unsafe(`set local role "${shared.ownerRole}"`);
    await tx.unsafe(source);
  });
});
