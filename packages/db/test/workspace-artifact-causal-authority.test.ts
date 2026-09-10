import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createWorkspaceArtifact,
  grantWorkspaceAccess,
  initializeSessionStartAtomically,
  materializeGoalContinuation,
  publishWorkspaceArtifactVersion,
  removeWorkspaceMember,
  rollbackWorkspaceArtifact,
  setWorkspaceArtifactStatus,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

const externalAdminUrl = process.env.OPENGENI_ARTIFACT_AUTHORITY_POSTGRES_ADMIN_URL?.trim();
const externalAppUrl = process.env.OPENGENI_ARTIFACT_AUTHORITY_POSTGRES_APP_URL?.trim();

type Grant = Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];
type Attempt = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};

let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  if (Boolean(externalAdminUrl) !== Boolean(externalAppUrl)) {
    throw new Error(
      "OPENGENI_ARTIFACT_AUTHORITY_POSTGRES_ADMIN_URL and OPENGENI_ARTIFACT_AUTHORITY_POSTGRES_APP_URL must be set together",
    );
  }
  if (externalAdminUrl && externalAppUrl) {
    admin = postgres(externalAdminUrl, { max: 4 });
    client = createDb(externalAppUrl, { max: 4 });
    return;
  }
  shared = await acquireSharedTestDatabase("workspace-artifact-causal-authority");
  if (!shared) throw new Error("PostgreSQL test database unavailable");
  admin = shared.admin;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  if (shared) await shared.release();
  else await admin?.end();
}, 60_000);

async function freshGrant(label: string): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "artifact-authority-test",
    accountExternalId: `${label}-account-${suffix}`,
    accountName: `${label} account`,
    workspaceExternalSource: "artifact-authority-test",
    workspaceExternalId: `${label}-workspace-${suffix}`,
    workspaceName: `${label} workspace`,
    subjectId: `user:${label}-${suffix}`,
  });
  return access.workspaceGrants[0]!;
}

const artifactTools = [
  "artifacts_create",
  "artifacts_publish",
  "artifacts_rollback",
  "artifacts_archive",
  "artifacts_restore",
] as const;

async function seedAttempt(
  grant: Grant,
  options: {
    initiatorKind?: "subject" | "service";
    initiatorSubjectId?: string;
    initiatingHumanSubjectId?: string | null;
    tools?: string[];
    permissions?: string[] | null;
  } = {},
): Promise<Attempt> {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Artifact authority test",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    firstPartyMcpTools: (options.tools ?? [...artifactTools]) as never,
    firstPartyMcpPermissions: (options.permissions ?? ["artifacts:publish"]) as never,
  });
  const executionGeneration = 3;
  const [turn] = await admin<{ id: string }[]>`
    insert into session_turns (
      account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend,
      execution_generation, initiator_kind, initiator_subject_id, initiator_context,
      initiating_human_subject_id
    ) values (
      ${grant.accountId}, ${grant.workspaceId}, ${session.id}, gen_random_uuid(),
      ${`artifact-authority-${crypto.randomUUID()}`}, 'running', 0, 'Publish artifact',
      'scripted-model', 'medium', 'none', ${executionGeneration},
      ${options.initiatorKind ?? "subject"},
      ${options.initiatorSubjectId ?? grant.subjectId},
      '{"accepted":true}'::jsonb, ${options.initiatingHumanSubjectId ?? null}
    ) returning id`;
  const attemptId = crypto.randomUUID();
  await admin.begin(async (tx) => {
    await tx`update sessions set active_turn_id = ${turn!.id} where id = ${session.id}`;
    await tx`update session_turns set active_attempt_id = ${attemptId} where id = ${turn!.id}`;
    await tx`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, mcp_approval_policies
      ) values (
        ${attemptId}, ${grant.accountId}, ${grant.workspaceId}, ${session.id}, ${turn!.id},
        ${executionGeneration}, 'running', 'artifact-authority', ${`run-${attemptId}`},
        ${`activity-${attemptId}`}, 0, '{}'::jsonb
      )`;
  });
  return { sessionId: session.id, turnId: turn!.id, attemptId, executionGeneration };
}

