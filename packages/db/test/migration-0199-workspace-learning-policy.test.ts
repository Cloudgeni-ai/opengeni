import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveWorkspaceLearningPolicyEffectiveMode } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  WorkspaceLearningPolicyConflictError,
  WorkspaceLearningPolicyInvalidOperationError,
  WorkspaceLearningPolicyOperationReuseError,
  activateWorkspaceLearningPolicyRevision,
  createDb,
  createSession,
  createWorkspaceLearningPolicyRevision,
  getOrCreateWorkspaceLearningPolicySnapshot,
  listWorkspaceLearningPolicyHistory,
  rollbackWorkspaceLearningPolicyRevision,
  type DbClient,
} from "../src";
import { migrate } from "../src/migrate";
import { nestedPostgresSqlState } from "../src/persistence-errors";
import { provisionRoles } from "../src/provision-roles";

const migrationUrl = new URL("../drizzle/0199_workspace_learning_policy.sql", import.meta.url);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: postgres.Sql;
let fixture: {
  accountA: string;
  workspaceA: string;
  accountB: string;
  workspaceB: string;
};

type Attempt = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

type PolicyFixture = {
  accountId: string;
  workspaceId: string;
};

async function seedPolicyFixture(label: string): Promise<PolicyFixture> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`learning policy ${label} account`}) returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`learning policy ${label} workspace`}) returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function seedAttempt(input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
}): Promise<Attempt> {
  const session = await createSession(client.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: "Learning-policy snapshot fixture",
    resources: [],
    metadata: {},
    model: "test-model",
    sandboxBackend: "none",
  });
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  await shared!.admin`
    insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id,
      temporal_workflow_id, status, position, prompt, model,
      reasoning_effort, sandbox_backend, execution_generation,
      initiator_kind, initiator_subject_id, initiating_human_subject_id, initiator_context
    ) values (
      ${turnId}, ${input.accountId}, ${input.workspaceId}, ${session.id},
      ${crypto.randomUUID()}, ${`learning-policy-${turnId}`}, 'running', 1,
      'learning policy fixture', 'test-model', 'high', 'none', 1,
      'subject', ${input.subjectId}, ${input.subjectId},
      ${shared!.admin.json({ source: "test" })}
    )`;
  await shared!.admin`
    insert into session_turn_attempts (
      id, account_id, workspace_id, session_id, turn_id, execution_generation,
      state, temporal_workflow_id, temporal_workflow_run_id,
      temporal_activity_id, verified_control_revision, mcp_approval_policies
    ) values (
      ${attemptId}, ${input.accountId}, ${input.workspaceId}, ${session.id},
      ${turnId}, 1, 'running', ${`learning-policy-${turnId}`},
      ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0, '{}'::jsonb
    )`;
  await shared!.admin`
    update session_turns set active_attempt_id = ${attemptId} where id = ${turnId}`;
  await shared!.admin`
    update sessions set active_turn_id = ${turnId}, status = 'running' where id = ${session.id}`;
  return { sessionId: session.id, turnId, attemptId, executionGeneration: 1 };
}

async function sqlState(operation: Promise<unknown>): Promise<string | null> {
  try {
    await operation;
    return null;
  } catch (error) {
    return nestedPostgresSqlState(error);
  }
}

async function waitForApplicationLock(applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [activity] = await shared!.admin<{ waitEventType: string | null }[]>`
      select wait_event_type as "waitEventType"
      from pg_stat_activity
      where application_name = ${applicationName}
        and state = 'active'`;
    if (activity?.waitEventType === "Lock") return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${applicationName} to block on the workspace lock`);
}

beforeAll(async () => {
  const source = await readFile(migrationUrl, "utf8");
  expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
  expect(source).not.toMatch(/ALTER TABLE "knowledge_memories"/i);

  const explicitAdminUrl = process.env.OPENGENI_WORKSPACE_LEARNING_POLICY_TEST_ADMIN_URL;
  const explicitAppUrl = process.env.OPENGENI_WORKSPACE_LEARNING_POLICY_TEST_APP_URL;
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
    shared = await acquireSharedTestDatabase("migration-0199-workspace-learning-policy");
  }
  if (!shared) {
    if (requireRealDatabase)
      throw new Error("real PostgreSQL is required for migration 0199 proof");
    available = false;
    console.warn("[migration-0199] PostgreSQL unavailable, skipping FORCE-RLS assertions");
    return;
  }
  client = createDb(shared.appUrl, { max: 8 });
  app = postgres(shared.appUrl, { max: 4, prepare: false });
  const [accountA] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('learning policy account A') returning id`;
  const [accountB] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('learning policy account B') returning id`;
  const [workspaceA] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountA!.id}, 'learning policy workspace A') returning id`;
  const [workspaceB] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountB!.id}, 'learning policy workspace B') returning id`;
  await shared.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceA!.id}, ${accountA!.id}), (${workspaceB!.id}, ${accountB!.id})`;
  fixture = {
    accountA: accountA!.id,
    workspaceA: workspaceA!.id,
    accountB: accountB!.id,
    workspaceB: workspaceB!.id,
  };
}, 180_000);

