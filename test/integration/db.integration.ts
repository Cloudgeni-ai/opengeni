import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as dbSchema from "../../packages/db/src/schema";
import {
  addSessionSystemUpdate,
  appendSessionEvents,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createWorkspace,
  createDb,
  decryptEnvironmentValue,
  getSessionHistoryItems,
  createScheduledTask,
  createScheduledTaskRun,
  getNestedAgentDepthDeploymentPolicy,
  markScheduledTaskRunFailedIfQueued,
  createApiKey,
  createSession,
  createSessionGoal,
  createSessionWithIdempotencyKey,
  encryptEnvironmentValue,
  getSessionByCreateIdempotencyKey,
  dbSql,
  enableCapabilityInstallation,
  ensureManagedAccessForUser,
  evaluateGoalContinuation,
  findActiveApiKeyByHash,
  grantWorkspaceAccess,
  getSession,
  getSessionGoal,
  setSessionGoalStatus,
  updateSessionGoal,
  upsertSessionGoal,
  listEnabledMcpCapabilityServers,
  listSessionMcpServerMetadata,
  listSessionMcpServersForRun,
  listScheduledTaskRuns,
  listScheduledTasks,
  listSessionEvents,
  listSessionsForSubject,
  updateScheduledTask,
  updateSessionMcpServerCredentials,
  requireScheduledTaskTargetInTransaction,
  ScheduledTaskTargetConflictError,
  withWorkspaceRls,
  withRlsContext,
  upsertCapabilityCatalogItem,
} from "@opengeni/db";
import { submitTestHumanPrompt } from "./helpers/session-control";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  type AccessGrant,
  type Permission,
} from "@opengeni/contracts";
import {
  applyRawSql,
  expectContiguousSequences,
  startTestServices,
  type TestServices,
} from "@opengeni/testing";

