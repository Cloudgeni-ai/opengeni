import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  applyKnowledgeMemoryOperation,
  createDb,
  createSession,
  hashMemoryText,
  nestedPostgresSqlState,
  revertKnowledgeMemoryOperation,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const migrationPath = new URL("../drizzle/0151_hierarchical_memory_foundation.sql", import.meta.url)
  .pathname;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let migrationSql = "";
let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: postgres.Sql;

type AttemptFixture = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

type Fixture = {
  accountA: string;
  accountB: string;
  workspaceA: string;
  workspaceB: string;
  aliceSessionId: string;
  bobSessionId: string;
  aliceAttempt: AttemptFixture;
  memories: Record<
    | "workspace"
    | "aliceUser"
    | "bobUser"
    | "operatorRole"
    | "reviewerRole"
    | "aliceSession"
    | "bobSession"
    | "aliceEphemeral"
    | "expiredEphemeral"
    | "legacy"
    | "crossWorkspace"
    | "relationshipWorkspace"
    | "archiveCandidate"
    | "roleCandidate"
    | "serviceCandidate",
    string
  >;
};

let fixture: Fixture;

async function seedAttempt(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  subjectId: string;
}): Promise<AttemptFixture> {
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await shared!.admin`
    insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id,
      temporal_workflow_id, status, position, prompt, model,
      reasoning_effort, sandbox_backend, execution_generation,
      initiator_kind, initiator_subject_id, initiator_context
    ) values (
      ${turnId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
      ${crypto.randomUUID()}, ${`memory-governance-${turnId}`}, 'running', 1,
      'memory governance fixture', 'test-model', 'high', 'none', 1,
      'subject', ${input.subjectId}, ${shared!.admin.json({ source: "test" })}
    )`;
  await shared!.admin`
    insert into session_turn_attempts (
      id, account_id, workspace_id, session_id, turn_id, execution_generation,
      state, temporal_workflow_id, temporal_workflow_run_id,
      temporal_activity_id, verified_control_revision, mcp_approval_policies
    ) values (
      ${attemptId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
      ${turnId}, 1, 'running', ${`memory-governance-${turnId}`},
      ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
    )`;
  await shared!.admin`
    update session_turns set active_attempt_id = ${attemptId} where id = ${turnId}`;
  await shared!.admin`
    update sessions set active_turn_id = ${turnId}, status = 'running'
    where id = ${input.sessionId}`;
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId,
    attemptId,
    executionGeneration: 1,
  };
}

async function seedMemory(input: {
  accountId: string;
  workspaceId: string;
  name: string;
  scopeType: "workspace" | "user" | "role" | "session" | "ephemeral" | "legacy";
  subjectId?: string;
  roleKey?: string;
  sessionId?: string;
  validFrom?: Date;
  validUntil?: Date;
}): Promise<string> {
  const id = crypto.randomUUID();
  const text = `${input.name} DO_NOT_LEAK_SECRET_SENTINEL`;
  await shared!.admin`
    insert into knowledge_memories (
      id, account_id, workspace_id, status, kind, scope, text, text_hash,
      scope_type, scope_subject_id, scope_role_key, scope_session_id,
      valid_from, valid_until, created_by_kind, created_by_subject_id,
      created_by_context
    ) values (
      ${id}, ${input.accountId}, ${input.workspaceId}, 'active', 'semantic',
      ${input.scopeType}, ${text}, ${hashMemoryText(text)}, ${input.scopeType},
      ${input.subjectId ?? null}, ${input.roleKey ?? null}, ${input.sessionId ?? null},
      ${input.validFrom ?? new Date()}, ${input.validUntil ?? null},
      'subject', 'forged-creator',
      ${shared!.admin.json({ secret: "DO_NOT_LEAK_SECRET_SENTINEL" })}
    )`;
  return id;
}

