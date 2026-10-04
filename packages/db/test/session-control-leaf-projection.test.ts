import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  evaluateSessionControls,
  getOrganizationPrivateSessionSettings,
  initializeSessionStartAtomically,
  mutateSessionControlInTransaction,
  SessionControlInvariantError,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withSessionRlsActorContext,
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
  type Database,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const dialect = new PgDialect();

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-control-leaf-projection");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Grant = { accountId: string; workspaceId: string; subjectId: string };

async function session(grant: Grant, parentSessionId?: string) {
  return await createSession(client.db, {
    ...grant,
    ...(parentSessionId ? { parentSessionId } : {}),
    initialMessage: "leaf projection fixture",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    createdByContext: {},
  });
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "leaf-projection",
    accountExternalId: suffix,
    accountName: "Leaf projection",
    workspaceExternalSource: "leaf-projection",
    workspaceExternalId: suffix,
    workspaceName: "Leaf projection",
    subjectId: `subject:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return { grant, root: await session(grant), unrelated: await session(grant) };
}

async function control(grant: Grant, sessionId: string, action: "pause" | "resume") {
  return await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, (db) =>
    mutateSessionControlInTransaction(db, {
      ...grant,
      sessionId,
      actor: { type: "human", subjectId: grant.subjectId },
      operationKey: crypto.randomUUID(),
      action,
    }),
  );
}

async function interrupted(grant: Grant, sessionId: string) {
  await initializeSessionStartAtomically(client.db, {
    ...grant,
    sessionId,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: null,
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  expect(claimed.action).toBe("claimed");
  expect((await control(grant, sessionId, "pause")).interruptionCount).toBe(1);
  return attemptId;
}

async function stoppingCommand(grant: Grant, sessionId: string) {
  await shared.admin`
    insert into session_background_commands (
      account_id, workspace_id, session_id, provider, state,
      control_workspace_id, enrollment_id, connection_instance_id, op_id,
      cancel_requested_at, cancel_requested_by
    ) values (
      ${grant.accountId}, ${grant.workspaceId}, ${sessionId}, 'connected_machine', 'stopping',
      ${grant.workspaceId}, ${crypto.randomUUID()}, 'fixture-instance', ${crypto.randomUUID()},
      now(), 'fixture'
    )`;
}

/** Observe the SQL actually executed against PostgreSQL, without mocking results. */
async function project(grant: Grant, ids: string[], afterQuery?: (text: string) => Promise<void>) {
  const queries: string[] = [];
  const controls = await withWorkspaceRls(client.db, grant.workspaceId, async (db) => {
    const observed = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "execute") return Reflect.get(target, property, receiver);
        return async (query: SQL) => {
          const text = dialect.sqlToQuery(query).sql;
          queries.push(text);
          const result = await target.execute(query);
          await afterQuery?.(text);
          return result;
        };
      },
    }) as Database;
    return await evaluateSessionControls(observed, grant.workspaceId, ids, { lock: "none" });
  });
  return { controls, queries, recursive: queries.filter((q) => /with recursive/i.test(q)) };
}

async function expectBulkParity(grant: Grant, id: string, unrelated: string) {
  const single = await project(grant, [id]);
  // Multi-target projection deliberately retains the old recursive path.
  const bulk = await project(grant, [id, unrelated]);
  expect(single.controls.get(id)).toEqual(bulk.controls.get(id));
  expect(bulk.recursive).toHaveLength(3);
  return single;
}

test("root leaf replaces all three recursive projections with one bounded statement", async () => {
  const { grant, root, unrelated } = await fixture();
  const read = await expectBulkParity(grant, root.id, unrelated.id);
  expect(read.recursive).toHaveLength(0);
  expect(read.queries).toHaveLength(2); // workspace control + direct leaf projection (formerly 4)
  expect(read.queries.filter((q) => q.includes("with target as materialized"))).toHaveLength(1);
  expect(read.controls.get(root.id)).toMatchObject({
    state: "active",
    settlement: null,
    backgroundCommandSettlement: null,
  });
  // Duplicate targets still take the single-target fast path.
  expect((await project(grant, [root.id, root.id])).recursive).toHaveLength(0);
});

test("nonroot leaf skips descendant queries but preserves ancestor pause and resume overrides", async () => {
  const { grant, root, unrelated } = await fixture();
  const child = await session(grant, root.id);
  await control(grant, root.id, "pause");
  const paused = await expectBulkParity(grant, child.id, unrelated.id);
  expect(paused.recursive).toHaveLength(1);
  expect(paused.queries).toHaveLength(3); // workspace control + leaf + ancestry (formerly 4)
  expect(paused.recursive[0]).toContain("ancestry as");
  expect(paused.controls.get(child.id)?.primaryBlocker?.sessionId).toBe(root.id);
  await control(grant, child.id, "resume");
  const resumed = await expectBulkParity(grant, child.id, unrelated.id);
  expect(resumed.controls.get(child.id)?.state).toBe("active");
  expect(resumed.recursive).toHaveLength(1);
});

test("leaf direct counts retain distinct attempts, pending/quiescence flags and stopping commands", async () => {
  const { grant, root, unrelated } = await fixture();
  const attemptId = await interrupted(grant, root.id);
  const resumed = await control(grant, root.id, "resume");
  await shared.admin`
    insert into session_attempt_interruptions (
      account_id, workspace_id, session_id, operation_id, attempt_id,
      kind, control_revision, state, settled_at
    ) select account_id, workspace_id, session_id, ${resumed.receipt.id}, attempt_id,
      kind, control_revision, 'settled', now()
      from session_attempt_interruptions where attempt_id = ${attemptId}`;
  await stoppingCommand(grant, root.id);
  await stoppingCommand(grant, unrelated.id);
  const read = await expectBulkParity(grant, root.id, unrelated.id);
  expect(read.recursive).toHaveLength(0);
  expect(read.controls.get(root.id)?.settlement).toEqual({
    state: "stopping",
    attemptCount: 1,
    interruptionPendingCount: 1,
    quiescencePendingCount: 1,
  });
  expect(read.controls.get(root.id)?.backgroundCommandSettlement?.commandCount).toBe(1);

  for (const state of ["delivered", "acknowledged", "settled", "rejected_stale"]) {
    await shared.admin`update session_attempt_interruptions set state = ${state}
      where attempt_id = ${attemptId}`;
    const updated = await expectBulkParity(grant, root.id, unrelated.id);
    expect(updated.controls.get(root.id)?.settlement).toMatchObject({
      attemptCount: 1,
      interruptionPendingCount: state === "delivered" || state === "acknowledged" ? 1 : 0,
      quiescencePendingCount: state === "settled" || state === "rejected_stale" ? 1 : 0,
    });
  }
  await shared.admin`update session_turn_attempts set quiesced_at = now()
    where id = ${attemptId}`;
  expect(
    (await expectBulkParity(grant, root.id, unrelated.id)).controls.get(root.id)?.settlement,
  ).toBeNull();
});

test("nonleaf root/child retain recursive summaries including grandchildren", async () => {
  const { grant, root, unrelated } = await fixture();
  const child = await session(grant, root.id);
  const grandchild = await session(grant, child.id);
  await interrupted(grant, grandchild.id);
  await stoppingCommand(grant, grandchild.id);
  for (const [id, recursiveCount] of [
    [root.id, 2],
    [child.id, 3],
  ] as const) {
    const read = await expectBulkParity(grant, id, unrelated.id);
    expect(read.recursive).toHaveLength(recursiveCount);
    expect(read.queries).toHaveLength(recursiveCount + 2);
    expect(read.recursive.some((q) => q.includes("descendant_sessions"))).toBe(true);
    expect(read.recursive.some((q) => q.includes("descendants(target_id"))).toBe(true);
    expect(read.controls.get(id)?.settlement?.attemptCount).toBe(1);
    expect(read.controls.get(id)?.backgroundCommandSettlement?.commandCount).toBe(1);
  }
});

test("missing roots and other-workspace targets still fail closed", async () => {
  const { grant, root } = await fixture();
  const other = await fixture();
  for (const id of [crypto.randomUUID(), other.root.id]) {
    await expect(project(grant, [id])).rejects.toBeInstanceOf(SessionControlInvariantError);
    await expect(project(grant, [id, root.id])).rejects.toBeInstanceOf(
      SessionControlInvariantError,
    );
  }
});

test("leaf facts do not outlive their statement or leak into the next projection", async () => {
  const { grant, root, unrelated } = await fixture();
  let inserted = false;
  const before = await project(grant, [root.id], async (text) => {
    if (inserted || !text.includes("with target as materialized")) return;
    inserted = true;
    const child = await session(grant, root.id);
    await interrupted(grant, child.id);
    await stoppingCommand(grant, child.id);
  });
  expect(inserted).toBe(true);
  expect(before.recursive).toHaveLength(0);
  expect(before.controls.get(root.id)?.settlement).toBeNull();
  expect(before.controls.get(root.id)?.backgroundCommandSettlement).toBeNull();
  const after = await expectBulkParity(grant, root.id, unrelated.id);
  expect(after.recursive).toHaveLength(2);
  expect(after.controls.get(root.id)?.settlement?.attemptCount).toBe(1);
  expect(after.controls.get(root.id)?.backgroundCommandSettlement?.commandCount).toBe(1);
});

test("private root projection remains scoped to the exact RLS subject", async () => {
  const userId = `leaf-private-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Leaf private owner",
  });
  const grant = access.workspaceGrants[0]!;
  await shared.admin`insert into session_tenancy_activations (
    account_id, activation_version, inventory_digest, parity_digest, activated_by
  ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
    on conflict (account_id) do nothing`;
  const settings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: grant.subjectId,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: grant.subjectId,
    enabled: true,
    expectedVersion: settings.version,
    operationId: crypto.randomUUID(),
  });
  const root = await withSessionRlsActorContext({ subjectId: grant.subjectId }, () =>
    session(grant),
  );
  await transitionSessionVisibility(client.db, {
    workspaceId: grant.workspaceId,
    sessionId: root.id,
    actorSubjectId: grant.subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: crypto.randomUUID(),
  });
  const ownerRead = () =>
    withSessionRlsActorContext({ subjectId: grant.subjectId }, () => project(grant, [root.id]));
  expect((await ownerRead()).recursive).toHaveLength(0);
  await expect(
    withSessionRlsActorContext({ subjectId: "user:unrelated" }, () => project(grant, [root.id])),
  ).rejects.toBeInstanceOf(SessionControlInvariantError);
  expect((await ownerRead()).controls.has(root.id)).toBe(true);
});