describe("DB integration", () => {
  let services: TestServices;
  let dbClient: ReturnType<typeof createDb>;

  beforeAll(async () => {
    services = await startTestServices({ temporal: false });
    await services.migrate();
    dbClient = createDb(services.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await dbClient?.close();
    await services?.down();
  }, 60_000);

  test("repeated access bootstrap is read-only once identity state is current", async () => {
    const suffix = crypto.randomUUID();
    const input = {
      accountExternalSource: "test:stable-bootstrap",
      accountExternalId: `account:${suffix}`,
      accountName: "Stable bootstrap account",
      workspaceExternalSource: "test:stable-bootstrap",
      workspaceExternalId: `workspace:${suffix}`,
      workspaceName: "Stable bootstrap workspace",
      subjectId: `configured:${suffix}`,
      subjectLabel: "Stable configured principal",
    };
    const context = await bootstrapWorkspace(dbClient.db, input);
    const grant = context.workspaceGrants[0]!;
    const readUpdatedAt = async () =>
      await withRlsContext(
        dbClient.db,
        { accountId: grant.accountId, workspaceId: grant.workspaceId },
        async (scopedDb) => {
          const [row] = await scopedDb.execute<{
            account: Date;
            workspace: Date;
            membership: Date;
          }>(dbSql`
						select account.updated_at as account,
						       workspace.updated_at as workspace,
						       membership.updated_at as membership
						from workspace_memberships membership
						join workspaces workspace on workspace.id = membership.workspace_id
						join managed_accounts account on account.id = membership.account_id
						where membership.workspace_id = ${grant.workspaceId}
						  and membership.subject_id = ${input.subjectId}
						limit 1
					`);
          if (!row) throw new Error("stable bootstrap fixture was not created");
          return row;
        },
      );

    const before = await readUpdatedAt();
    await Bun.sleep(5);
    const repeated = await Promise.all(
      Array.from({ length: 24 }, async () => await bootstrapWorkspace(dbClient.db, input)),
    );
    expect(repeated.every((candidate) => candidate.defaultWorkspaceId === grant.workspaceId)).toBe(
      true,
    );
    expect(await readUpdatedAt()).toEqual(before);
  }, 60_000);

  test("access bootstrap retains additional workspace grants", async () => {
    const suffix = crypto.randomUUID();
    const input = {
      accountExternalSource: "test:multi-workspace-bootstrap",
      accountExternalId: `account:${suffix}`,
      accountName: "Multi-workspace account",
      workspaceExternalSource: "test:multi-workspace-bootstrap",
      workspaceExternalId: `workspace:${suffix}`,
      workspaceName: "Default workspace",
      subjectId: `configured:${suffix}`,
      subjectLabel: "Workspace owner",
    };
    const initial = await bootstrapWorkspace(dbClient.db, input);
    const defaultGrant = initial.workspaceGrants[0]!;
    const additionalWorkspace = await createWorkspace(dbClient.db, {
      accountId: defaultGrant.accountId,
      name: "Additional workspace",
    });
    await grantWorkspaceAccess(dbClient.db, {
      accountId: defaultGrant.accountId,
      workspaceId: additionalWorkspace.id,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel,
      role: "owner",
      permissions: defaultGrant.permissions,
    });

    const refreshed = await bootstrapWorkspace(dbClient.db, input);

    expect(refreshed.defaultWorkspaceId).toBe(defaultGrant.workspaceId);
    expect(refreshed.workspaceGrants.map((grant) => grant.workspaceId).sort()).toEqual(
      [defaultGrant.workspaceId, additionalWorkspace.id].sort(),
    );
  });

  test("migrates, creates sessions, and replays ordered events", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "inspect this",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const events = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      { type: "session.created" },
      {
        type: "user.message",
        payload: { text: "inspect this" },
        clientEventId: "client-1",
      },
      { type: "session.status.changed", payload: { status: "queued" } },
    ]);
    expectContiguousSequences(events);
    expect(await listSessionEvents(dbClient.db, grant.workspaceId, session.id)).toHaveLength(3);
    expect(await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 1)).toHaveLength(2);
  });

  test("keeps repeated access bootstrap read-only and conflict-free with session listing", async () => {
    const suffix = crypto.randomUUID();
    const subjectId = `user:bootstrap-${suffix}`;
    const input = {
      accountExternalSource: "test:bootstrap-idempotency",
      accountExternalId: `account:${suffix}`,
      accountName: "Stable account",
      workspaceExternalSource: "test:bootstrap-idempotency",
      workspaceExternalId: `workspace:${suffix}`,
      workspaceName: "Stable workspace",
      subjectId,
      subjectLabel: "Stable owner",
    };
    const first = await bootstrapWorkspace(dbClient.db, input);
    const grant = first.workspaceGrants[0]!;
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Bootstrap contention regression",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const sentinel = new Date("2001-02-03T04:05:06.000Z");
    const sentinelIso = sentinel.toISOString();
    await dbClient.db.execute(
      dbSql`update managed_accounts set updated_at = ${sentinelIso}::timestamptz where id = ${grant.accountId}`,
    );
    await dbClient.db.execute(
      dbSql`update workspaces set updated_at = ${sentinelIso}::timestamptz where id = ${grant.workspaceId}`,
    );
    await dbClient.db.execute(dbSql`
      update workspace_memberships set updated_at = ${sentinelIso}::timestamptz
      where workspace_id = ${grant.workspaceId} and subject_id = ${subjectId}
    `);

    // Model the real browser workload: access resolution and session-list
    // polling overlap. An idempotent bootstrap must neither create new row
    // versions nor abort repeatable-read membership locks with SQLSTATE 40001.
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        index % 2 === 0
          ? bootstrapWorkspace(dbClient.db, input)
          : listSessionsForSubject(dbClient.db, grant.workspaceId, {
              subjectId,
              limit: 20,
            }),
      ),
    );

    const [row] = await dbClient.db.execute<{
      account_unchanged: boolean;
      workspace_unchanged: boolean;
      membership_unchanged: boolean;
      account_count: number;
      workspace_count: number;
      membership_count: number;
    }>(dbSql`
      select
        max(a.updated_at) = ${sentinelIso}::timestamptz as account_unchanged,
        max(w.updated_at) = ${sentinelIso}::timestamptz as workspace_unchanged,
        max(m.updated_at) = ${sentinelIso}::timestamptz as membership_unchanged,
        count(distinct a.id)::int as account_count,
        count(distinct w.id)::int as workspace_count,
        count(distinct m.id)::int as membership_count
      from managed_accounts a
      join workspaces w on w.account_id = a.id
      join workspace_memberships m on m.workspace_id = w.id
      where a.id = ${grant.accountId}
        and w.id = ${grant.workspaceId}
        and m.subject_id = ${subjectId}
    `);
    expect(row).toMatchObject({
      account_unchanged: true,
      workspace_unchanged: true,
      membership_unchanged: true,
      account_count: 1,
      workspace_count: 1,
      membership_count: 1,
    });
    expect(
      (await listSessionsForSubject(dbClient.db, grant.workspaceId, { subjectId, limit: 20 }))
        .sessions[0]?.id,
    ).toBe(session.id);
  });

  test("keeps repeated managed-user access read-only and conflict-free with session listing", async () => {
    const suffix = crypto.randomUUID();
    const user = {
      userId: `managed-bootstrap-${suffix}`,
      email: `managed-${suffix}@example.test`,
      name: "Stable managed user",
    };
    const first = await ensureManagedAccessForUser(dbClient.db, user);
    const grant = first.workspaceGrants[0]!;
    const subjectId = `user:${user.userId}`;
    const sentinelIso = "2002-03-04T05:06:07.000Z";
    await dbClient.db.execute(
      dbSql`update managed_accounts set updated_at = ${sentinelIso}::timestamptz where id = ${grant.accountId}`,
    );
    await dbClient.db.execute(
      dbSql`update workspaces set updated_at = ${sentinelIso}::timestamptz where id = ${grant.workspaceId}`,
    );
    await dbClient.db.execute(dbSql`
      update workspace_memberships set updated_at = ${sentinelIso}::timestamptz
      where workspace_id = ${grant.workspaceId} and subject_id = ${subjectId}
    `);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        index % 2 === 0
          ? ensureManagedAccessForUser(dbClient.db, user)
          : listSessionsForSubject(dbClient.db, grant.workspaceId, {
              subjectId,
              limit: 20,
            }),
      ),
    );

    const [row] = await dbClient.db.execute<{
      account_unchanged: boolean;
      workspace_unchanged: boolean;
      membership_unchanged: boolean;
    }>(dbSql`
      select
        a.updated_at = ${sentinelIso}::timestamptz as account_unchanged,
        w.updated_at = ${sentinelIso}::timestamptz as workspace_unchanged,
        m.updated_at = ${sentinelIso}::timestamptz as membership_unchanged
      from managed_accounts a
      join workspaces w on w.account_id = a.id
      join workspace_memberships m on m.workspace_id = w.id
      where a.id = ${grant.accountId}
        and w.id = ${grant.workspaceId}
        and m.subject_id = ${subjectId}
    `);
    expect(row).toEqual({
      account_unchanged: true,
      workspace_unchanged: true,
      membership_unchanged: true,
    });
  });

  test("stores per-session MCP credentials encrypted and bumps credential version on rotation", async () => {
    const grant = await testGrant(dbClient.db);
    const encryptionKey = new Uint8Array(32);
    encryptionKey.fill(7);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "session mcp",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      mcpServers: [
        {
          id: "crm",
          name: "CRM MCP",
          url: "https://crm.example/mcp",
          allowedTools: ["workouts.list"],
          timeoutMs: 2500,
          cacheToolsList: true,
          headersEncrypted: {
            Authorization: encryptEnvironmentValue(encryptionKey, "Bearer create-secret"),
          },
        },
      ],
    });

    expect(session.mcpServers).toEqual([
      {
        id: "crm",
        name: "CRM MCP",
        url: "https://crm.example/mcp",
        headerNames: ["Authorization"],
        credentialVersion: 1,
        requireApproval: false,
        connectionRef: null,
      },
    ]);
    expect(await listSessionMcpServerMetadata(dbClient.db, grant.workspaceId, session.id)).toEqual(
      session.mcpServers,
    );

    const rawRows = await dbClient.db.execute(
      dbSql<{
        headers_encrypted: Record<string, string>;
        credential_version: number;
      }>`select headers_encrypted, credential_version from session_mcp_servers where session_id = ${session.id}`,
    );
    const raw = rawRows[0]!;
    expect(JSON.stringify(raw.headers_encrypted)).not.toContain("create-secret");
    expect(decryptEnvironmentValue(encryptionKey, raw.headers_encrypted.Authorization!)).toBe(
      "Bearer create-secret",
    );
    expect(Number(raw.credential_version)).toBe(1);

    await submitTestHumanPrompt(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      text: "run the session MCP",
      resources: [],
      tools: [{ kind: "mcp", id: "crm" }],
      reasoningEffortFallback: "medium",
    });
    const execution = await claimRegisteredExecution(dbClient.db, grant, session.id);
    const forRun = await listSessionMcpServersForRun(
      dbClient.db,
      grant.workspaceId,
      session.id,
      execution.attemptId,
      encryptionKey,
    );
    expect(forRun).toEqual([
      {
        id: "crm",
        name: "CRM MCP",
        url: "https://crm.example/mcp",
        allowedTools: ["workouts.list"],
        timeoutMs: 2500,
        cacheToolsList: true,
        headerNames: ["Authorization"],
        headers: { Authorization: "Bearer create-secret" },
        credentialVersion: 1,
        requireApproval: false,
        connectionRef: null,
      },
    ]);

    const rotated = await updateSessionMcpServerCredentials(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      updates: [
        {
          id: "crm",
          headersEncrypted: {
            Authorization: encryptEnvironmentValue(encryptionKey, "Bearer rotated-secret"),
            "X-Session": encryptEnvironmentValue(encryptionKey, "turn-2"),
          },
        },
      ],
    });
    expect(rotated.missingIds).toEqual([]);
    expect(rotated.servers).toEqual([
      {
        id: "crm",
        name: "CRM MCP",
        url: "https://crm.example/mcp",
        headerNames: ["Authorization", "X-Session"],
        credentialVersion: 2,
        requireApproval: false,
        connectionRef: null,
      },
    ]);

    const afterRotation = await listSessionMcpServersForRun(
      dbClient.db,
      grant.workspaceId,
      session.id,
      execution.attemptId,
      encryptionKey,
    );
    expect(afterRotation[0]?.headers).toEqual({
      Authorization: "Bearer rotated-secret",
      "X-Session": "turn-2",
    });
    expect(afterRotation[0]?.credentialVersion).toBe(2);
    const rawAfterRows = await dbClient.db.execute(
      dbSql<{
        headers_encrypted: Record<string, string>;
      }>`select headers_encrypted from session_mcp_servers where session_id = ${session.id}`,
    );
    expect(JSON.stringify(rawAfterRows[0]!.headers_encrypted)).not.toContain("rotated-secret");
  });

  test("serializes concurrent event appends into contiguous sequence numbers", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "concurrency",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
          {
            type: "agent.message.delta",
            payload: { text: String(index) },
            producerId: "producer",
            producerSeq: index,
          },
        ]),
      ),
    );
    const events = await listSessionEvents(dbClient.db, grant.workspaceId, session.id, 0, 20);
    expect(events).toHaveLength(10);
    expectContiguousSequences(events);
  });

  test("enforces client and producer idempotency constraints", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "dedupe",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      {
        type: "user.message",
        payload: { text: "one" },
        clientEventId: "same-client",
      },
      {
        type: "agent.message.delta",
        payload: { text: "a" },
        producerId: "p",
        producerSeq: 1,
      },
    ]);
    await expect(
      appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
        {
          type: "user.message",
          payload: { text: "two" },
          clientEventId: "same-client",
        },
      ]),
    ).rejects.toThrow();
    await expect(
      appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
        {
          type: "agent.message.delta",
          payload: { text: "b" },
          producerId: "p",
          producerSeq: 1,
        },
      ]),
    ).rejects.toThrow();
  });

  test("workspace-scoped create idempotency key collapses sequential and concurrent races to one session", async () => {
    const grant = await testGrant(dbClient.db);
    const otherGrant = await testGrant(dbClient.db);
    const countSessions = async (workspaceId: string, key: string): Promise<number> => {
      const rows = await dbClient.db.execute(
        dbSql<{
          n: number;
        }>`select count(*)::int as n from sessions where workspace_id = ${workspaceId} and create_idempotency_key = ${key}`,
      );
      return Number(rows[0]?.n ?? 0);
    };
    const baseInput = (key: string) => ({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "idempotent create",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
      createIdempotencyKey: key,
    });

    // 1. Sequential: same key twice -> one row, second is a dup of the first.
    const seqKey = `seq-${crypto.randomUUID()}`;
    const first = await createSessionWithIdempotencyKey(dbClient.db, baseInput(seqKey));
    const second = await createSessionWithIdempotencyKey(dbClient.db, baseInput(seqKey));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
    expect(await countSessions(grant.workspaceId, seqKey)).toBe(1);
    // The lookup helper resolves the same row by key.
    expect(
      (await getSessionByCreateIdempotencyKey(dbClient.db, grant.workspaceId, seqKey))?.id,
    ).toBe(first.session.id);

    // 2. Concurrent: N near-simultaneous creates with the same key race the
    //    partial unique index; exactly one wins (created=true), the rest catch
    //    the unique violation and return the winner's row.
    const raceKey = `race-${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        createSessionWithIdempotencyKey(dbClient.db, baseInput(raceKey)),
      ),
    );
    const winners = results.filter((r) => r.created);
    expect(winners).toHaveLength(1);
    const ids = new Set(results.map((r) => r.session.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(winners[0]!.session.id);
    expect(await countSessions(grant.workspaceId, raceKey)).toBe(1);

    // 3a. Different key -> independent create (back-compat).
    const otherKey = `other-${crypto.randomUUID()}`;
    const otherKeyed = await createSessionWithIdempotencyKey(dbClient.db, baseInput(otherKey));
    expect(otherKeyed.created).toBe(true);
    expect(otherKeyed.session.id).not.toBe(first.session.id);

    // 3b. Same key string but a DIFFERENT workspace -> independent create (the
    //     key is workspace-scoped, not global).
    const crossWorkspace = await createSessionWithIdempotencyKey(dbClient.db, {
      accountId: otherGrant.accountId,
      workspaceId: otherGrant.workspaceId,
      initialMessage: "idempotent create",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createIdempotencyKey: seqKey,
    });
    expect(crossWorkspace.created).toBe(true);
    expect(crossWorkspace.session.id).not.toBe(first.session.id);

    // 3c. Absent key (the legacy createSession path) -> always independent, and
    //     two key-less creates never collide on the partial index.
    const plainA = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "no key a",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const plainB = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "no key b",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    expect(plainA.id).not.toBe(plainB.id);
    expect(plainA.createIdempotencyKey).toBeNull();
    expect(plainB.createIdempotencyKey).toBeNull();
  });

  test("persists scheduled tasks and run history", async () => {
    const grant = await testGrant(dbClient.db);
    const task = await createScheduledTask(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "daily",
      status: "active",
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "run",
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    // Every agent occurrence is admitted against the task's immutable accepted
    // execution while the task is still active; pausing afterwards keeps the
    // retained run history readable.
    const depthPolicy = await getNestedAgentDepthDeploymentPolicy(dbClient.db);
    const runId = crypto.randomUUID();
    const run = await createScheduledTaskRun(dbClient.db, {
      runId,
      workspaceId: grant.workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
      taskExecutionDigest: task.executionDigest,
      triggerType: "manual",
      producerKey: `db-integration-run:${runId}`,
      scheduledAt: null,
      acceptedExecutionSnapshot: {
        version: 1,
        task,
        resolvedModel: "scripted-model",
        resolvedReasoningEffort: "medium",
        resolvedLatencyMode: "standard",
        resolvedSandboxBackend: "none",
        resolvedSandboxOs: "linux",
        resolvedTools: [],
        resolvedFirstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
        resolvedFirstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
        resolvedVariableSet: null,
        resolvedRig: null,
        resolvedSlackBotConnection: null,
        targetSessionExecution: null,
        generatedSessionBinding: {
          createIdempotencyKey: `db-integration-run:${runId}`,
          effectiveMaxNestedAgentDepth: depthPolicy.maxNestedAgentDepth,
          nestedAgentDepthPolicySource: depthPolicy.policySource,
          codexCompactionMode: "portable",
        },
        personalConnectionDelegations: [],
        personalResourceAuthoritySubjectId: null,
        causalHumanSubjectId: null,
        causalHumanAuthority: null,
        xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
        xaiAuthoritySubjectId: null,
        connectionAuthoritySubjectId: null,
        triggerInitiator: { kind: "service", subjectId: "scheduler" },
        agentRunUsageIdempotencyKey: null,
        incidentPreflightRequired: false,
        alertOccurrenceLabels: null,
      },
    });
    // Agent run status is lifecycle-only: direct row updates are fenced, and
    // the terminal transition goes through the run lifecycle capability.
    await markScheduledTaskRunFailedIfQueued(dbClient.db, grant.workspaceId, run.id, "no worker");
    const updated = await updateScheduledTask(dbClient.db, grant.workspaceId, task.id, {
      status: "paused",
    });
    expect(updated.status).toBe("paused");
    expect(
      (await listScheduledTasks(dbClient.db, grant.workspaceId)).some(
        (item) => item.id === task.id,
      ),
    ).toBe(true);
    const runs = await listScheduledTaskRuns(dbClient.db, grant.workspaceId, task.id);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toBe("no worker");
  });

  test("persists and fences an exact existing-session scheduled task target", async () => {
    const grant = await testGrant(dbClient.db);
    const firstTarget = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "first scheduled target",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const secondTarget = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "second scheduled target",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const task = await createScheduledTask(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "continue exact session",
      status: "active",
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      schedule: { type: "interval", everySeconds: 3600 },
      runMode: "existing_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "continue", resources: [], tools: [], metadata: {} },
      targetSessionId: firstTarget.id,
      metadata: {},
    });
    expect(task).toMatchObject({
      runMode: "existing_session",
      targetSessionId: firstTarget.id,
      reusableSessionId: null,
    });

    const [stored] = await withWorkspaceRls(
      dbClient.db,
      grant.workspaceId,
      async (scopedDb) =>
        await scopedDb.execute<{ reusable_session_id: string | null }>(dbSql`
          select reusable_session_id
          from scheduled_tasks
          where id = ${task.id}
        `),
    );
    expect(stored?.reusable_session_id).toBe(firstTarget.id);

    await updateScheduledTask(dbClient.db, grant.workspaceId, task.id, {
      targetSessionId: secondTarget.id,
    });
    await expect(
      withWorkspaceRls(dbClient.db, grant.workspaceId, async (scopedDb) =>
        scopedDb.transaction(async (tx) =>
          requireScheduledTaskTargetInTransaction(tx as typeof scopedDb, {
            workspaceId: grant.workspaceId,
            taskId: task.id,
            targetSessionId: firstTarget.id,
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(ScheduledTaskTargetConflictError);
  });

  test("session goal lifecycle: set, revise, complete, replace", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "goal lifecycle",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    expect(await getSessionGoal(dbClient.db, grant.workspaceId, session.id)).toBeNull();
    const created = await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "ship the deploy pipeline",
      successCriteria: "CI green on main",
      createdBy: "api",
    });
    expect(created.status).toBe("active");
    expect(created.version).toBe(1);

    const revised = await updateSessionGoal(dbClient.db, grant.workspaceId, session.id, {
      text: "ship the deploy pipeline v2",
    });
    expect(revised.version).toBe(2);
    expect(revised.status).toBe("active");

    const paused = await setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, {
      status: "paused",
      rationale: "blocked",
      pausedReason: "agent",
    });
    expect(paused.changed).toBe(true);
    expect(paused.goal.pausedReason).toBe("agent");
    const pausedAgain = await setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, {
      status: "paused",
      pausedReason: "agent",
    });
    expect(pausedAgain.changed).toBe(false);

    const resumed = await setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, {
      status: "active",
    });
    expect(resumed.goal.pausedReason).toBeNull();
    expect(resumed.goal.rationale).toBeNull();
    expect(resumed.goal.autoContinuations).toBe(0);

    const completed = await setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, {
      status: "completed",
      evidence: "pipeline live, CI green",
    });
    expect(completed.goal.evidence).toBe("pipeline live, CI green");
    await expect(
      setSessionGoalStatus(dbClient.db, grant.workspaceId, session.id, {
        status: "active",
      }),
    ).rejects.toThrow("completed");

    const replaced = await upsertSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "now keep it healthy",
      createdBy: "agent",
    });
    expect(replaced.replaced).toBe(true);
    expect(replaced.goal.status).toBe("active");
    expect(replaced.goal.evidence).toBeNull();
    expect(replaced.goal.autoContinuations).toBe(0);
    expect(replaced.goal.version).toBeGreaterThan(completed.goal.version);
  });

  test("evaluateGoalContinuation honors queue, approvals, and caps", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "goal loop",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const guards = { defaultMaxAutoContinuations: 5 };

    // No goal yet.
    expect(
      await evaluateGoalContinuation(dbClient.db, {
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        ...guards,
      }),
    ).toEqual({ decision: "none" });

    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "keep working",
      createdBy: "api",
    });

    // Queued work always wins.
    const queuedUser = await submitTestHumanPrompt(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      text: "go",
      resources: [],
      tools: [],
      delivery: "send",
      reasoningEffortFallback: "low",
    });
    expect(
      (
        await evaluateGoalContinuation(dbClient.db, {
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          ...guards,
        })
      ).decision,
    ).toBe("queue");

    // A non-terminal requires_action turn (pending approval) blocks continuation.
    const queuedUserTurn = await claimRegisteredExecution(dbClient.db, grant, session.id);
    expect(queuedUserTurn.turn.id).toBe(queuedUser.turn.id);
    await settleRegisteredExecution(dbClient.db, grant, queuedUserTurn, "requires_action");
    expect(
      (
        await evaluateGoalContinuation(dbClient.db, {
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          ...guards,
        })
      ).decision,
    ).toBe("none");
    const [approval] = await appendSessionEvents(dbClient.db, grant.workspaceId, session.id, [
      {
        type: "user.approvalDecision",
        turnId: queuedUserTurn.turn.id,
        payload: { approvalId: "goal-test", decision: "approve" },
      },
    ]);
    const resumedUserTurn = await claimRegisteredExecution(dbClient.db, grant, session.id, {
      kind: "approval",
      triggerEventId: approval!.id,
    });
    await settleRegisteredExecution(dbClient.db, grant, resumedUserTurn, "completed");

    // First continuation.
    const first = await evaluateGoalContinuation(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      ...guards,
    });
    expect(first).toMatchObject({
      decision: "continue",
      autoContinuation: 1,
      cap: 5,
    });

    // A user-authoritative redirect re-arms it; the per-goal cap is enforced.
    await upsertSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "one more push",
      maxAutoContinuations: 1,
      createdBy: "api",
    });
    const capped = await evaluateGoalContinuation(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      ...guards,
    });
    expect(capped).toMatchObject({
      decision: "continue",
      autoContinuation: 1,
      cap: 1,
    });
    const capTurn = await claimGoalContinuationExecution(dbClient.db, grant, session.id);
    await settleRegisteredExecution(dbClient.db, grant, capTurn, "completed");
    const atCap = await evaluateGoalContinuation(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      ...guards,
    });
    expect(atCap).toMatchObject({
      decision: "paused",
      reason: "max_auto_continuations",
    });
  });

  test("continuations are not paused by inferred progress", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "goal loop",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const guards = { defaultMaxAutoContinuations: null };
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "outlast the rate limiter",
      createdBy: "api",
    });
    const first = await evaluateGoalContinuation(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      ...guards,
    });
    expect(first).toMatchObject({ decision: "continue", autoContinuation: 1 });

    // Tool-call shape and provider outcome are not reliable progress signals.
    // Repeated continuations without either remain active until the model,
    // user, budget, or an explicit configured cap ends the goal.
    for (let round = 1; round <= 3; round += 1) {
      const turn = await claimGoalContinuationExecution(dbClient.db, grant, session.id);
      await settleRegisteredExecution(dbClient.db, grant, turn, "completed");
      const next = await evaluateGoalContinuation(dbClient.db, {
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        ...guards,
      });
      expect(next).toMatchObject({
        decision: "continue",
        autoContinuation: 1 + round,
      });
    }
    expect(await getSessionGoal(dbClient.db, grant.workspaceId, session.id)).toMatchObject({
      status: "active",
      noProgressStreak: 0,
    });
  });

  test("goals are uncapped by count when no default cap is configured", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "multi-day goal",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    // No deployment default: length is governed by explicit lifecycle and
    // budget guards only.
    const guards = { defaultMaxAutoContinuations: null };
    await createSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "keep going for days",
      createdBy: "api",
    });
    // Run well past the old default cap of 20; the loop keeps continuing with
    // a null cap throughout.
    let decision = await evaluateGoalContinuation(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      ...guards,
    });
    expect(decision).toMatchObject({
      decision: "continue",
      autoContinuation: 1,
      cap: null,
    });
    for (let round = 2; round <= 25; round += 1) {
      const turn = await claimGoalContinuationExecution(dbClient.db, grant, session.id);
      await settleRegisteredExecution(dbClient.db, grant, turn, "completed", [
        { type: "agent.toolCall.created", payload: {} },
      ]);
      decision = await evaluateGoalContinuation(dbClient.db, {
        workspaceId: grant.workspaceId,
        sessionId: session.id,
        ...guards,
      });
      expect(decision).toMatchObject({
        decision: "continue",
        autoContinuation: round,
        cap: null,
      });
    }
    // A per-goal cap still applies on its own, without any deployment default.
    await upsertSessionGoal(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      text: "bounded push",
      maxAutoContinuations: 1,
      createdBy: "agent",
    });
    const bounded = await evaluateGoalContinuation(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      ...guards,
    });
    expect(bounded).toMatchObject({
      decision: "continue",
      autoContinuation: 1,
      cap: 1,
    });
    const boundedTurn = await claimGoalContinuationExecution(dbClient.db, grant, session.id);
    await settleRegisteredExecution(dbClient.db, grant, boundedTurn, "completed", [
      { type: "agent.toolCall.created", payload: {} },
    ]);
    const atCap = await evaluateGoalContinuation(dbClient.db, {
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      ...guards,
    });
    expect(atCap).toMatchObject({
      decision: "paused",
      reason: "max_auto_continuations",
    });
  });

  test("migration backfills goals:manage into goal-bearing sessions with explicit first-party permissions", async () => {
    const migrationName = "0009_goal_sessions_first_party_goals_manage.sql";
    const grant = await testGrant(dbClient.db);
    const makeSession = async (firstPartyMcpPermissions: Permission[] | null) =>
      await createSession(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        initialMessage: "backfill fixture",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        firstPartyMcpPermissions,
      });
    const addGoal = async (sessionId: string) =>
      await createSessionGoal(dbClient.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        text: "stay green",
        createdBy: "api",
      });

    // Healed: explicit permissions missing goals:manage + a non-completed goal.
    const activeGoalSession = await makeSession(["workspace:read", "github:use"]);
    await addGoal(activeGoalSession.id);
    const pausedGoalSession = await makeSession(["workspace:read"]);
    await addGoal(pausedGoalSession.id);
    await setSessionGoalStatus(dbClient.db, grant.workspaceId, pausedGoalSession.id, {
      status: "paused",
      pausedReason: "operator hold",
    });
    // Untouched: completed goal, no goal, already-holding, and default (null) sets.
    const completedGoalSession = await makeSession(["workspace:read"]);
    await addGoal(completedGoalSession.id);
    await setSessionGoalStatus(dbClient.db, grant.workspaceId, completedGoalSession.id, {
      status: "completed",
      evidence: "done",
    });
    const noGoalSession = await makeSession(["workspace:read"]);
    const alreadyHoldingSession = await makeSession(["goals:manage", "workspace:read"]);
    await addGoal(alreadyHoldingSession.id);
    const defaultSetSession = await makeSession(null);
    await addGoal(defaultSetSession.id);

    // The fixture rows were created after beforeAll already applied the
    // migration, so un-record it and run the migration path again - the same
    // way an upgraded deployment replays pending files over existing data.
    const rerunMigration = async () => {
      await dbClient.db.execute(
        dbSql`DELETE FROM "schema_migrations" WHERE "name" = ${migrationName}`,
      );
      await services.migrate();
    };
    await rerunMigration();

    const permissionsOf = async (sessionId: string) =>
      (await getSession(dbClient.db, grant.workspaceId, sessionId))?.firstPartyMcpPermissions ??
      null;
    expect(await permissionsOf(activeGoalSession.id)).toEqual([
      "workspace:read",
      "github:use",
      "goals:manage",
    ] as Permission[]);
    expect(await permissionsOf(pausedGoalSession.id)).toEqual([
      "workspace:read",
      "goals:manage",
    ] as Permission[]);
    expect(await permissionsOf(completedGoalSession.id)).toEqual([
      "workspace:read",
    ] as Permission[]);
    expect(await permissionsOf(noGoalSession.id)).toEqual(["workspace:read"] as Permission[]);
    expect(await permissionsOf(alreadyHoldingSession.id)).toEqual([
      "goals:manage",
      "workspace:read",
    ] as Permission[]);
    expect(await permissionsOf(defaultSetSession.id)).toBeNull();

    // Idempotent: a second run adds nothing.
    await rerunMigration();
    expect(await permissionsOf(activeGoalSession.id)).toEqual([
      "workspace:read",
      "github:use",
      "goals:manage",
    ] as Permission[]);
    expect(await permissionsOf(alreadyHoldingSession.id)).toEqual([
      "goals:manage",
      "workspace:read",
    ] as Permission[]);
  });

  test("RLS policies isolate session goal rows for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      const sessionB = await createSession(dbClient.db, {
        accountId: grantB.accountId,
        workspaceId: grantB.workspaceId,
        initialMessage: "workspace b goal",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      });
      await createSessionGoal(dbClient.db, {
        accountId: grantB.accountId,
        workspaceId: grantB.workspaceId,
        sessionId: sessionB.id,
        text: "workspace b objective",
        createdBy: "api",
      });

      const hidden = await appDbClient.db.execute(
        dbSql<{
          count: string;
        }>`select count(*)::text as count from session_goals`,
      );
      expect(Number(hidden[0]?.count ?? 0)).toBe(0);

      const sessionA = await createSession(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        initialMessage: "workspace a goal",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      });
      await createSessionGoal(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        sessionId: sessionA.id,
        text: "workspace a objective",
        createdBy: "api",
      });
      const visible = await withRlsContext(
        appDbClient.db,
        grantA,
        async (db) =>
          await db.execute(
            dbSql<{
              workspace_id: string;
            }>`select workspace_id::text from session_goals`,
          ),
      );
      expect(visible.map((row) => row.workspace_id)).toEqual([grantA.workspaceId]);

      await expect(
        withRlsContext(appDbClient.db, grantA, async (db) => {
          await db.execute(dbSql`
          insert into session_goals (account_id, workspace_id, session_id, text)
          values (${grantA.accountId}, ${grantB.workspaceId}, ${sessionB.id}, 'mismatched goal')
        `);
        }),
      ).rejects.toThrow();
    } finally {
      await appDbClient.close();
    }
  });

  test("RLS policies isolate workspace-owned rows for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      await createSession(dbClient.db, {
        accountId: grantB.accountId,
        workspaceId: grantB.workspaceId,
        initialMessage: "workspace b",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      });

      const hidden = await appDbClient.db.execute(
        dbSql<{ count: string }>`select count(*)::text as count from sessions`,
      );
      expect(Number(hidden[0]?.count ?? 0)).toBe(0);

      const created = await createSession(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        initialMessage: "workspace a",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      });
      expect(created.workspaceId).toBe(grantA.workspaceId);
      expect((await getSession(appDbClient.db, grantA.workspaceId, created.id))?.id).toBe(
        created.id,
      );

      const visible = await withRlsContext(
        appDbClient.db,
        grantA,
        async (db) =>
          await db.execute(
            dbSql<{
              id: string;
              workspace_id: string;
            }>`select id, workspace_id::text from sessions order by created_at asc`,
          ),
      );
      expect(visible.map((row) => row.workspace_id)).toEqual([grantA.workspaceId]);

      await expect(
        createSession(appDbClient.db, {
          accountId: grantA.accountId,
          workspaceId: grantB.workspaceId,
          initialMessage: "mismatched account workspace",
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
        }),
      ).rejects.toThrow();

      const keyHash = crypto.randomUUID();
      const apiKey = await createApiKey(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        name: "RLS key",
        description: "Verifies workspace-scoped API-key access",
        prefix: "og_test",
        keyHash,
        permissions: ["sessions:create"],
      });
      expect(await findActiveApiKeyByHash(appDbClient.db, keyHash)).toMatchObject({
        id: apiKey.id,
        description: "Verifies workspace-scoped API-key access",
      });
      await expect(
        createApiKey(appDbClient.db, {
          accountId: grantA.accountId,
          workspaceId: grantA.workspaceId,
          name: "Oversized description",
          description: "x".repeat(501),
          prefix: "og_oversized",
          keyHash: crypto.randomUUID(),
          permissions: ["sessions:create"],
        }),
      ).rejects.toThrow();
    } finally {
      await appDbClient.close();
    }
  });

  // Current Knowledge scope, revision, review and retrieval contracts run through
  // the provisioned runtime role in packages/db/test/unified-knowledge-postgres.test.ts.
  // Historical Memory behavior is exercised only against the pre-knowledge schema.

  test("RLS policies isolate capability, pack, and social rows for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      await seedCapabilityPackAndSocialRows(dbClient.db, grantB);

      for (const table of newCapabilityTables) {
        const hidden = await appDbClient.db.execute(
          dbSql<{
            count: string;
          }>`select count(*)::text as count from ${dbSql.raw(table)}`,
        );
        expect(Number(hidden[0]?.count ?? 0)).toBe(0);
      }

      await withRlsContext(appDbClient.db, grantA, async (db) => {
        await seedCapabilityPackAndSocialRows(db, grantA);
      });

      for (const table of newCapabilityTables) {
        const visible = await withRlsContext(
          appDbClient.db,
          grantA,
          async (db) =>
            await db.execute(
              dbSql<{
                workspace_id: string;
              }>`select workspace_id::text from ${dbSql.raw(table)} order by workspace_id asc`,
            ),
        );
        expect(visible.map((row) => row.workspace_id)).toEqual([grantA.workspaceId]);
      }

      await expect(
        withRlsContext(appDbClient.db, grantA, async (db) => {
          await db.execute(dbSql`
          insert into pack_installations (account_id, workspace_id, pack_id)
          values (${grantA.accountId}, ${grantB.workspaceId}, ${`mismatched-${crypto.randomUUID()}`})
        `);
        }),
      ).rejects.toThrow();
    } finally {
      await appDbClient.close();
    }
  });

  test("RLS policies isolate workspace variable-set rows for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      await seedWorkspaceVariableSetRows(dbClient.db, grantB);

      for (const table of ["workspace_variable_sets", "workspace_variable_set_variables"]) {
        const hidden = await appDbClient.db.execute(
          dbSql<{
            count: string;
          }>`select count(*)::text as count from ${dbSql.raw(table)}`,
        );
        expect(Number(hidden[0]?.count ?? 0)).toBe(0);
      }

      await withRlsContext(appDbClient.db, grantA, async (db) => {
        await seedWorkspaceVariableSetRows(db, grantA);
      });

      for (const table of ["workspace_variable_sets", "workspace_variable_set_variables"]) {
        const visible = await withRlsContext(
          appDbClient.db,
          grantA,
          async (db) =>
            await db.execute(
              dbSql<{
                workspace_id: string;
              }>`select workspace_id::text from ${dbSql.raw(table)}`,
            ),
        );
        expect(visible.map((row) => row.workspace_id)).toEqual([grantA.workspaceId]);
      }

      await expect(
        withRlsContext(appDbClient.db, grantA, async (db) => {
          await db.execute(dbSql`
          insert into workspace_variable_sets (account_id, workspace_id, name)
          values (${grantA.accountId}, ${grantB.workspaceId}, ${`mismatched-${crypto.randomUUID()}`})
        `);
        }),
      ).rejects.toThrow();
    } finally {
      await appDbClient.close();
    }
  });

  test("exports only runtime-ready enabled MCP capability servers", async () => {
    const grant = await testGrant(dbClient.db);
    const otherGrant = await testGrant(dbClient.db);
    const capabilityId = `mcp:test-${crypto.randomUUID()}`;
    await upsertCapabilityCatalogItem(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: capabilityId,
      kind: "mcp",
      source: "manual",
      name: "Test MCP",
      endpointUrl: "https://example.com/mcp",
      metadata: { mcpServerId: "cap-test-ready" },
    });
    await enableCapabilityInstallation(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      capabilityId,
      kind: "mcp",
      metadata: {},
    });
    expect(
      (await listEnabledMcpCapabilityServers(dbClient.db, grant.workspaceId)).some(
        (server) => server.capabilityId === capabilityId,
      ),
    ).toBe(false);

    await enableCapabilityInstallation(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      capabilityId,
      kind: "mcp",
      metadata: {
        mcpConnectivity: {
          status: "ok",
          checkedAt: new Date().toISOString(),
          toolCount: 1,
        },
      },
    });
    expect(
      (await listEnabledMcpCapabilityServers(dbClient.db, grant.workspaceId)).some(
        (server) => server.capabilityId === capabilityId,
      ),
    ).toBe(true);
    expect(
      (await listEnabledMcpCapabilityServers(dbClient.db, otherGrant.workspaceId)).some(
        (server) => server.capabilityId === capabilityId,
      ),
    ).toBe(false);

    const gatedCapabilityId = `mcp:gated-${crypto.randomUUID()}`;
    await upsertCapabilityCatalogItem(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      id: gatedCapabilityId,
      kind: "mcp",
      source: "manual",
      name: "Gated MCP",
      endpointUrl: "https://secure.example/mcp",
      authModel: "credential_ref",
      metadata: { mcpServerId: "cap-test-gated" },
    });
    await enableCapabilityInstallation(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      capabilityId: gatedCapabilityId,
      kind: "mcp",
      metadata: {
        mcpConnectivity: {
          status: "ok",
          checkedAt: new Date().toISOString(),
          toolCount: 1,
        },
      },
    });
    expect(
      (await listEnabledMcpCapabilityServers(dbClient.db, grant.workspaceId)).some(
        (server) => server.capabilityId === gatedCapabilityId,
      ),
    ).toBe(false);
  });

  test("migration 0014 repair strips a legacy orphaned function_call_result, audits it, and spares valid pairs + dangling calls", async () => {
    const grant = await testGrant(dbClient.db);
    const session = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "orphan-repair",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    // A second session that must stay completely untouched — proves the repair
    // is session-scoped and never deletes a result whose call lives elsewhere.
    const otherSession = await createSession(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "orphan-repair-other",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    // Legacy corruption: an orphaned function_call_result (no preceding call), a
    // valid call+result pair, and a trailing dangling call (valid mid-turn).
    await insertHistoryMigrationFixture(dbClient.db, grant, session.id, [
      { position: 0, item: { type: "message", role: "user", content: "go" } },
      {
        position: 1,
        item: {
          type: "function_call_result",
          callId: "orphan_x",
          output: { type: "text", text: "leaked" },
        },
      },
      {
        position: 2,
        item: {
          type: "function_call",
          callId: "paired",
          name: "tool",
          arguments: "{}",
        },
      },
      {
        position: 3,
        item: {
          type: "function_call_result",
          callId: "paired",
          output: { type: "text", text: "ok" },
        },
      },
      // snake_case orphan: a result whose call_id has no earlier call.
      {
        position: 4,
        item: {
          type: "shell_call_output",
          call_id: "orphan_snake",
          output: "leaked2",
        },
      },
      {
        position: 5,
        item: {
          type: "function_call",
          callId: "dangling",
          name: "tool",
          arguments: "{}",
        },
      },
    ]);
    // The other session holds a call with the SAME id as this session's orphan,
    // to prove cross-session call presence does NOT spare an orphan (scoping).
    await insertHistoryMigrationFixture(dbClient.db, grant, otherSession.id, [
      {
        position: 0,
        item: {
          type: "function_call",
          callId: "orphan_x",
          name: "tool",
          arguments: "{}",
        },
      },
      {
        position: 1,
        item: {
          type: "function_call_result",
          callId: "orphan_x",
          output: { type: "text", text: "ok" },
        },
      },
    ]);

    // Run the ACTUAL shipped migration SQL against the live DB. CREATE TABLE IF
    // NOT EXISTS and the GRANT block make re-running it (already applied in
    // beforeAll) idempotent; the CTE DELETE re-evaluates the new orphans.
    const migrationPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../packages/db/drizzle/0014_repair_orphaned_function_call_results.sql",
    );
    const migrationSql = await readFile(migrationPath, "utf8");
    await applyRawSql(services.databaseUrl, migrationSql);

    // The two orphans are gone; everything else survives in order.
    const remaining = await getSessionHistoryItems(dbClient.db, grant.workspaceId, session.id);
    expect(remaining.map((row) => row.position).sort((a, b) => a - b)).toEqual([0, 2, 3, 5]);
    const remainingTypes = remaining
      .sort((a, b) => a.position - b.position)
      .map((row) => (row.item as Record<string, unknown>).type);
    expect(remainingTypes).toEqual([
      "message",
      "function_call",
      "function_call_result",
      "function_call",
    ]);
    // The dangling call (valid mid-turn) was NOT deleted.
    expect(
      remaining.some((row) => (row.item as Record<string, unknown>).callId === "dangling"),
    ).toBe(true);
    // Neither orphan survives.
    expect(
      remaining.some((row) => (row.item as Record<string, unknown>).callId === "orphan_x"),
    ).toBe(false);
    expect(
      remaining.some((row) => (row.item as Record<string, unknown>).call_id === "orphan_snake"),
    ).toBe(false);

    // The other session is completely untouched (scoping).
    const otherRemaining = await getSessionHistoryItems(
      dbClient.db,
      grant.workspaceId,
      otherSession.id,
    );
    expect(otherRemaining.map((row) => row.position).sort((a, b) => a - b)).toEqual([0, 1]);

    // Both deleted orphans were audited verbatim into the permanent audit table.
    const audit = await dbClient.db.execute(dbSql`
      select source_id, position, item, repair_reason
      from session_history_items_repair_audit
      where session_id = ${session.id}
      order by position
    `);
    const auditRows = audit as unknown as Array<{
      position: number;
      item: Record<string, unknown>;
      repair_reason: string;
    }>;
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((r) => Number(r.position)).sort((a, b) => a - b)).toEqual([1, 4]);
    expect(
      auditRows.every((r) => r.repair_reason === "orphaned_tool_call_result_no_matching_call"),
    ).toBe(true);
    const auditedCallIds = auditRows.map((r) => r.item.callId ?? r.item.call_id);
    expect(auditedCallIds.sort()).toEqual(["orphan_snake", "orphan_x"]);
  });
});

type RegisteredExecution = {
  turn: Extract<
    Awaited<ReturnType<typeof claimSessionWorkForAttempt>>,
    { action: "claimed" }
  >["turn"];
  triggerEventId: string;
  attemptId: string;
};

async function claimRegisteredExecution(
  db: ReturnType<typeof createDb>["db"],
  grant: AccessGrant,
  sessionId: string,
  trigger: Parameters<typeof claimSessionWorkForAttempt>[2]["trigger"] = {
    kind: "next",
  },
): Promise<RegisteredExecution> {
  const attemptId = crypto.randomUUID();
  const result = await claimSessionWorkForAttempt(db, grant.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `dispatch-${crypto.randomUUID()}`,
    trigger,
  });
  if (result.action !== "claimed") {
    throw new Error(`goal fixture could not claim work for ${sessionId}: ${result.reason}`);
  }
  return {
    turn: result.turn,
    triggerEventId: result.turn.triggerEventId,
    attemptId,
  };
}

async function claimGoalContinuationExecution(
  db: ReturnType<typeof createDb>["db"],
  grant: AccessGrant,
  sessionId: string,
): Promise<RegisteredExecution> {
  const goal = await getSessionGoal(db, grant.workspaceId, sessionId);
  if (!goal || goal.status !== "active") {
    throw new Error(`goal fixture has no active goal for ${sessionId}`);
  }
  const prompt = `Continue goal ${goal.id}`;
  const update = await addSessionSystemUpdate(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId,
    kind: "goal_continuation",
    classification: "info",
    sourceId: goal.id,
    dedupeKey: `goal-test:${goal.id}:${crypto.randomUUID()}`,
    summary: prompt,
    payload: {
      type: "goal_continuation",
      goalId: goal.id,
      goalVersion: goal.version,
      prompt,
      policy: {
        model: "scripted-model",
        reasoningEffort: "low",
        tools: [],
        sandboxBackend: "none",
      },
    },
    lineage: { goalId: goal.id },
  });
  if (update.reason === "session_cancelled") {
    throw new Error(`goal fixture session was cancelled: ${sessionId}`);
  }
  const execution = await claimRegisteredExecution(db, grant, sessionId);
  if (execution.turn.source !== "goal") {
    throw new Error(`goal update became unexpected ${execution.turn.source} execution`);
  }
  return execution;
}

async function settleRegisteredExecution(
  db: ReturnType<typeof createDb>["db"],
  grant: AccessGrant,
  execution: RegisteredExecution,
  turnStatus: "completed" | "failed" | "requires_action",
  events: Parameters<typeof applySessionTurnSettlement>[2]["events"] = [],
): Promise<void> {
  const requiresAction = turnStatus === "requires_action";
  const settled = await applySessionTurnSettlement(db, grant.workspaceId, {
    sessionId: execution.turn.sessionId,
    turnId: execution.turn.id,
    triggerEventId: execution.triggerEventId,
    attemptId: execution.attemptId,
    turnStatus,
    sessionStatus: requiresAction ? "requires_action" : "idle",
    activeTurnId: requiresAction ? execution.turn.id : null,
    events,
  });
  if (settled.action !== "settled") {
    throw new Error(`goal fixture could not settle turn ${execution.turn.id}`);
  }
}

async function insertHistoryMigrationFixture(
  db: ReturnType<typeof createDb>["db"],
  grant: AccessGrant,
  sessionId: string,
  items: Array<{ position: number; item: Record<string, unknown> }>,
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    async (scopedDb) => {
      await scopedDb.insert(dbSchema.sessionHistoryItems).values(
        items.map(({ position, item }) => ({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId,
          position,
          item,
        })),
      );
    },
  );
}

const newCapabilityTables = [
  "pack_installations",
  "capability_catalog_items",
  "capability_installations",
  "social_connections",
  "social_posts",
];

async function seedCapabilityPackAndSocialRows(
  db: ReturnType<typeof createDb>["db"],
  grant: AccessGrant,
): Promise<void> {
  const suffix = crypto.randomUUID();
  const capabilityId = `mcp:rls-${suffix}`;
  const connectionId = crypto.randomUUID();
  await db.execute(dbSql`
    insert into pack_installations (account_id, workspace_id, pack_id)
    values (${grant.accountId}, ${grant.workspaceId}, ${`pack-${suffix}`})
  `);
  await db.execute(dbSql`
    insert into capability_catalog_items (id, account_id, workspace_id, kind, source, name, endpoint_url)
    values (${capabilityId}, ${grant.accountId}, ${grant.workspaceId}, 'mcp', 'manual', ${`RLS MCP ${suffix}`}, 'https://example.com/mcp')
  `);
  await db.execute(dbSql`
    insert into capability_installations (account_id, workspace_id, capability_id, kind)
    values (${grant.accountId}, ${grant.workspaceId}, ${capabilityId}, 'mcp')
  `);
  await db.execute(dbSql`
    insert into social_connections (id, account_id, workspace_id, provider, account_handle)
    values (${connectionId}, ${grant.accountId}, ${grant.workspaceId}, 'linkedin', ${`handle-${suffix}`})
  `);
  await db.execute(dbSql`
    insert into social_posts (account_id, workspace_id, connection_id, provider, external_post_id, text, published_at)
    values (${grant.accountId}, ${grant.workspaceId}, ${connectionId}, 'linkedin', ${`post-${suffix}`}, 'RLS post', now())
  `);
}

async function seedWorkspaceVariableSetRows(
  db: ReturnType<typeof createDb>["db"],
  grant: AccessGrant,
): Promise<void> {
  const suffix = crypto.randomUUID();
  const variableSetId = crypto.randomUUID();
  await db.execute(dbSql`
    insert into workspace_variable_sets (id, account_id, workspace_id, name)
    values (${variableSetId}, ${grant.accountId}, ${grant.workspaceId}, ${`rls-variable-set-${suffix}`})
  `);
  await db.execute(dbSql`
    insert into workspace_variable_set_variables (account_id, workspace_id, variable_set_id, name, value_encrypted)
    values (${grant.accountId}, ${grant.workspaceId}, ${variableSetId}, 'RLS_TOKEN', 'v1:placeholder:placeholder')
  `);
}

async function testGrant(db: ReturnType<typeof createDb>["db"]): Promise<AccessGrant> {
  const id = crypto.randomUUID();
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:db",
    accountExternalId: `account:${id}`,
    accountName: "DB integration account",
    workspaceExternalSource: "test:db",
    workspaceExternalId: `workspace:${id}`,
    workspaceName: "DB integration workspace",
    subjectId: `test:db:${id}`,
    subjectLabel: "DB integration",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) {
    throw new Error("DB test did not create a workspace grant");
  }
  return grant;
}

async function createRlsAppRole(
  db: ReturnType<typeof createDb>["db"],
  ownerUrl: string,
): Promise<string> {
  const role = `opengeni_rls_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const password = `pw_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.execute(dbSql.raw(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`));
  await db.execute(dbSql.raw(`GRANT USAGE ON SCHEMA public TO "${role}"`));
  await db.execute(dbSql.raw(`GRANT USAGE ON SCHEMA opengeni_private TO "${role}"`));
  await db.execute(
    dbSql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`),
  );
  await db.execute(
    dbSql.raw(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO "${role}"`),
  );
  // Match the runtime role's exact target-schema-local capabilities. These
  // functions are intentionally excluded from the broad private helper grant
  // and remain unavailable to PUBLIC. The session reference helper and xAI
  // validator are invoker-rights; the latter evaluates immutable snapshot
  // CHECK constraints on ordinary session inserts.
  await db.execute(
    dbSql.raw(
      `GRANT EXECUTE ON FUNCTION public.session_private_actor_visible(uuid, uuid, uuid, text) TO "${role}"`,
    ),
  );
  await db.execute(
    dbSql.raw(
      `GRANT EXECUTE ON FUNCTION public.session_reference_visible(uuid, uuid, uuid) TO "${role}"`,
    ),
  );
  await db.execute(
    dbSql.raw(
      `GRANT EXECUTE ON FUNCTION public.lock_nested_agent_depth_configuration() TO "${role}"`,
    ),
  );
  await db.execute(
    dbSql.raw(
      `GRANT EXECUTE ON FUNCTION public.xai_provider_account_authority_snapshot_v1_valid(jsonb) TO "${role}"`,
    ),
  );
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}