async function contextRows<T extends Record<string, unknown>>(
  context: {
    accountId: string;
    workspaceId: string;
    subjectId?: string | null;
    actorKind?: "subject" | "service" | null;
    actorId?: string | null;
    sessionId?: string | null;
    roleKey?: string | null;
  },
  query: (sql: postgres.TransactionSql) => Promise<T[]>,
): Promise<T[]> {
  const rows = await app.begin(async (sql) => {
    await sql`select set_config('opengeni.account_id', ${context.accountId}, true)`;
    await sql`select set_config('opengeni.workspace_id', ${context.workspaceId}, true)`;
    await sql`select set_config('opengeni.subject_id', ${context.subjectId ?? ""}, true)`;
    await sql`select set_config('opengeni.memory_actor_kind', ${context.actorKind ?? ""}, true)`;
    await sql`select set_config('opengeni.memory_actor_id', ${context.actorId ?? ""}, true)`;
    await sql`select set_config('opengeni.memory_session_id', ${context.sessionId ?? ""}, true)`;
    await sql`select set_config('opengeni.memory_role_key', ${context.roleKey ?? ""}, true)`;
    return await query(sql);
  });
  return rows as unknown as T[];
}

async function capturedSqlState(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return nestedPostgresSqlState(error);
  }
}

