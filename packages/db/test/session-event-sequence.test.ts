import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  getSessionEventSequence,
  withWorkspaceSubjectRls,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-event-sequence");
  if (!acquired) throw new Error("PostgreSQL required for session sequence regression");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 1 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("sequence-only read preserves cursor authority, tenant isolation and integrity", async () => {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Sequence test",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Sequence test",
    subjectId: `reader:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const read = (id = session.id) => getSessionEventSequence(client.db, grant.workspaceId, id);
  expect(await read()).toBe(0);
  expect(await read(crypto.randomUUID())).toBeNull();
  const otherAccess = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `${suffix}-other`,
    accountName: "Other tenant",
    workspaceExternalSource: "test",
    workspaceExternalId: `${suffix}-other`,
    workspaceName: "Other tenant",
    subjectId: `reader:${suffix}-other`,
  });
  expect(
    await getSessionEventSequence(
      client.db,
      otherAccess.workspaceGrants[0]!.workspaceId,
      session.id,
    ),
  ).toBeNull();
  const scoped = () =>
    withWorkspaceSubjectRls(client.db, grant.workspaceId, grant.subjectId, (tx) =>
      getSessionEventSequence(tx, grant.workspaceId, session.id),
    );
  expect(await scoped()).toBe(0);

  // Raw deltas can advance the canonical cursor without the compatibility row.
  await shared.admin`update session_event_cursors set last_sequence=7 where session_id=${session.id}`;
  expect(await read()).toBe(7);
  expect((await getSession(client.db, grant.workspaceId, session.id))?.lastSequence).toBe(7);
  expect(await scoped()).toBe(7);

  const driver = (client.db as unknown as { $client: postgres.Sql }).$client;
  const queries: string[] = [];
  const previousDebug = driver.options.debug;
  driver.options.debug = (_connection, query) => {
    queries.push(query);
  };
  try {
    expect(await read()).toBe(7);
  } finally {
    driver.options.debug = previousDebug;
  }
  // BEGIN, one RLS setup, one joined read, COMMIT. No model/control/MCP reads.
  expect(queries).toHaveLength(4);
  expect(queries.filter((query) => query.includes('from "sessions"'))).toHaveLength(1);
  expect(queries.join("\n")).not.toContain("workspace_inference_controls");

  // Freeze a private audience directly; neither reader may expose this row to
  // a different named subject in the same workspace.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role=replica`;
    await tx`update sessions set site_access_root_id=id,site_owner_subject_id=${grant.subjectId}
      where id=${session.id}`;
  });
  expect(await scoped()).toBe(7);
  await withWorkspaceSubjectRls(client.db, grant.workspaceId, "reader:unrelated", async (tx) => {
    expect(await getSessionEventSequence(tx, grant.workspaceId, session.id)).toBeNull();
    expect(await getSession(tx, grant.workspaceId, session.id)).toBeNull();
  });

  const invariant = `Session event cursor invariant failed for session ${session.id}`;
  // Ordinary writers maintain the cursor. Bypass those triggers only to build
  // an inconsistent historical fixture and verify both readers fail closed.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role=replica`;
    await tx`update sessions set last_sequence=8 where id=${session.id}`;
  });
  await expect(read()).rejects.toThrow(invariant);
  await expect(getSession(client.db, grant.workspaceId, session.id)).rejects.toThrow(invariant);
  await shared.admin`update sessions set last_sequence=0 where id=${session.id}`;
  await shared.admin`delete from session_event_cursors where session_id=${session.id}`;
  await expect(read()).rejects.toThrow(invariant);
  await expect(getSession(client.db, grant.workspaceId, session.id)).rejects.toThrow(invariant);
});