async function canonicalHumanAttempt(grant: Grant): Promise<Attempt> {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Start artifact work",
    resources: [],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    firstPartyMcpTools: [...artifactTools],
    firstPartyMcpPermissions: ["artifacts:publish"],
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("human turn was not claimed");
  return {
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
}

async function canonicalGoalContinuation(grant: Grant): Promise<Attempt> {
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "Start the artifact goal",
    resources: [],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    firstPartyMcpTools: [...artifactTools],
    firstPartyMcpPermissions: ["artifacts:publish"],
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    clientEventId: `initial:${session.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: { text: "Publish the artifact", mutationPolicy: "preserve_intent" },
  });
  const initialAttemptId = crypto.randomUUID();
  const initial = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: initialAttemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (initial.action !== "claimed") throw new Error("initial goal turn was not claimed");
  const settled = await applySessionTurnSettlement(client.db, grant.workspaceId, {
    sessionId: session.id,
    turnId: initial.turn.id,
    triggerEventId: initial.turn.triggerEventId,
    attemptId: initialAttemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  if (settled.action !== "settled") throw new Error("human turn did not settle");
  const materialized = await materializeGoalContinuation(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    defaultMaxAutoContinuations: null,
    budgetBlocked: null,
    policy: {
      model: "scripted-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      tools: [],
      sandboxBackend: "none",
    },
    prompt: (goal, count) => `continue ${goal.text} (${count})`,
  });
  if (materialized.action !== "continue") throw new Error("goal continuation was not materialized");
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("goal continuation was not claimed");
  expect(claimed.turn.initiator).toMatchObject({
    kind: "service",
    subjectId: "goal-continuation",
  });
  expect(claimed.turn.initiatingHumanSubjectId).toBe(grant.subjectId);
  return {
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
}

async function canonicalChildAttempt(grant: Grant): Promise<Attempt> {
  const parent = await canonicalHumanAttempt(grant);
  const child = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    parentSessionId: parent.sessionId,
    createdByActor: {
      type: "agent_attempt",
      sessionId: parent.sessionId,
      turnId: parent.turnId,
      attemptId: parent.attemptId,
      executionGeneration: parent.executionGeneration,
    },
    initialMessage: "Child artifact work",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    firstPartyMcpTools: ["artifacts_create"],
    firstPartyMcpPermissions: ["artifacts:publish"],
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: child.id,
    clientEventId: `initial:${child.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
    sessionId: child.id,
    workflowId: `session-${child.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("child turn was not claimed");
  expect(claimed.turn.initiator).toMatchObject({ kind: "subject", subjectId: grant.subjectId });
  expect(claimed.turn.initiatingHumanSubjectId).toBe(grant.subjectId);
  return {
    sessionId: child.id,
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
}

function provenance(attempt: Attempt, sourceToolName: (typeof artifactTools)[number]) {
  return {
    sourceSessionId: attempt.sessionId,
    sourceTurnId: attempt.turnId,
    sourceAttemptId: attempt.attemptId,
    sourceExecutionGeneration: attempt.executionGeneration,
    sourceToolName,
  };
}

async function mutateCreate(
  grant: Grant,
  attempt: Attempt,
  overrides: Partial<Attempt> & { workspaceId?: string; accountId?: string } = {},
) {
  let persisted = 0;
  try {
    const result = await createWorkspaceArtifact(client.db, {
      accountId: overrides.accountId ?? grant.accountId,
      workspaceId: overrides.workspaceId ?? grant.workspaceId,
      artifactId: crypto.randomUUID(),
      slug: `authority-${crypto.randomUUID().slice(0, 8)}`,
      title: "Authority test",
      description: null,
      contentKey: `authority/${crypto.randomUUID()}.html`,
      contentSha256: "a".repeat(64),
      sizeBytes: 16,
      sourceKey: null,
      sourceSha256: null,
      sourceSizeBytes: null,
      requestedTools: [],
      operationKey: crypto.randomUUID(),
      actorSubjectId: "worker:first-party-mcp",
      sourceSessionId: overrides.sessionId ?? attempt.sessionId,
      sourceTurnId: overrides.turnId ?? attempt.turnId,
      sourceAttemptId: overrides.attemptId ?? attempt.attemptId,
      sourceExecutionGeneration: overrides.executionGeneration ?? attempt.executionGeneration,
      sourceToolName: "artifacts_create",
      persistContent: async () => {
        persisted += 1;
      },
      discardContent: async () => undefined,
    });
    return { ok: true as const, persisted, result };
  } catch (error) {
    return { ok: false as const, persisted, error };
  }
}

describe("workspace artifact causal authority under FORCE RLS", () => {
  test("runs as the non-owner application role with FORCE RLS enabled", async () => {
    const rows = (await client.db.execute(sql`
      select current_user as "currentUser",
        current_setting('row_security') as "rowSecurity",
        role.rolsuper as "superuser",
        role.rolbypassrls as "bypassRls"
      from pg_roles role where role.rolname = current_user
    `)) as unknown as Array<{
      currentUser: string;
      rowSecurity: string;
      superuser: boolean;
      bypassRls: boolean;
    }>;
    expect(rows[0]).toEqual({
      currentUser: "opengeni_app",
      rowSecurity: "on",
      superuser: false,
      bypassRls: false,
    });
    const tables = await admin<
      Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      where relname in ('workspace_artifacts', 'session_turns', 'session_turn_attempts')
      order by relname`;
    expect(
      tables.map(({ relname, relrowsecurity, relforcerowsecurity }) => ({
        relname,
        relrowsecurity,
        relforcerowsecurity,
      })),
    ).toEqual([
      { relname: "session_turn_attempts", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "session_turns", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "workspace_artifacts", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });

  test("accepts every artifact mutation from a canonical goal continuation", async () => {
    const grant = await freshGrant("goal-continuation");
    const attempt = await canonicalGoalContinuation(grant);
    const created = await mutateCreate(grant, attempt);
    expect(created).toMatchObject({ ok: true, persisted: 1 });
    if (!created.ok) throw created.error;

    let publishedContent = 0;
    const published = await publishWorkspaceArtifactVersion(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      artifactId: created.result.artifact.id,
      expectedCurrentVersionId: created.result.version.id,
      contentKey: `authority/${crypto.randomUUID()}.html`,
      contentSha256: "b".repeat(64),
      sizeBytes: 32,
      sourceKey: null,
      sourceSha256: null,
      sourceSizeBytes: null,
      requestedTools: [],
      operationKey: crypto.randomUUID(),
      actorSubjectId: "worker:first-party-mcp",
      ...provenance(attempt, "artifacts_publish"),
      persistContent: async () => {
        publishedContent += 1;
      },
      discardContent: async () => undefined,
    });
    expect(publishedContent).toBe(1);

    const rolledBack = await rollbackWorkspaceArtifact(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      artifactId: created.result.artifact.id,
      versionId: created.result.version.id,
      expectedCurrentVersionId: published.version.id,
      reason: "Verify causal rollback",
      operationKey: crypto.randomUUID(),
      actorSubjectId: "worker:first-party-mcp",
      ...provenance(attempt, "artifacts_rollback"),
    });
    expect(rolledBack.artifact.currentVersion?.id).toBe(created.result.version.id);

    const archived = await setWorkspaceArtifactStatus(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      artifactId: created.result.artifact.id,
      status: "archived",
      expectedCurrentVersionId: created.result.version.id,
      reason: "Verify causal archive",
      operationKey: crypto.randomUUID(),
      actorSubjectId: "worker:first-party-mcp",
      ...provenance(attempt, "artifacts_archive"),
    });
    expect(archived.artifact.status).toBe("archived");

    const restored = await setWorkspaceArtifactStatus(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      artifactId: created.result.artifact.id,
      status: "active",
      expectedCurrentVersionId: created.result.version.id,
      reason: "Verify causal restore",
      operationKey: crypto.randomUUID(),
      actorSubjectId: "worker:first-party-mcp",
      ...provenance(attempt, "artifacts_restore"),
    });
    expect(restored.artifact.status).toBe("active");
    expect(restored.event.sourceAttemptId).toBe(attempt.attemptId);
  }, 60_000);

  test("accepts a canonical child attributed through its exact parent attempt", async () => {
    const grant = await freshGrant("child-attribution");
    const child = await canonicalChildAttempt(grant);
    expect(await mutateCreate(grant, child)).toMatchObject({ ok: true, persisted: 1 });
  }, 60_000);

  test("rejects pure service and cross-workspace provenance with no content persistence", async () => {
    const grant = await freshGrant("pure-service");
    const pureService = await seedAttempt(grant, {
      initiatorKind: "service",
      initiatorSubjectId: "background-maintenance",
      initiatingHumanSubjectId: null,
    });
    expect(await mutateCreate(grant, pureService)).toMatchObject({ ok: false, persisted: 0 });

    const targetGrant = await freshGrant("cross-workspace");
    const causalService = await seedAttempt(grant, {
      initiatorKind: "service",
      initiatorSubjectId: "goal-continuation",
      initiatingHumanSubjectId: grant.subjectId,
    });
    expect(
      await mutateCreate(targetGrant, causalService, {
        accountId: targetGrant.accountId,
        workspaceId: targetGrant.workspaceId,
      }),
    ).toMatchObject({ ok: false, persisted: 0 });
  });

  test("rejects stale generation, cancellation, and interruption fences", async () => {
    const grant = await freshGrant("attempt-fences");
    const staleGeneration = await seedAttempt(grant, {
      initiatorKind: "service",
      initiatorSubjectId: "goal-continuation",
      initiatingHumanSubjectId: grant.subjectId,
    });
    expect(
      await mutateCreate(grant, staleGeneration, {
        executionGeneration: staleGeneration.executionGeneration + 1,
      }),
    ).toMatchObject({ ok: false, persisted: 0 });

    const cancelled = await seedAttempt(grant, {
      initiatorKind: "service",
      initiatorSubjectId: "goal-continuation",
      initiatingHumanSubjectId: grant.subjectId,
    });
    await admin`
      update session_turns
      set status = 'cancelled', active_attempt_id = null, finished_at = now(), updated_at = now()
      where id = ${cancelled.turnId}`;
    expect(await mutateCreate(grant, cancelled)).toMatchObject({ ok: false, persisted: 0 });

    const interrupted = await seedAttempt(grant, {
      initiatorKind: "service",
      initiatorSubjectId: "goal-continuation",
      initiatingHumanSubjectId: grant.subjectId,
    });
    const [receipt] = await admin<{ id: string }[]>`
      insert into session_command_receipts (
        account_id, workspace_id, actor_type, actor_subject_id, action,
        target_session_id, target_turn_id, operation_key, canonical_request_hash
      ) values (
        ${grant.accountId}, ${grant.workspaceId}, 'human', ${grant.subjectId},
        'session.queue.steer', ${interrupted.sessionId}, ${interrupted.turnId},
        ${crypto.randomUUID()}, 'artifact-authority-interruption'
      ) returning id`;
    await admin`
      insert into session_attempt_interruptions (
        account_id, workspace_id, session_id, operation_id, attempt_id,
        kind, control_revision
      ) values (
        ${grant.accountId}, ${grant.workspaceId}, ${interrupted.sessionId},
        ${receipt!.id}, ${interrupted.attemptId}, 'steer', 1
      )`;
    expect(await mutateCreate(grant, interrupted)).toMatchObject({ ok: false, persisted: 0 });
  });

  test("membership removal immediately fences the causal human", async () => {
    const grant = await freshGrant("membership-removal");
    const actorSubjectId = `user:removal-admin-${crypto.randomUUID()}`;
    await grantWorkspaceAccess(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: actorSubjectId,
      permissions: ["workspace:admin"],
    });
    const attempt = await seedAttempt(grant, {
      initiatorKind: "service",
      initiatorSubjectId: "goal-continuation",
      initiatingHumanSubjectId: grant.subjectId,
    });
    expect(
      await removeWorkspaceMember(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        actorSubjectId,
        targetSubjectId: grant.subjectId,
      }),
    ).toBe(true);
    const [after] = await admin<
      Array<{ membership: number; turnStatus: string; interruptionCount: number }>
    >`
      select
        (select count(*)::int from workspace_memberships
          where workspace_id = ${grant.workspaceId}
            and subject_id = ${grant.subjectId}) as membership,
        (select status from session_turns where id = ${attempt.turnId}) as "turnStatus",
        (select count(*)::int from session_attempt_interruptions
          where attempt_id = ${attempt.attemptId}
            and kind = 'authority_change') as "interruptionCount"`;
    expect(after).toEqual({ membership: 0, turnStatus: "running", interruptionCount: 1 });
    expect(await mutateCreate(grant, attempt)).toMatchObject({ ok: false, persisted: 0 });
  }, 60_000);

  test("rejects missing selected tools and publish permission", async () => {
    const grant = await freshGrant("tool-permission");
    const noTool = await seedAttempt(grant, {
      initiatorKind: "service",
      initiatorSubjectId: "goal-continuation",
      initiatingHumanSubjectId: grant.subjectId,
      tools: [],
    });
    expect(await mutateCreate(grant, noTool)).toMatchObject({ ok: false, persisted: 0 });

    const noPermission = await seedAttempt(grant, {
      initiatorKind: "service",
      initiatorSubjectId: "goal-continuation",
      initiatingHumanSubjectId: grant.subjectId,
      permissions: [],
    });
    expect(await mutateCreate(grant, noPermission)).toMatchObject({ ok: false, persisted: 0 });
  });
});