beforeAll(async () => {
  migrationSql = await readFile(migrationPath, "utf8");
  const explicitAdminUrl = process.env.OPENGENI_MEMORY_GOVERNANCE_TEST_ADMIN_URL;
  const explicitAppUrl = process.env.OPENGENI_MEMORY_GOVERNANCE_TEST_APP_URL;
  if (explicitAdminUrl && explicitAppUrl) {
    const appPassword = decodeURIComponent(new URL(explicitAppUrl).password);
    await migrate(explicitAdminUrl);
    await provisionRoles(explicitAdminUrl, { appPassword, rlsStrategy: "force" });
    const admin = postgres(explicitAdminUrl, { max: 4, prepare: false });
    shared = {
      admin,
      adminUrl: explicitAdminUrl,
      appUrl: explicitAppUrl,
      release: async () => {
        await admin.end();
      },
    };
  } else {
    shared = await acquireSharedTestDatabase("migration-0151-hierarchical-memory");
  }
  if (!shared) {
    if (requireRealDatabase)
      throw new Error("real PostgreSQL is required for migration 0151 proof");
    available = false;
    console.warn("[migration-0151] PostgreSQL unavailable, skipping FORCE-RLS assertions");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
  app = postgres(shared.appUrl, { max: 2, prepare: false });

  const [accountA] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('migration 0151 account A') returning id`;
  const [accountB] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('migration 0151 account B') returning id`;
  const [workspaceA] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountA!.id}, 'migration 0151 workspace A') returning id`;
  const [workspaceB] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountB!.id}, 'migration 0151 workspace B') returning id`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceA!.id}, ${accountA!.id}), (${workspaceB!.id}, ${accountB!.id})`;

  const aliceSession = await createSession(client.db, {
    accountId: accountA!.id,
    workspaceId: workspaceA!.id,
    initialMessage: "Alice memory session",
    resources: [],
    metadata: { memoryRoleKey: "operator" },
    model: "test-model",
    sandboxBackend: "none",
  });
  const bobSession = await createSession(client.db, {
    accountId: accountA!.id,
    workspaceId: workspaceA!.id,
    initialMessage: "Bob memory session",
    resources: [],
    metadata: { memoryRoleKey: "reviewer" },
    model: "test-model",
    sandboxBackend: "none",
  });
  const aliceAttempt = await seedAttempt({
    accountId: accountA!.id,
    workspaceId: workspaceA!.id,
    sessionId: aliceSession.id,
    subjectId: "subject-alice",
  });

  const now = Date.now();
  const base = { accountId: accountA!.id, workspaceId: workspaceA!.id };
  const memories = {
    workspace: await seedMemory({ ...base, name: "workspace", scopeType: "workspace" }),
    aliceUser: await seedMemory({
      ...base,
      name: "alice user",
      scopeType: "user",
      subjectId: "subject-alice",
    }),
    bobUser: await seedMemory({
      ...base,
      name: "bob user",
      scopeType: "user",
      subjectId: "subject-bob",
    }),
    operatorRole: await seedMemory({
      ...base,
      name: "operator role",
      scopeType: "role",
      roleKey: "operator",
    }),
    reviewerRole: await seedMemory({
      ...base,
      name: "reviewer role",
      scopeType: "role",
      roleKey: "reviewer",
    }),
    aliceSession: await seedMemory({
      ...base,
      name: "alice session",
      scopeType: "session",
      sessionId: aliceSession.id,
    }),
    bobSession: await seedMemory({
      ...base,
      name: "bob session",
      scopeType: "session",
      sessionId: bobSession.id,
    }),
    aliceEphemeral: await seedMemory({
      ...base,
      name: "alice ephemeral",
      scopeType: "ephemeral",
      sessionId: aliceSession.id,
      validUntil: new Date(now + 60 * 60 * 1000),
    }),
    expiredEphemeral: await seedMemory({
      ...base,
      name: "expired ephemeral",
      scopeType: "ephemeral",
      sessionId: aliceSession.id,
      validFrom: new Date(now - 2 * 60 * 60 * 1000),
      validUntil: new Date(now - 60 * 60 * 1000),
    }),
    legacy: await seedMemory({ ...base, name: "legacy", scopeType: "legacy" }),
    crossWorkspace: await seedMemory({
      accountId: accountB!.id,
      workspaceId: workspaceB!.id,
      name: "cross workspace",
      scopeType: "workspace",
    }),
    relationshipWorkspace: await seedMemory({
      ...base,
      name: "relationship workspace",
      scopeType: "workspace",
    }),
    archiveCandidate: await seedMemory({
      ...base,
      name: "archive candidate",
      scopeType: "workspace",
    }),
    roleCandidate: await seedMemory({ ...base, name: "role candidate", scopeType: "workspace" }),
    serviceCandidate: await seedMemory({
      ...base,
      name: "service candidate",
      scopeType: "workspace",
    }),
  };
  fixture = {
    accountA: accountA!.id,
    accountB: accountB!.id,
    workspaceA: workspaceA!.id,
    workspaceB: workspaceB!.id,
    aliceSessionId: aliceSession.id,
    bobSessionId: bobSession.id,
    aliceAttempt,
    memories,
  };
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await app?.end().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("0151 hierarchical memory foundation", () => {
  test("is a maintenance migration with the live-ledger allocation and explicit writer fence", () => {
    expect(migrationSql.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(migrationPath.endsWith("0151_hierarchical_memory_foundation.sql")).toBe(true);
    expect(migrationSql.match(/opengeni_app sessions to be stopped/g)).toHaveLength(2);
    expect(migrationSql).toContain("LOCK TABLE knowledge_memories IN ACCESS EXCLUSIVE MODE");
    expect(migrationSql).toContain(
      "ALTER TABLE knowledge_memory_relationships FORCE ROW LEVEL SECURITY",
    );
    expect(migrationSql).toContain(
      "ALTER TABLE knowledge_memory_lifecycle_events FORCE ROW LEVEL SECURITY",
    );
  });

  test("enforces FORCE-RLS account, workspace, subject, role, session, and expiry boundaries", async () => {
    if (!available) return;
    const posture = await shared!.admin<
      Array<{ tableName: string; enabled: boolean; forced: boolean }>
    >`
      select relname as "tableName", relrowsecurity as enabled, relforcerowsecurity as forced
      from pg_class
      where relname in (
        'knowledge_memories', 'knowledge_memory_relationships',
        'knowledge_memory_lifecycle_events'
      ) order by relname`;
    expect(posture).toHaveLength(3);
    expect(posture.every((row) => row.enabled && row.forced)).toBe(true);

    const visibleIds = async (context: Parameters<typeof contextRows>[0]) =>
      new Set(
        (
          await contextRows(
            context,
            (sql) =>
              sql<{ id: string }[]>`
              select id from knowledge_memories where workspace_id = ${fixture.workspaceA}`,
          )
        ).map((row) => row.id),
      );
    const workspaceOnly = await visibleIds({
      accountId: fixture.accountA,
      workspaceId: fixture.workspaceA,
    });
    expect(workspaceOnly).toEqual(
      new Set([
        fixture.memories.workspace,
        fixture.memories.relationshipWorkspace,
        fixture.memories.archiveCandidate,
        fixture.memories.roleCandidate,
        fixture.memories.serviceCandidate,
      ]),
    );

    const alice = await visibleIds({
      accountId: fixture.accountA,
      workspaceId: fixture.workspaceA,
      subjectId: "subject-alice",
      actorKind: "subject",
      actorId: "subject-alice",
      sessionId: fixture.aliceSessionId,
      roleKey: "operator",
    });
    for (const id of [
      fixture.memories.workspace,
      fixture.memories.aliceUser,
      fixture.memories.operatorRole,
      fixture.memories.aliceSession,
      fixture.memories.aliceEphemeral,
    ]) {
      expect(alice.has(id)).toBe(true);
    }
    for (const id of [
      fixture.memories.bobUser,
      fixture.memories.reviewerRole,
      fixture.memories.bobSession,
      fixture.memories.expiredEphemeral,
      fixture.memories.legacy,
      fixture.memories.crossWorkspace,
    ]) {
      expect(alice.has(id)).toBe(false);
    }

    const bob = await visibleIds({
      accountId: fixture.accountA,
      workspaceId: fixture.workspaceA,
      subjectId: "subject-bob",
      actorKind: "subject",
      actorId: "subject-bob",
      sessionId: fixture.bobSessionId,
      roleKey: "reviewer",
    });
    expect(bob.has(fixture.memories.bobUser)).toBe(true);
    expect(bob.has(fixture.memories.reviewerRole)).toBe(true);
    expect(bob.has(fixture.memories.bobSession)).toBe(true);
    expect(bob.has(fixture.memories.aliceUser)).toBe(false);

    const crossed = await visibleIds({
      accountId: fixture.accountB,
      workspaceId: fixture.workspaceA,
      subjectId: "subject-alice",
    });
    expect(crossed.size).toBe(0);

    const forbiddenUpdate = await contextRows(
      {
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
      },
      (sql) => sql<{ id: string }[]>`
        update knowledge_memories set reviewed_by = 'forbidden'
        where id = ${fixture.memories.bobUser} returning id`,
    );
    expect(forbiddenUpdate).toHaveLength(0);
  }, 120_000);

  test("applies immutable actor-scoped lifecycle evidence and endpoint-scoped relationships", async () => {
    if (!available) return;
    const forgedOperationId = crypto.randomUUID();
    expect(
      await capturedSqlState(() =>
        contextRows(
          {
            accountId: fixture.accountA,
            workspaceId: fixture.workspaceA,
            subjectId: "subject-alice",
            actorKind: "subject",
            actorId: "subject-alice",
          },
          (sql) => sql`
            select event_id from knowledge_memory_apply_operation(
              ${JSON.stringify({
                operationId: forgedOperationId,
                operationType: "archive",
                targetMemoryId: fixture.memories.archiveCandidate,
                expectedTargetVersion: 1,
              })}::jsonb,
              ${"0".repeat(64)},
              'subject', 'subject-alice', null, null, null, null
            )`,
        ),
      ),
    ).toBe("22023");

    const operationId = crypto.randomUUID();
    const apply = await applyKnowledgeMemoryOperation(client.db, {
      authority: {
        kind: "subject",
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
      },
      plan: {
        operationId,
        operationType: "relationship_add",
        targetMemoryId: fixture.memories.aliceUser,
        expectedTargetVersion: 1,
        relatedMemoryId: fixture.memories.relationshipWorkspace,
        expectedRelatedVersion: 1,
        relationshipType: "related_to",
      },
    });
    const replay = await applyKnowledgeMemoryOperation(client.db, {
      authority: {
        kind: "subject",
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
      },
      plan: {
        operationId,
        operationType: "relationship_add",
        targetMemoryId: fixture.memories.aliceUser,
        expectedTargetVersion: 1,
        relatedMemoryId: fixture.memories.relationshipWorkspace,
        expectedRelatedVersion: 1,
        relationshipType: "related_to",
      },
    });
    expect(replay).toEqual(apply);

    const [edge] = await shared!.admin<
      Array<{ id: string; createdByEventId: string; removedByEventId: string | null }>
    >`
      select id, created_by_event_id as "createdByEventId",
        removed_by_event_id as "removedByEventId"
      from knowledge_memory_relationships where created_by_event_id = ${apply.eventId}`;
    expect(edge).toMatchObject({ createdByEventId: apply.eventId, removedByEventId: null });

    const aliceEdges = await contextRows(
      {
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
        actorKind: "subject",
        actorId: "subject-alice",
      },
      (sql) => sql<{ id: string }[]>`
        select id from knowledge_memory_relationships where id = ${edge!.id}`,
    );
    expect(aliceEdges).toHaveLength(1);
    const bobEdges = await contextRows(
      {
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-bob",
        actorKind: "subject",
        actorId: "subject-bob",
      },
      (sql) => sql<{ id: string }[]>`
        select id from knowledge_memory_relationships where id = ${edge!.id}`,
    );
    expect(bobEdges).toHaveLength(0);

    const aliceEvents = await contextRows(
      {
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
        actorKind: "subject",
        actorId: "subject-alice",
      },
      (sql) => sql<Array<{ id: string; beforeState: unknown; afterState: unknown }>>`
        select id, before_state as "beforeState", after_state as "afterState"
        from knowledge_memory_lifecycle_events where id = ${apply.eventId}`,
    );
    expect(aliceEvents).toHaveLength(1);
    expect(JSON.stringify(aliceEvents[0])).not.toContain("DO_NOT_LEAK_SECRET_SENTINEL");
    expect(JSON.stringify(aliceEvents[0])).not.toMatch(/source_refs|metadata|embedding|"text"/i);
    const bobEvents = await contextRows(
      {
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-bob",
        actorKind: "subject",
        actorId: "subject-bob",
      },
      (sql) => sql<{ id: string }[]>`
        select id from knowledge_memory_lifecycle_events where id = ${apply.eventId}`,
    );
    expect(bobEvents).toHaveLength(0);

    for (const mutation of [
      () =>
        contextRows(
          {
            accountId: fixture.accountA,
            workspaceId: fixture.workspaceA,
            subjectId: "subject-alice",
            actorKind: "subject",
            actorId: "subject-alice",
          },
          (sql) => sql`insert into knowledge_memory_lifecycle_events default values`,
        ),
      () =>
        contextRows(
          {
            accountId: fixture.accountA,
            workspaceId: fixture.workspaceA,
            subjectId: "subject-alice",
          },
          (sql) =>
            sql`update knowledge_memory_relationships set removed_at = now() where id = ${edge!.id}`,
        ),
      () =>
        contextRows(
          {
            accountId: fixture.accountA,
            workspaceId: fixture.workspaceA,
            subjectId: "subject-alice",
            actorKind: "subject",
            actorId: "subject-alice",
          },
          (sql) => sql`delete from knowledge_memory_lifecycle_events where id = ${apply.eventId}`,
        ),
    ]) {
      expect(await capturedSqlState(mutation)).toBe("42501");
    }

    expect(
      await capturedSqlState(() =>
        contextRows(
          {
            accountId: fixture.accountA,
            workspaceId: fixture.workspaceA,
            subjectId: "subject-alice",
            actorKind: "subject",
            actorId: "subject-alice",
          },
          (sql) => sql`
            select event_id from knowledge_memory_revert_operation(
              ${crypto.randomUUID()}::uuid, ${operationId}::uuid,
              ${"f".repeat(64)},
              'subject', 'subject-alice', null, null, null, null
            )`,
        ),
      ),
    ).toBe("22023");

    const revertOperationId = crypto.randomUUID();
    const reverted = await revertKnowledgeMemoryOperation(client.db, {
      authority: {
        kind: "subject",
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
      },
      plan: { operationId: revertOperationId, appliedOperationId: operationId },
    });
    const revertedReplay = await revertKnowledgeMemoryOperation(client.db, {
      authority: {
        kind: "subject",
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
      },
      plan: { operationId: revertOperationId, appliedOperationId: operationId },
    });
    expect(revertedReplay).toEqual(reverted);
    const [retired] = await shared!.admin<
      Array<{ removedByEventId: string | null; version: number }>
    >`
      select removed_by_event_id as "removedByEventId", version
      from knowledge_memory_relationships where id = ${edge!.id}`;
    expect(retired).toMatchObject({ removedByEventId: reverted.eventId, version: 2 });

    const historyAddOperationId = crypto.randomUUID();
    await applyKnowledgeMemoryOperation(client.db, {
      authority: {
        kind: "subject",
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
      },
      plan: {
        operationId: historyAddOperationId,
        operationType: "relationship_add",
        targetMemoryId: fixture.memories.relationshipWorkspace,
        expectedTargetVersion: 1,
        relatedMemoryId: fixture.memories.serviceCandidate,
        expectedRelatedVersion: 1,
        relationshipType: "derived_from",
      },
    });
    const historyRemoveOperationId = crypto.randomUUID();
    await applyKnowledgeMemoryOperation(client.db, {
      authority: {
        kind: "subject",
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
      },
      plan: {
        operationId: historyRemoveOperationId,
        operationType: "relationship_remove",
        targetMemoryId: fixture.memories.relationshipWorkspace,
        expectedTargetVersion: 1,
        relatedMemoryId: fixture.memories.serviceCandidate,
        expectedRelatedVersion: 1,
        relationshipType: "derived_from",
      },
    });
    await revertKnowledgeMemoryOperation(client.db, {
      authority: {
        kind: "subject",
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
      },
      plan: {
        operationId: crypto.randomUUID(),
        appliedOperationId: historyRemoveOperationId,
      },
    });
    expect(
      await capturedSqlState(() =>
        revertKnowledgeMemoryOperation(client.db, {
          authority: {
            kind: "subject",
            accountId: fixture.accountA,
            workspaceId: fixture.workspaceA,
            subjectId: "subject-alice",
          },
          plan: {
            operationId: crypto.randomUUID(),
            appliedOperationId: historyAddOperationId,
          },
        }),
      ),
    ).toBe("40001");
  }, 120_000);

  test("uses exact-attempt role authority, CAS versions, deterministic revert, and safe creator facts", async () => {
    if (!available) return;
    const roleOperationId = crypto.randomUUID();
    const roleApplied = await applyKnowledgeMemoryOperation(client.db, {
      authority: { kind: "attempt", ...fixture.aliceAttempt },
      plan: {
        operationId: roleOperationId,
        operationType: "reclassify",
        targetMemoryId: fixture.memories.roleCandidate,
        expectedTargetVersion: 1,
        scope: { type: "role", roleKey: "operator" },
        namespace: "operations/incidents",
        labels: ["critical", "runbook"],
      },
    });
    const [roleMemory] = await shared!.admin<
      Array<{ scopeType: string; roleKey: string | null; memoryVersion: number }>
    >`
      select scope_type as "scopeType", scope_role_key as "roleKey",
        memory_version as "memoryVersion"
      from knowledge_memories where id = ${fixture.memories.roleCandidate}`;
    expect(roleMemory).toEqual({ scopeType: "role", roleKey: "operator", memoryVersion: 2 });
    const roleEvent = await contextRows(
      {
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
        actorKind: "subject",
        actorId: "subject-alice",
      },
      (sql) => sql<{ id: string }[]>`
        select id from knowledge_memory_lifecycle_events where id = ${roleApplied.eventId}`,
    );
    expect(roleEvent).toHaveLength(1);

    expect(
      await capturedSqlState(() =>
        applyKnowledgeMemoryOperation(client.db, {
          authority: {
            kind: "subject",
            accountId: fixture.accountA,
            workspaceId: fixture.workspaceA,
            subjectId: "subject-alice",
          },
          plan: {
            operationId: crypto.randomUUID(),
            operationType: "archive",
            targetMemoryId: fixture.memories.archiveCandidate,
            expectedTargetVersion: 99,
          },
        }),
      ),
    ).toBe("40001");

    expect(
      await capturedSqlState(() =>
        applyKnowledgeMemoryOperation(client.db, {
          authority: {
            kind: "service",
            accountId: fixture.accountA,
            workspaceId: fixture.workspaceA,
            serviceId: "memory-maintenance",
          },
          plan: {
            operationId: crypto.randomUUID(),
            operationType: "reclassify",
            targetMemoryId: fixture.memories.serviceCandidate,
            expectedTargetVersion: 1,
            scope: { type: "user", subjectId: "subject-alice" },
            namespace: "private",
            labels: [],
          },
        }),
      ),
    ).toBe("42501");

    const archiveOperationId = crypto.randomUUID();
    const archiveApplied = await applyKnowledgeMemoryOperation(client.db, {
      authority: {
        kind: "subject",
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
      },
      plan: {
        operationId: archiveOperationId,
        operationType: "archive",
        targetMemoryId: fixture.memories.archiveCandidate,
        expectedTargetVersion: 1,
      },
    });
    expect(
      await capturedSqlState(() =>
        revertKnowledgeMemoryOperation(client.db, {
          authority: {
            kind: "subject",
            accountId: fixture.accountA,
            workspaceId: fixture.workspaceA,
            subjectId: "subject-bob",
          },
          plan: { operationId: crypto.randomUUID(), appliedOperationId: archiveOperationId },
        }),
      ),
    ).toBe("42501");
    const archiveReverted = await revertKnowledgeMemoryOperation(client.db, {
      authority: {
        kind: "subject",
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        subjectId: "subject-alice",
      },
      plan: { operationId: crypto.randomUUID(), appliedOperationId: archiveOperationId },
    });
    const [restored] = await shared!.admin<
      Array<{ status: string; memoryVersion: number; eventCount: number }>
    >`
      select memory.status, memory.memory_version as "memoryVersion",
        count(event.id)::int as "eventCount"
      from knowledge_memories memory
      join knowledge_memory_lifecycle_events event
        on event.workspace_id = memory.workspace_id and event.target_memory_id = memory.id
      where memory.id = ${fixture.memories.archiveCandidate}
        and event.id in (${archiveApplied.eventId}, ${archiveReverted.eventId})
      group by memory.status, memory.memory_version`;
    expect(restored).toEqual({ status: "active", memoryVersion: 3, eventCount: 2 });

    expect(
      await capturedSqlState(() =>
        contextRows(
          {
            accountId: fixture.accountA,
            workspaceId: fixture.workspaceA,
            subjectId: "subject-alice",
            sessionId: fixture.aliceSessionId,
            roleKey: "operator",
          },
          (sql) => sql`
            update knowledge_memories set namespace_key = 'forbidden-direct-update'
            where id = ${fixture.memories.aliceUser}`,
        ),
      ),
    ).toBe("55000");
    expect(
      await capturedSqlState(() =>
        contextRows(
          {
            accountId: fixture.accountA,
            workspaceId: fixture.workspaceA,
            subjectId: "subject-alice",
          },
          (sql) => sql`
            update knowledge_memories set created_by_subject_id = 'forged'
            where id = ${fixture.memories.aliceUser}`,
        ),
      ),
    ).toBe("55000");

    const [creator] = await shared!.admin<
      Array<{ kind: string; subjectId: string; context: Record<string, unknown> }>
    >`
      select created_by_kind as kind, created_by_subject_id as "subjectId",
        created_by_context as context
      from knowledge_memories where id = ${fixture.memories.aliceUser}`;
    expect(creator).toEqual({
      kind: "service",
      subjectId: "unattributed-legacy",
      context: { legacyWriter: true },
    });

    await shared!.admin`
      update session_turn_attempts set state = 'closed', outcome = 'completed', closed_at = now()
      where id = ${fixture.aliceAttempt.attemptId}`;
    await expect(
      applyKnowledgeMemoryOperation(client.db, {
        authority: { kind: "attempt", ...fixture.aliceAttempt },
        plan: {
          operationId: crypto.randomUUID(),
          operationType: "archive",
          targetMemoryId: fixture.memories.roleCandidate,
          expectedTargetVersion: 2,
        },
      }),
    ).rejects.toThrow("exact current attempt");

    const creatorSessionCleanupMemoryId = crypto.randomUUID();
    await shared!.admin`
      insert into knowledge_memories (
        id, account_id, workspace_id, status, kind, scope, text,
        created_by_session_id
      ) values (
        ${creatorSessionCleanupMemoryId}, ${fixture.accountA}, ${fixture.workspaceA},
        'active', 'semantic', 'workspace', 'creator session cleanup proof',
        ${fixture.bobSessionId}
      )`;
    expect(
      await capturedSqlState(
        () =>
          shared!.admin`
          update knowledge_memories set created_by_session_id = null
          where id = ${creatorSessionCleanupMemoryId}`,
      ),
    ).toBe("55000");
    await shared!.admin`delete from sessions where id = ${fixture.bobSessionId}`;
    const [cleanedCreatorLink] = await shared!.admin<
      Array<{
        createdBySessionId: string | null;
        createdByKind: string;
        createdBySubjectId: string;
        createdByContext: Record<string, unknown>;
      }>
    >`
      select created_by_session_id as "createdBySessionId",
        created_by_kind as "createdByKind",
        created_by_subject_id as "createdBySubjectId",
        created_by_context as "createdByContext"
      from knowledge_memories where id = ${creatorSessionCleanupMemoryId}`;
    expect(cleanedCreatorLink).toEqual({
      createdBySessionId: null,
      createdByKind: "service",
      createdBySubjectId: "unattributed-legacy",
      createdByContext: { legacyWriter: true },
    });
  }, 120_000);
});