afterAll(async () => {
  await app?.end();
  await client?.close();
  await shared?.release();
}, 60_000);

describe("migration 0199 workspace learning policy", () => {
  test("enforces immutable versioning, lifecycle-only activation, RLS, CAS, rollback, and frozen effective modes", async () => {
    if (!available) return;
    const actor = "user:learning-admin";
    const common = {
      accountId: fixture.accountA,
      workspaceId: fixture.workspaceA,
      actorSubjectId: actor,
      principalKind: "human_session" as const,
    };

    const operationId = crypto.randomUUID();
    const first = await createWorkspaceLearningPolicyRevision(client.db, {
      ...common,
      operationId,
      workspaceMode: "automatic",
      sourceOverrides: [
        { kind: "slack-channel", id: "C02", mode: "inherit" },
        { kind: "slack-channel", id: "C01", mode: "off" },
      ],
    });
    expect(first.sourceOverrides).toEqual([{ kind: "slack-channel", id: "C01", mode: "off" }]);
    expect(
      await createWorkspaceLearningPolicyRevision(client.db, {
        ...common,
        operationId,
        workspaceMode: "automatic",
        sourceOverrides: [
          { kind: "slack-channel", id: "C02", mode: "inherit" },
          { kind: "slack-channel", id: "C01", mode: "off" },
        ],
      }),
    ).toEqual(first);

    expect(
      await sqlState(
        shared!.admin`
          insert into workspace_learning_policy_heads (
            account_id, workspace_id, revision_id, revision, policy_hash, activation_version
          ) values (
            ${fixture.accountA}, ${fixture.workspaceA}, ${first.id}, ${first.revision},
            ${first.policyHash}, 1
          )`,
      ),
    ).toBe("55000");

    const firstActivationOperationId = crypto.randomUUID();
    const firstActivationInput = {
      ...common,
      operationId: firstActivationOperationId,
      revisionId: first.id,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      reason: "Enable governed internal learning",
    };
    const firstActivation = await activateWorkspaceLearningPolicyRevision(
      client.db,
      firstActivationInput,
    );
    expect(firstActivation.head).toMatchObject({ revisionId: first.id, activationVersion: 1 });
    expect(await activateWorkspaceLearningPolicyRevision(client.db, firstActivationInput)).toEqual(
      firstActivation,
    );
    await expect(
      activateWorkspaceLearningPolicyRevision(client.db, {
        ...firstActivationInput,
        reason: "Reuse the operation for a different request",
      }),
    ).rejects.toBeInstanceOf(WorkspaceLearningPolicyOperationReuseError);

    const acceptedBeforeChange = await seedAttempt({
      accountId: fixture.accountA,
      workspaceId: fixture.workspaceA,
      subjectId: actor,
    });
    await Bun.sleep(10);

    const second = await createWorkspaceLearningPolicyRevision(client.db, {
      ...common,
      workspaceMode: "suggest",
      sourceOverrides: [{ kind: "google-drive", id: "folder:1", mode: "automatic" }],
      supersedesRevisionId: first.id,
    });
    const third = await createWorkspaceLearningPolicyRevision(client.db, {
      ...common,
      workspaceMode: "off",
      supersedesRevisionId: first.id,
    });

    const race = await Promise.allSettled([
      activateWorkspaceLearningPolicyRevision(client.db, {
        ...common,
        revisionId: second.id,
        expectedCurrentRevisionId: first.id,
        expectedActivationVersion: 1,
        reason: "Prefer review by default",
      }),
      activateWorkspaceLearningPolicyRevision(client.db, {
        ...common,
        revisionId: third.id,
        expectedCurrentRevisionId: first.id,
        expectedActivationVersion: 1,
        reason: "Pause derived learning",
      }),
    ]);
    expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (race.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ).toBeInstanceOf(WorkspaceLearningPolicyConflictError);

    const afterRace = await listWorkspaceLearningPolicyHistory(client.db, {
      accountId: fixture.accountA,
      workspaceId: fixture.workspaceA,
    });
    expect(afterRace.head?.activationVersion).toBe(2);
    const raceWinner = afterRace.head!;
    const neverActive = raceWinner.revisionId === second.id ? third : second;

    await expect(
      rollbackWorkspaceLearningPolicyRevision(client.db, {
        ...common,
        targetRevisionId: neverActive.id,
        expectedCurrentRevisionId: raceWinner.revisionId,
        expectedActivationVersion: raceWinner.activationVersion,
        reason: "Invalid rollback proof",
      }),
    ).rejects.toBeInstanceOf(WorkspaceLearningPolicyInvalidOperationError);

    const rolledBack = await rollbackWorkspaceLearningPolicyRevision(client.db, {
      ...common,
      targetRevisionId: first.id,
      expectedCurrentRevisionId: raceWinner.revisionId,
      expectedActivationVersion: raceWinner.activationVersion,
      reason: "Restore the previously active policy",
    });
    expect(rolledBack).toMatchObject({
      head: { revisionId: first.id, activationVersion: 3 },
      event: { type: "rollback", oldRevision: { id: raceWinner.revisionId } },
    });

    const frozen = await getOrCreateWorkspaceLearningPolicySnapshot(client.db, {
      accountId: fixture.accountA,
      workspaceId: fixture.workspaceA,
      ...acceptedBeforeChange,
    });
    expect(frozen).toMatchObject({
      revision: { id: first.id },
      activationVersion: 1,
      workspaceMode: "automatic",
    });
    expect(
      resolveWorkspaceLearningPolicyEffectiveMode(frozen, {
        kind: "slack-channel",
        id: "C01",
      }),
    ).toMatchObject({ mode: "off", inherited: false });
    expect(
      resolveWorkspaceLearningPolicyEffectiveMode(frozen, {
        kind: "meeting-transcript",
        id: "meeting:1",
      }),
    ).toMatchObject({ mode: "automatic", inherited: true });
    expect(
      await getOrCreateWorkspaceLearningPolicySnapshot(client.db, {
        accountId: fixture.accountA,
        workspaceId: fixture.workspaceA,
        ...acceptedBeforeChange,
      }),
    ).toEqual(frozen);

    expect(
      await sqlState(
        shared!.admin`
          update workspace_learning_policy_revisions
          set workspace_mode = 'off'
          where id = ${first.id}`,
      ),
    ).toBe("55000");
    expect(
      await sqlState(
        shared!.admin`
          update workspace_learning_policy_snapshots
          set workspace_mode = 'off'
          where id = ${frozen.id}`,
      ),
    ).toBe("55000");

    const rowsVisibleInA = await app.begin(async (sql) => {
      await sql`select set_config('opengeni.account_id', ${fixture.accountA}, true)`;
      await sql`select set_config('opengeni.workspace_id', ${fixture.workspaceA}, true)`;
      return await sql<{ count: number }[]>`
        select count(*)::int as count from workspace_learning_policy_revisions`;
    });
    const rowsVisibleInB = await app.begin(async (sql) => {
      await sql`select set_config('opengeni.account_id', ${fixture.accountB}, true)`;
      await sql`select set_config('opengeni.workspace_id', ${fixture.workspaceB}, true)`;
      return await sql<{ count: number }[]>`
        select count(*)::int as count from workspace_learning_policy_revisions`;
    });
    expect(rowsVisibleInA[0]?.count).toBe(3);
    expect(rowsVisibleInB[0]?.count).toBe(0);

    const noPolicyAttempt = await seedAttempt({
      accountId: fixture.accountB,
      workspaceId: fixture.workspaceB,
      subjectId: "user:workspace-b",
    });
    const defaultSnapshot = await getOrCreateWorkspaceLearningPolicySnapshot(client.db, {
      accountId: fixture.accountB,
      workspaceId: fixture.workspaceB,
      ...noPolicyAttempt,
    });
    expect(defaultSnapshot).toMatchObject({
      revision: null,
      activationVersion: 0,
      workspaceMode: "off",
      sourceOverrides: [],
    });
  }, 180_000);

  test("serializes operation ids and replays the original activation receipt", async () => {
    if (!available) return;
    const isolated = await seedPolicyFixture("operation namespace");
    const common = {
      ...isolated,
      actorSubjectId: "user:operation-admin",
      principalKind: "human_session" as const,
    };
    const first = await createWorkspaceLearningPolicyRevision(client.db, {
      ...common,
      workspaceMode: "off",
    });
    const second = await createWorkspaceLearningPolicyRevision(client.db, {
      ...common,
      workspaceMode: "suggest",
      supersedesRevisionId: first.id,
    });
    const firstActivationInput = {
      ...common,
      operationId: crypto.randomUUID(),
      revisionId: first.id,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      reason: "Activate the first revision",
    };
    const firstActivation = await activateWorkspaceLearningPolicyRevision(
      client.db,
      firstActivationInput,
    );
    await activateWorkspaceLearningPolicyRevision(client.db, {
      ...common,
      revisionId: second.id,
      expectedCurrentRevisionId: first.id,
      expectedActivationVersion: 1,
      reason: "Activate the second revision",
    });
    expect(await activateWorkspaceLearningPolicyRevision(client.db, firstActivationInput)).toEqual(
      firstActivation,
    );

    const identicalOperationId = crypto.randomUUID();
    const identicalInput = {
      ...common,
      operationId: identicalOperationId,
      workspaceMode: "automatic" as const,
      supersedesRevisionId: second.id,
    };
    const identical = await Promise.all([
      createWorkspaceLearningPolicyRevision(client.db, identicalInput),
      createWorkspaceLearningPolicyRevision(client.db, identicalInput),
    ]);
    expect(identical[1]).toEqual(identical[0]);
    const [identicalCount] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count
      from workspace_learning_policy_revisions
      where workspace_id = ${isolated.workspaceId}
        and operation_id = ${identicalOperationId}`;
    expect(identicalCount?.count).toBe(1);

    const crossOperationId = crypto.randomUUID();
    const third = identical[0]!;
    const crossRace = await Promise.allSettled([
      createWorkspaceLearningPolicyRevision(client.db, {
        ...common,
        operationId: crossOperationId,
        workspaceMode: "off",
        supersedesRevisionId: third.id,
      }),
      activateWorkspaceLearningPolicyRevision(client.db, {
        ...common,
        operationId: crossOperationId,
        revisionId: third.id,
        expectedCurrentRevisionId: second.id,
        expectedActivationVersion: 2,
        reason: "Race activation against revision creation",
      }),
    ]);
    expect(crossRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(crossRace.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (crossRace.find((result) => result.status === "rejected") as PromiseRejectedResult).reason,
    ).toBeInstanceOf(WorkspaceLearningPolicyOperationReuseError);
    const [crossCount] = await shared!.admin<{ count: number }[]>`
      select (
        select count(*) from workspace_learning_policy_revisions
        where workspace_id = ${isolated.workspaceId} and operation_id = ${crossOperationId}
      ) + (
        select count(*) from workspace_learning_policy_activation_events
        where workspace_id = ${isolated.workspaceId} and operation_id = ${crossOperationId}
      ) as count`;
    expect(Number(crossCount?.count)).toBe(1);
  }, 180_000);

  test("orders dependent CAS events by serialized acceptance time", async () => {
    if (!available) return;
    const isolated = await seedPolicyFixture("dependent CAS");
    const actorSubjectId = "user:dependent-cas-admin";
    const common = {
      ...isolated,
      actorSubjectId,
      principalKind: "human_session" as const,
    };
    const first = await createWorkspaceLearningPolicyRevision(client.db, {
      ...common,
      workspaceMode: "off",
    });
    const second = await createWorkspaceLearningPolicyRevision(client.db, {
      ...common,
      workspaceMode: "suggest",
      supersedesRevisionId: first.id,
    });
    const third = await createWorkspaceLearningPolicyRevision(client.db, {
      ...common,
      workspaceMode: "automatic",
      supersedesRevisionId: second.id,
    });
    await activateWorkspaceLearningPolicyRevision(client.db, {
      ...common,
      revisionId: first.id,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
      reason: "Establish the first dependent-CAS revision",
    });

    const owner = postgres(shared!.appUrl, { max: 1, prepare: false });
    const dependent = postgres(shared!.appUrl, { max: 1, prepare: false });
    const ownerOperationId = crypto.randomUUID();
    const dependentOperationId = crypto.randomUUID();
    const dependentApplicationName = `learning-policy-dependent-${dependentOperationId}`;
    let dependentCall: Promise<unknown> | undefined;
    try {
      await owner.begin(async (sql) => {
        await sql`select set_config('opengeni.account_id', ${isolated.accountId}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${isolated.workspaceId}, true)`;
        await sql`select set_config('opengeni.subject_id', ${actorSubjectId}, true)`;
        await sql`select set_config('opengeni.principal_kind', 'human_session', true)`;
        await sql`select id from workspaces where id = ${isolated.workspaceId} for update`;

        dependentCall = dependent.begin(async (dependentSql) => {
          await dependentSql`select set_config('application_name', ${dependentApplicationName}, false)`;
          await dependentSql`select set_config('opengeni.account_id', ${isolated.accountId}, true)`;
          await dependentSql`select set_config('opengeni.workspace_id', ${isolated.workspaceId}, true)`;
          await dependentSql`select set_config('opengeni.subject_id', ${actorSubjectId}, true)`;
          await dependentSql`select set_config('opengeni.principal_kind', 'human_session', true)`;
          return await dependentSql`
            select event_id
            from workspace_learning_policy_apply_activation(
              ${dependentOperationId}::uuid,
              ${"b".repeat(64)},
              ${isolated.accountId}::uuid,
              ${isolated.workspaceId}::uuid,
              ${third.id}::uuid,
              ${second.id}::uuid,
              2::bigint,
              'activate',
              ${actorSubjectId},
              'Apply the dependent revision after its predecessor'
            )`;
        });
        await waitForApplicationLock(dependentApplicationName);
        await sql`
          select event_id
          from workspace_learning_policy_apply_activation(
            ${ownerOperationId}::uuid,
            ${"a".repeat(64)},
            ${isolated.accountId}::uuid,
            ${isolated.workspaceId}::uuid,
            ${second.id}::uuid,
            ${first.id}::uuid,
            1::bigint,
            'activate',
            ${actorSubjectId},
            'Apply the predecessor while retaining the workspace lock'
          )`;
      });
      await dependentCall;
    } finally {
      await dependent.end();
      await owner.end();
    }

    const events = await shared!.admin<
      { operationId: string; activationVersion: number; createdAt: Date }[]
    >`
      select operation_id as "operationId", activation_version::int as "activationVersion",
        created_at as "createdAt"
      from workspace_learning_policy_activation_events
      where workspace_id = ${isolated.workspaceId}
        and operation_id in (${ownerOperationId}, ${dependentOperationId})
      order by activation_version`;
    expect(events.map((event) => event.activationVersion)).toEqual([2, 3]);
    expect(events[1]!.createdAt.getTime()).toBeGreaterThan(events[0]!.createdAt.getTime());

    const accepted = await seedAttempt({
      ...isolated,
      subjectId: actorSubjectId,
    });
    const snapshot = await getOrCreateWorkspaceLearningPolicySnapshot(client.db, {
      ...isolated,
      ...accepted,
    });
    expect(snapshot).toMatchObject({
      revision: { id: third.id },
      activationVersion: 3,
      workspaceMode: "automatic",
    });
  }, 180_000);

  test("permits snapshot cleanup through attempt, turn, and session lifecycle deletion", async () => {
    if (!available) return;
    const isolated = await seedPolicyFixture("snapshot cascade");
    const accepted = await seedAttempt({
      ...isolated,
      subjectId: "user:snapshot-cascade-admin",
    });
    const snapshot = await getOrCreateWorkspaceLearningPolicySnapshot(client.db, {
      ...isolated,
      ...accepted,
    });

    await shared!.admin`
      update sessions set active_turn_id = null where id = ${accepted.sessionId}`;
    await shared!.admin`
      update session_turns set active_attempt_id = null where id = ${accepted.turnId}`;
    await shared!.admin`
      delete from session_turn_attempts where id = ${accepted.attemptId}`;
    const [afterAttempt] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from workspace_learning_policy_snapshots
      where id = ${snapshot.id}`;
    expect(afterAttempt?.count).toBe(0);

    await shared!.admin`delete from session_turns where id = ${accepted.turnId}`;
    const [afterTurn] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from session_turns where id = ${accepted.turnId}`;
    expect(afterTurn?.count).toBe(0);

    await shared!.admin`delete from sessions where id = ${accepted.sessionId}`;
    const [afterSession] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from sessions where id = ${accepted.sessionId}`;
    expect(afterSession?.count).toBe(0);
  }, 180_000);
});
