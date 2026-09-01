import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  SCHEDULED_TASK_ACCEPTED_EXECUTION_MAX_BYTES,
  SCHEDULED_TASK_OCCURRENCE_PAYLOAD_MAX_BYTES,
  TurnExecutionPolicyV1,
  type McpPersonalConnectionDelegation,
} from "@opengeni/contracts";
import { resolveFirstPartyMcpToolPolicy } from "@opengeni/config";
import {
  captureScheduledTaskRestoreState,
  defaultSessionMcpServerIds,
  resolveSessionToolPolicy,
  settingsWithEnabledCapabilityMcpServers,
  syncUpdatedScheduledTask,
} from "@opengeni/core";
import {
  claimSessionWorkForAttempt,
  bindScheduledTaskRunSessionInTransaction,
  createDb,
  createRig,
  createScheduledTask,
  createScheduledTaskRun,
  createSession,
  createVariableSet,
  createXaiSubscriptionCredential,
  disconnectXaiSubscriptionCredential,
  getScheduledTaskRunAcceptedExecution,
  getScheduledVariableSetExpectedGenerationForAttempt,
  getScheduledTask,
  getNestedAgentDepthDeploymentPolicy,
  getScheduledTaskRevisionAuthority,
  getScheduledTaskPersonalConnectionDelegations,
  listSessionSystemUpdatesForTurn,
  listScheduledTaskRuns,
  nestedPostgresSqlState,
  persistSlackBotInstallationWithSuccessAudit,
  requestSessionTurnRecovery,
  requireSession,
  setVariableSetVariable,
  updateScheduledTask,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import { loadWorkspaceEnvironmentForRunWithCredentials } from "../src/activities/environment";
import type { ActivityServices } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-personal-authority");
  if (!shared) {
    available = false;
    console.warn("[worker-scheduled-personal-authority] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function workspaceFixture() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('scheduled personal authority') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'scheduled personal authority') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const fixture = {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId: `subject-${crypto.randomUUID()}`,
  };
  await admin`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id
    ) values (
      ${fixture.accountId}, ${fixture.subjectId}, 'active', ${fixture.workspaceId}
    )`;
  return fixture;
}

async function commonConnectionDelegationFixture(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
) {
  const [membership] = await admin<Array<{ id: string }>>`
    select id from organization_memberships
    where account_id = ${workspace.accountId}
      and subject_id = ${workspace.subjectId}
  `;
  const connection = await admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
    await tx`select set_config('opengeni.subject_id', ${workspace.subjectId}, true)`;
    const [row] = await tx<Array<{ id: string; authorityId: string; authorityGeneration: number }>>`
      insert into connections (
        account_id, workspace_id, subject_id, provider_domain, kind,
        credential_encrypted
      ) values (
        ${workspace.accountId}, ${workspace.workspaceId}, ${workspace.subjectId},
        'scheduled-common.example.com', 'oauth2', 'ciphertext'
      ) returning id, authority_id as "authorityId",
        authority_generation::int as "authorityGeneration"
    `;
    return row!;
  });
  const grant = await admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
    await tx`select set_config('opengeni.subject_id', ${workspace.subjectId}, true)`;
    const [row] = await tx<Array<{ id: string; generation: number }>>`
      select grant_id as id, grant_generation::int as generation
      from issue_self_connection_use_grant(
        ${workspace.accountId}::uuid, ${connection.authorityId}::uuid,
        ${workspace.workspaceId}::uuid, 'always', 'workspace_shared', null, true
      )
    `;
    return row!;
  });
  return {
    connection,
    grant,
    membershipId: membership!.id,
    delegation: {
      serverId: "scheduled-common",
      connectionId: connection.id,
      originWorkspaceId: workspace.workspaceId,
      ownerSubjectId: workspace.subjectId,
      providerDomain: "scheduled-common.example.com",
      kind: "oauth2" as const,
      connectionType: "mcp" as const,
      userDelegation: {
        authorityId: connection.authorityId,
        grantId: grant.id,
        organizationId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        sessionId: null,
        action: "connection.use" as const,
        mode: "always" as const,
        context: "workspace_shared" as const,
        authorityEpoch: null,
        authorityGeneration: connection.authorityGeneration,
        grantGeneration: grant.generation,
      },
    } satisfies McpPersonalConnectionDelegation,
  };
}

async function slackBotConnectionFixture(workspace: Awaited<ReturnType<typeof workspaceFixture>>) {
  const suffix = crypto.randomUUID();
  return await persistSlackBotInstallationWithSuccessAudit(client.db, {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: workspace.subjectId,
    credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
    credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
    slackTeamId: `T-${suffix}`,
    credentialEncrypted: "ciphertext",
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
    verifiedInstallAt: new Date("2026-08-16T20:00:00.000Z"),
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: `T-${suffix}`,
      slackTeamName: "Scheduled claim test",
      botUserId: `U-${suffix}`,
      botId: `B-${suffix}`,
      botDisplayName: "OpenGeni",
      verifiedAt: "2026-08-16T20:00:00.000Z",
    },
  });
}

function delegation(
  subjectId: string,
  serverId: string,
  providerDomain: string,
): McpPersonalConnectionDelegation[] {
  return [
    {
      serverId,
      connectionId: crypto.randomUUID(),
      ownerSubjectId: subjectId,
      providerDomain,
      kind: "oauth2",
    },
  ];
}

function activities(overrides: Parameters<typeof testSettings>[0] = {}) {
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({
          databaseUrl: shared!.appUrl,
          sandboxBackend: "none",
          ...overrides,
        }),
        db: client.db,
        bus: new MemoryEventBus(),
      }) as unknown as ActivityServices,
  );
}

async function installDefaultMcpServer(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  serverId: string,
) {
  const capabilityId = `mcp:scheduled-${crypto.randomUUID()}`;
  const endpoint = `https://${crypto.randomUUID()}.example.com/${serverId}`;
  await admin`insert into capability_catalog_items (
    id, account_id, workspace_id, kind, source, name, endpoint_url,
    auth_model, auth_kind, provider_domain, mcp_url, metadata
  ) values (
    ${capabilityId}, null, null, 'mcp', 'registry', ${capabilityId}, ${endpoint},
    null, 'none', ${`${crypto.randomUUID()}.example.com`}, ${endpoint},
    ${admin.json({ mcpProbe: { status: "real" }, mcpServerId: serverId })}
  )`;
  await admin`insert into capability_installations (
    account_id, workspace_id, capability_id, kind, status, config, metadata
  ) values (
    ${workspace.accountId}, ${workspace.workspaceId}, ${capabilityId},
    'mcp', 'active', '{}'::jsonb,
    ${admin.json({ mcpConnectivity: { status: "ok" } })}
  )`;
}

async function scheduledRuntimeMcpIds(
  workspaceId: string,
  sessionId: string,
  turn: { tools: Array<{ kind: "mcp"; id: string; optional?: boolean }>; metadata: unknown },
) {
  const settings = testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" });
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(
    client.db,
    workspaceId,
    settings,
  );
  const session = await requireSession(client.db, workspaceId, sessionId);
  const raw =
    turn.metadata && typeof turn.metadata === "object" && !Array.isArray(turn.metadata)
      ? (turn.metadata as Record<string, unknown>).scheduledEffectiveMcpServerIds
      : null;
  const acceptedIds =
    Array.isArray(raw) && raw.every((id) => typeof id === "string")
      ? [...new Set(raw)].sort()
      : null;
  const currentIds = new Set(runtimeSettings.mcpServers.map((server) => server.id));
  return resolveSessionToolPolicy({
    toolPolicy: session.toolPolicy,
    sessionTools: acceptedIds ? turn.tools : session.tools,
    availableMcpServerIds: acceptedIds
      ? acceptedIds.filter((id) => currentIds.has(id))
      : [...currentIds],
    defaultMcpServerIds: acceptedIds ?? defaultSessionMcpServerIds(runtimeSettings.mcpServers),
  }).toolRefs.map((tool) => tool.id);
}

async function claimedCommonVariableSetRun(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  variableSetId: string,
) {
  const task = await createScheduledTask(client.db, {
    ...workspace,
    createdBy: { kind: "subject", subjectId: workspace.subjectId },
    name: `materialize-exact-generation-${crypto.randomUUID()}`,
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-vs-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: "materialize exact generation", resources: [], tools: [], metadata: {} },
    variableSetId,
    metadata: {},
  });
  const dispatched = await activities().dispatchScheduledTaskRun({
    workspaceId: workspace.workspaceId,
    taskId: task.id,
    triggerType: "scheduled",
    producerKey: `scheduled-vs-${crypto.randomUUID()}`,
  });
  if (dispatched.action !== "start") throw new Error(`dispatch ${JSON.stringify(dispatched)}`);
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
    sessionId: dispatched.sessionId,
    workflowId: dispatched.workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`claim ${JSON.stringify(claimed)}`);
  return { dispatched, claimed, attemptId };
}

describe("scheduled task personal MCP authority", () => {
  test("generated sessions resolve workspace and organization Variable Sets without personal authority", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const workspaceSet = await createVariableSet(client.db, {
      ...workspace,
      scope: "workspace",
      name: "scheduled workspace variables",
    });
    const organizationSet = await createVariableSet(client.db, {
      ...workspace,
      scope: "organization",
      allowOrganization: true,
      name: "scheduled organization variables",
    });

    for (const [scope, variableSet, runMode] of [
      ["workspace", workspaceSet, "new_session_per_run"],
      ["organization", organizationSet, "reusable_session"],
    ] as const) {
      const task = await createScheduledTask(client.db, {
        ...workspace,
        name: `${scope} generated Variable Set`,
        status: "active",
        schedule: { type: "interval", everySeconds: 3_600 },
        temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
        runMode,
        overlapPolicy: "allow_concurrent",
        agentConfig: {
          prompt: `Use the ${scope} Variable Set`,
          resources: [],
          tools: [],
          metadata: {},
        },
        createdBy: { kind: "subject", subjectId: workspace.subjectId },
        personalConnectionDelegations: [],
        variableSetId: variableSet.id,
        metadata: {},
      });
      const dispatched = await activities().dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `common-variable-set-${scope}-${crypto.randomUUID()}`,
      });
      expect(dispatched.action, scope).toBe("start");
      const [session] = await admin<Array<{ variableSetId: string | null }>>`
        select variable_set_id as "variableSetId"
        from sessions where id = ${dispatched.sessionId}`;
      expect(session?.variableSetId, scope).toBe(variableSet.id);
      const [authority] = await admin<Array<{ count: number }>>`
        select count(*)::int as count
        from scheduled_task_personal_resource_authorities
        where task_id = ${task.id}`;
      expect(authority?.count, scope).toBe(0);
    }
  });

  test("freezes workspace-default MCP tools across fresh and recovery claims", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const session = await createSession(client.db, {
      ...workspace,
      initialMessage: "workspace default target",
      resources: [],
      tools: [{ kind: "mcp", id: "opengeni" }],
      toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const task = await createScheduledTask(client.db, {
      ...workspace,
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      name: "workspace default target",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `workspace-default-${crypto.randomUUID()}`,
      runMode: "existing_session",
      targetSessionId: session.id,
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "scheduled update", resources: [], tools: [], metadata: {} },
      metadata: {},
    });
    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `workspace-default-${crypto.randomUUID()}`,
    });
    if (dispatched.action !== "signal") throw new Error(`dispatch ${JSON.stringify(dispatched)}`);
    const [run] = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10);
    const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: workspace.workspaceId,
      runId: run!.id,
    });
    expect(TurnExecutionPolicyV1.parse(accepted?.turnExecutionPolicy)).toMatchObject({
      productModelId: "scripted-model",
      modelSource: "session",
      reasoningSource: "session",
    });
    const addedBeforeFresh = `fresh-default-${crypto.randomUUID()}`;
    await installDefaultMcpServer(workspace, addedBeforeFresh);
    const firstAttemptId = crypto.randomUUID();
    const fresh = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: session.id,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: firstAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (fresh.action !== "claimed") throw new Error(`fresh ${JSON.stringify(fresh)}`);
    expect(
      await scheduledRuntimeMcpIds(workspace.workspaceId, session.id, fresh.turn as never),
    ).not.toContain(addedBeforeFresh);
    await requestSessionTurnRecovery(client.db, workspace.workspaceId, {
      sessionId: session.id,
      turnId: fresh.turn.id,
      triggerEventId: fresh.turn.triggerEventId,
      attemptId: firstAttemptId,
      reason: "workspace default authority recovery",
    });
    const addedBeforeRecovery = `recovery-default-${crypto.randomUUID()}`;
    await installDefaultMcpServer(workspace, addedBeforeRecovery);
    const recovered = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: session.id,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (recovered.action !== "claimed") throw new Error(`recovery ${JSON.stringify(recovered)}`);
    const recoveryIds = await scheduledRuntimeMcpIds(
      workspace.workspaceId,
      session.id,
      recovered.turn as never,
    );
    expect(recoveryIds).not.toContain(addedBeforeFresh);
    expect(recoveryIds).not.toContain(addedBeforeRecovery);
    expect(accepted?.targetSessionExecution?.effectiveMcpServerIds).not.toContain(addedBeforeFresh);
  });

  test("does not promote an attached but unselected MCP server into workspace defaults", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const session = await createSession(client.db, {
      ...workspace,
      initialMessage: "latent MCP attachment",
      resources: [],
      tools: [],
      toolPolicy: { mode: "workspace_default", inheritedFromSessionId: null },
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const latentServerId = `latent-${crypto.randomUUID()}`;
    await admin`insert into session_mcp_servers (
      account_id, workspace_id, session_id, server_id, url
    ) values (
      ${workspace.accountId}, ${workspace.workspaceId}, ${session.id}, ${latentServerId},
      ${`https://${crypto.randomUUID()}.example.com/mcp`}
    )`;
    const task = await createScheduledTask(client.db, {
      ...workspace,
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      name: "latent MCP target",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `latent-mcp-${crypto.randomUUID()}`,
      runMode: "existing_session",
      targetSessionId: session.id,
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "do not widen", resources: [], tools: [], metadata: {} },
      metadata: {},
    });
    await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `latent-mcp-${crypto.randomUUID()}`,
    });
    const [run] = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10);
    const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: workspace.workspaceId,
      runId: run!.id,
    });
    expect(accepted?.targetSessionExecution?.mcpServerIds).toContain(latentServerId);
    expect(accepted?.targetSessionExecution?.effectiveMcpServerIds).not.toContain(latentServerId);
  });

  test("fences post-claim Variable Set drift before local or host secret reads", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const variableSet = await createVariableSet(client.db, {
      ...workspace,
      scope: "workspace",
      name: `scheduled-materialization-${crypto.randomUUID()}`,
    });
    const settings = testSettings({
      databaseUrl: shared!.appUrl,
      sandboxBackend: "none",
      environmentsEncryptionKey: Buffer.alloc(32, 17).toString("base64"),
    });

    // The worker resolves the exact accepted generation from the run snapshot
    // before it asks a host credential provider for values.
    const hostOptions = async (claimed: {
      dispatched: { sessionId: string };
      claimed: { turn: { id: string; executionGeneration: number } };
      attemptId: string;
    }) => ({
      expectedGeneration: await getScheduledVariableSetExpectedGenerationForAttempt(client.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        subjectId: workspace.subjectId,
        initiatingHumanSubjectId: workspace.subjectId,
        sessionId: claimed.dispatched.sessionId,
        turnId: claimed.claimed.turn.id,
        attemptId: claimed.attemptId,
        executionGeneration: claimed.claimed.turn.executionGeneration,
        variableSetId: variableSet.id,
      }),
    });

    const unchangedLocal = await claimedCommonVariableSetRun(workspace, variableSet.id);
    const local = await loadWorkspaceEnvironmentForRunWithCredentials(
      client.db,
      settings,
      workspace,
      variableSet.id,
      {
        sessionId: unchangedLocal.dispatched.sessionId,
        turnId: unchangedLocal.claimed.turn.id,
        attemptId: unchangedLocal.attemptId,
        executionGeneration: unchangedLocal.claimed.turn.executionGeneration,
        initiatingHumanSubjectId: workspace.subjectId,
      },
    );
    expect(local?.generation).toBe(variableSet.generation);

    const unchangedHost = await claimedCommonVariableSetRun(workspace, variableSet.id);
    let unchangedHostCalls = 0;
    const hosted = await loadWorkspaceEnvironmentForRunWithCredentials(
      client.db,
      settings,
      workspace,
      variableSet.id,
      {
        sessionId: unchangedHost.dispatched.sessionId,
        turnId: unchangedHost.claimed.turn.id,
        attemptId: unchangedHost.attemptId,
        executionGeneration: unchangedHost.claimed.turn.executionGeneration,
        initiatingHumanSubjectId: workspace.subjectId,
      },
      async (request) => {
        unchangedHostCalls += 1;
        return {
          ...request,
          id: request.variableSetId,
          name: "hosted",
          description: null,
          scope: "workspace",
          generation: request.expectedGeneration!,
          values: {},
        };
      },
      await hostOptions(unchangedHost),
    );
    expect(unchangedHostCalls).toBe(1);
    expect(hosted?.generation).toBe(variableSet.generation);

    const changedLocal = await claimedCommonVariableSetRun(workspace, variableSet.id);
    await setVariableSetVariable(client.db, {
      ...workspace,
      variableSetId: variableSet.id,
      name: "CHANGED_LOCAL",
      valueEncrypted: "not-read",
    });
    const errorChainIncludes = (error: unknown, expected: string) => {
      let current: unknown = error;
      for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
        const candidate = current as { message?: string; cause?: unknown };
        if (candidate.message?.includes(expected)) return true;
        current = candidate.cause;
      }
      return false;
    };
    let localError: unknown;
    try {
      await loadWorkspaceEnvironmentForRunWithCredentials(
        client.db,
        settings,
        workspace,
        variableSet.id,
        {
          sessionId: changedLocal.dispatched.sessionId,
          turnId: changedLocal.claimed.turn.id,
          attemptId: changedLocal.attemptId,
          executionGeneration: changedLocal.claimed.turn.executionGeneration,
          initiatingHumanSubjectId: workspace.subjectId,
        },
      );
    } catch (error) {
      localError = error;
    }
    expect(
      errorChainIncludes(localError, "scheduled Variable Set generation changed after claim"),
    ).toBe(true);

    const changedHost = await claimedCommonVariableSetRun(workspace, variableSet.id);
    await setVariableSetVariable(client.db, {
      ...workspace,
      variableSetId: variableSet.id,
      name: "CHANGED_HOST",
      valueEncrypted: "not-read",
    });
    let changedHostCalls = 0;
    let hostError: unknown;
    try {
      await loadWorkspaceEnvironmentForRunWithCredentials(
        client.db,
        settings,
        workspace,
        variableSet.id,
        {
          sessionId: changedHost.dispatched.sessionId,
          turnId: changedHost.claimed.turn.id,
          attemptId: changedHost.attemptId,
          executionGeneration: changedHost.claimed.turn.executionGeneration,
          initiatingHumanSubjectId: workspace.subjectId,
        },
        async (request) => {
          changedHostCalls += 1;
          return {
            ...request,
            id: request.variableSetId,
            name: "must-not-run",
            description: null,
            scope: "workspace",
            generation: request.expectedGeneration!,
            values: {},
          };
        },
        await hostOptions(changedHost),
      );
    } catch (error) {
      hostError = error;
    }
    expect(
      errorChainIncludes(hostError, "scheduled Variable Set generation changed after claim"),
    ).toBe(true);
    expect(changedHostCalls).toBe(0);
  });

  test("revoking accepted user-scoped xAI authority rejects before claim", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    await admin`insert into workspace_memberships (
      account_id, workspace_id, subject_id, role, permissions
    ) values (
      ${workspace.accountId}, ${workspace.workspaceId}, ${workspace.subjectId},
      'owner', '[]'::jsonb
    )`;
    const credential = await createXaiSubscriptionCredential(client.db, {
      ...workspace,
      scope: "user",
      encryptionKey: Buffer.alloc(32, 23),
      secret: { version: 1, accessToken: "scheduled-xai-claim" },
      providerAccountId: `scheduled-xai-${crypto.randomUUID()}`,
      label: "scheduled xAI claim",
    });
    const task = await createScheduledTask(client.db, {
      ...workspace,
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      name: "xAI claim authority",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-xai-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "must retain exact xAI authority",
        resources: [],
        tools: [],
        metadata: {},
        model: "supergrok/grok-4.6",
      },
      xaiProviderAccountAuthoritySnapshot: credential.authoritySnapshot,
      metadata: {},
    });
    const dispatched = await activities({
      supergrokSubscriptionEnabled: true,
    }).dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `scheduled-xai-${crypto.randomUUID()}`,
    });
    if (dispatched.action !== "start") throw new Error(`dispatch ${JSON.stringify(dispatched)}`);
    await disconnectXaiSubscriptionCredential(client.db, {
      ...workspace,
      credentialId: credential.account.id,
      authoritySnapshot: credential.authoritySnapshot,
    });
    const claimed = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed).toEqual({ action: "unclaimed", reason: "no-work" });
    const [evidence] = await admin<
      Array<{ runStatus: string; runError: string | null; updateState: string; attempts: number }>
    >`
      select run.status as "runStatus", run.error as "runError",
        update_value.state as "updateState",
        (select count(*)::int from session_turn_attempts attempt
          where attempt.session_id = run.session_id) as attempts
      from scheduled_task_runs run
      join session_system_updates update_value on update_value.scheduled_task_run_id = run.id
      where run.task_id = ${task.id}
    `;
    expect(evidence).toEqual({
      runStatus: "failed",
      runError: "scheduled_xai_authority_changed",
      updateState: "failed",
      attempts: 0,
    });
  });

  test("revoking an accepted Slack bot rejects before a fresh attempt", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const slackBot = await slackBotConnectionFixture(workspace);
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "claim-time Slack bot revocation",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "must not claim with a revoked Slack bot",
        resources: [],
        tools: [],
        metadata: {},
        slackBotConnectionId: slackBot.id,
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      metadata: {},
    });
    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `claim-revoked-slack-${crypto.randomUUID()}`,
    });
    if (dispatched.action !== "start") throw new Error("scheduled run did not create a session");
    await admin`
      update connections
      set status = 'revoked', version = version + 1,
        verified_install_version = null, updated_at = clock_timestamp()
      where id = ${slackBot.id}
    `;
    const claimed = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed).toEqual({ action: "unclaimed", reason: "no-work" });
    const [evidence] = await admin<
      Array<{ runStatus: string; runError: string | null; updateState: string; attempts: number }>
    >`
      select run.status as "runStatus", run.error as "runError",
        update_value.state as "updateState",
        (select count(*)::int from session_turn_attempts attempt
          where attempt.session_id = run.session_id) as attempts
      from scheduled_task_runs run
      join session_system_updates update_value
        on update_value.scheduled_task_run_id = run.id
      where run.task_id = ${task.id}
    `;
    expect(evidence).toEqual({
      runStatus: "failed",
      runError: "scheduled_slack_bot_changed",
      updateState: "failed",
      attempts: 0,
    });
  });

  test("revalidates the accepted Slack bot before a recovery attempt", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const slackBot = await slackBotConnectionFixture(workspace);
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "recovery Slack bot version drift",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "recover only with the accepted Slack bot",
        resources: [],
        tools: [],
        metadata: {},
        slackBotConnectionId: slackBot.id,
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      metadata: {},
    });
    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `recovery-slack-${crypto.randomUUID()}`,
    });
    if (dispatched.action !== "start") throw new Error("scheduled run did not create a session");
    const firstAttemptId = crypto.randomUUID();
    const first = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: firstAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (first.action !== "claimed") throw new Error("scheduled turn was not initially claimed");
    expect(
      (
        await requestSessionTurnRecovery(client.db, workspace.workspaceId, {
          sessionId: dispatched.sessionId,
          turnId: first.turn.id,
          triggerEventId: first.turn.triggerEventId,
          attemptId: firstAttemptId,
          reason: "test Slack bot recovery fence",
        })
      ).action,
    ).toBe("recovering");
    await admin`
      update connections
      set version = version + 1, verified_install_version = version + 1,
        updated_at = clock_timestamp()
      where id = ${slackBot.id}
    `;
    const second = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(second).toEqual({ action: "unclaimed", reason: "no-work" });
    const [evidence] = await admin<
      Array<{
        runStatus: string;
        runError: string | null;
        updateState: string;
        turnStatus: string;
        attempts: number;
      }>
    >`
      select run.status as "runStatus", run.error as "runError",
        update_value.state as "updateState", turn_value.status as "turnStatus",
        (select count(*)::int from session_turn_attempts attempt
          where attempt.turn_id = turn_value.id) as attempts
      from scheduled_task_runs run
      join session_system_updates update_value
        on update_value.scheduled_task_run_id = run.id
      join session_turns turn_value on turn_value.id = update_value.delivered_turn_id
      where run.task_id = ${task.id}
    `;
    expect(evidence).toEqual({
      runStatus: "failed",
      runError: "scheduled_slack_bot_changed",
      updateState: "delivered",
      turnStatus: "failed",
      attempts: 1,
    });
  });

  test("freezes and admits an activated common connection on real PostgreSQL", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const common = await commonConnectionDelegationFixture(workspace);
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "activated common authority",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Use the frozen common connection",
        resources: [],
        tools: [],
        metadata: {},
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      personalConnectionDelegations: [common.delegation],
      metadata: {},
    });
    const [taskSnapshot] = await admin<Array<{ count: number }>>`
      select count(*)::int as count
      from scheduled_task_connection_authority_snapshots
      where task_id = ${task.id} and task_authority_revision = ${task.authorityRevision}
    `;
    expect(taskSnapshot?.count).toBe(1);

    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `activated-common-${crypto.randomUUID()}`,
    });
    expect(dispatched.action).toBe("start");
    const [runSnapshot] = await admin<Array<{ count: number }>>`
      select count(*)::int as count
      from scheduled_task_run_connection_authority_snapshots snapshot
      join scheduled_task_runs run on run.id = snapshot.run_id
      where run.task_id = ${task.id}
    `;
    expect(runSnapshot?.count).toBe(1);
  });

  test("revoking a common connection after dispatch rejects before turn or attempt claim", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const common = await commonConnectionDelegationFixture(workspace);
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "claim-time common authority revocation",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "must not claim", resources: [], tools: [], metadata: {} },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      personalConnectionDelegations: [common.delegation],
      metadata: {},
    });
    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `claim-revoked-common-${crypto.randomUUID()}`,
    });
    if (dispatched.action !== "start") throw new Error("scheduled run did not create a session");
    await admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
      await tx`select set_config('opengeni.subject_id', ${workspace.subjectId}, true)`;
      await tx`select * from revoke_self_connection_use_grant(
        ${workspace.accountId}::uuid, ${common.grant.id}::uuid
      )`;
    });
    const claimed = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed).toEqual({ action: "unclaimed", reason: "no-work" });
    const [evidence] = await admin<
      Array<{ runStatus: string; runError: string | null; updateState: string; attempts: number }>
    >`
      select run.status as "runStatus", run.error as "runError",
        update_value.state as "updateState",
        (select count(*)::int from session_turn_attempts attempt
          where attempt.session_id = run.session_id) as attempts
      from scheduled_task_runs run
      join session_system_updates update_value
        on update_value.scheduled_task_run_id = run.id
      where run.task_id = ${task.id}
    `;
    expect(evidence).toEqual({
      runStatus: "failed",
      runError: "scheduled_connection_grant_changed",
      updateState: "failed",
      attempts: 0,
    });
  });

  test("suspending the revision authorizer after dispatch rejects common resource work", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const variableSet = await createVariableSet(client.db, {
      ...workspace,
      scope: "workspace",
      name: "claim-time suspended authorizer",
    });
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "claim-time causal suspension",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "must not materialize", resources: [], tools: [], metadata: {} },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      variableSetId: variableSet.id,
      metadata: {},
    });
    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `claim-suspended-authorizer-${crypto.randomUUID()}`,
    });
    if (dispatched.action !== "start") throw new Error("scheduled run did not create a session");
    await admin`
      update organization_memberships
      set status = 'suspended', authorization_revision = authorization_revision + 1,
        updated_at = clock_timestamp()
      where account_id = ${workspace.accountId} and subject_id = ${workspace.subjectId}
    `;
    const claimed = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claimed).toEqual({ action: "unclaimed", reason: "no-work" });
    const [evidence] = await admin<
      Array<{ runStatus: string; runError: string | null; updateState: string; attempts: number }>
    >`
      select run.status as "runStatus", run.error as "runError",
        update_value.state as "updateState",
        (select count(*)::int from session_turn_attempts attempt
          where attempt.session_id = run.session_id) as attempts
      from scheduled_task_runs run
      join session_system_updates update_value
        on update_value.scheduled_task_run_id = run.id
      where run.task_id = ${task.id}
    `;
    expect(evidence).toEqual({
      runStatus: "failed",
      runError: "scheduled_causal_membership_changed",
      updateState: "failed",
      attempts: 0,
    });
  });

  test("a recovering scheduled turn revalidates common authority before a new attempt", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const common = await commonConnectionDelegationFixture(workspace);
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "recovery claim-time revocation",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "recover only while live", resources: [], tools: [], metadata: {} },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      personalConnectionDelegations: [common.delegation],
      metadata: {},
    });
    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `recovery-revoked-common-${crypto.randomUUID()}`,
    });
    if (dispatched.action !== "start") throw new Error("scheduled run did not create a session");
    const firstAttemptId = crypto.randomUUID();
    const first = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: firstAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (first.action !== "claimed") throw new Error("scheduled turn was not initially claimed");
    const recovery = await requestSessionTurnRecovery(client.db, workspace.workspaceId, {
      sessionId: dispatched.sessionId,
      turnId: first.turn.id,
      triggerEventId: first.turn.triggerEventId,
      attemptId: firstAttemptId,
      reason: "test authority recovery fence",
    });
    expect(recovery.action).toBe("recovering");
    await admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
      await tx`select set_config('opengeni.subject_id', ${workspace.subjectId}, true)`;
      await tx`select * from revoke_self_connection_use_grant(
        ${workspace.accountId}::uuid, ${common.grant.id}::uuid
      )`;
    });
    const second = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(second).toEqual({ action: "unclaimed", reason: "no-work" });
    const [evidence] = await admin<
      Array<{
        runStatus: string;
        runError: string | null;
        updateState: string;
        turnStatus: string;
        attempts: number;
      }>
    >`
      select run.status as "runStatus", run.error as "runError",
        update_value.state as "updateState", turn_value.status as "turnStatus",
        (select count(*)::int from session_turn_attempts attempt
          where attempt.turn_id = turn_value.id) as attempts
      from scheduled_task_runs run
      join session_system_updates update_value
        on update_value.scheduled_task_run_id = run.id
      join session_turns turn_value on turn_value.id = update_value.delivered_turn_id
      where run.task_id = ${task.id}
    `;
    expect(evidence).toEqual({
      runStatus: "failed",
      runError: "scheduled_connection_grant_changed",
      updateState: "delivered",
      turnStatus: "failed",
      attempts: 1,
    });
  });

  test("concurrent cold reusable common-authority runs adopt one exact session", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const common = await commonConnectionDelegationFixture(workspace);
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "concurrent cold common authority",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Converge concurrent accepted runs",
        resources: [],
        tools: [],
        metadata: {},
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      personalConnectionDelegations: [common.delegation],
      metadata: {},
    });

    const [first, second] = await Promise.all([
      activities().dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `cold-common-a-${crypto.randomUUID()}`,
      }),
      activities().dispatchScheduledTaskRun({
        workspaceId: workspace.workspaceId,
        taskId: task.id,
        triggerType: "scheduled",
        producerKey: `cold-common-b-${crypto.randomUUID()}`,
      }),
    ]);
    expect(first.sessionId).toBe(second.sessionId);
    expect(new Set([first.action, second.action])).toEqual(new Set(["start", "signal"]));
    const [evidence] = await admin<Array<{ runs: number; sessions: number }>>`
      select count(distinct run.id)::int as runs,
        count(distinct run.session_id)::int as sessions
      from scheduled_task_runs run
      where run.task_id = ${task.id}
    `;
    expect(evidence).toEqual({ runs: 2, sessions: 1 });
  });

  test("a revoked frozen grant creates one stable terminal producer receipt", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const common = await commonConnectionDelegationFixture(workspace);
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "revoked accepted common authority",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Do not run after authority revocation",
        resources: [],
        tools: [],
        metadata: {},
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      personalConnectionDelegations: [common.delegation],
      metadata: {},
    });
    await admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
      await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
      await tx`select set_config('opengeni.subject_id', ${workspace.subjectId}, true)`;
      await tx`
        select * from revoke_self_connection_use_grant(
          ${workspace.accountId}::uuid, ${common.grant.id}::uuid
        )
      `;
    });

    const producerKey = `revoked-common-${crypto.randomUUID()}`;
    const first = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey,
    });
    const replay = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey,
    });
    expect(first).toEqual({ action: "blocked", reason: "scheduled_run_terminal" });
    expect(replay).toEqual(first);
    const [evidence] = await admin<
      Array<{ runs: number; sessions: number; status: string; error: string }>
    >`
      select count(*)::int as runs,
        (select count(*)::int from sessions where workspace_id = ${workspace.workspaceId})
          as sessions,
        min(status) as status, min(error) as error
      from scheduled_task_runs
      where workspace_id = ${workspace.workspaceId} and producer_key = ${producerKey}
    `;
    expect(evidence).toEqual({
      runs: 1,
      sessions: 0,
      status: "failed",
      error: "scheduled_run_authority_proof_rejected",
    });
  });

  test("a queued run recovers from its immutable snapshot after the task head changes", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const settings = testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" });
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "recover accepted run",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "accepted prompt",
        resources: [],
        tools: [],
        metadata: {},
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      metadata: {},
    });
    const producerKey = `scheduled-recovery-${crypto.randomUUID()}`;
    const runId = crypto.randomUUID();
    const causalHumanAuthority = await getScheduledTaskRevisionAuthority(client.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
    });
    expect(causalHumanAuthority).not.toBeNull();
    const depthPolicy = await getNestedAgentDepthDeploymentPolicy(client.db);
    const resolvedTools = [{ kind: "mcp" as const, id: "opengeni" }];
    const run = await createScheduledTaskRun(client.db, {
      runId,
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
      taskExecutionDigest: task.executionDigest,
      triggerType: "scheduled",
      producerKey,
      acceptedExecutionSnapshot: {
        version: 1,
        task,
        resolvedModel: settings.openaiModel,
        resolvedReasoningEffort: settings.openaiReasoningEffort,
        resolvedLatencyMode: "standard",
        resolvedSandboxBackend: "none",
        resolvedSandboxOs: "linux",
        resolvedTools,
        resolvedFirstPartyMcpTools: resolveFirstPartyMcpToolPolicy(settings).default,
        resolvedFirstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
        resolvedVariableSet: null,
        resolvedRig: null,
        resolvedSlackBotConnection: null,
        targetSessionExecution: null,
        generatedSessionBinding: {
          createIdempotencyKey: `scheduled-task-run:${runId}`,
          effectiveMaxNestedAgentDepth: depthPolicy.maxNestedAgentDepth,
          nestedAgentDepthPolicySource: depthPolicy.policySource,
          codexCompactionMode: "portable",
        },
        personalConnectionDelegations: [],
        personalResourceAuthoritySubjectId: null,
        causalHumanSubjectId: causalHumanAuthority!.subjectId,
        causalHumanAuthority,
        xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
        xaiAuthoritySubjectId: null,
        connectionAuthoritySubjectId: null,
        triggerInitiator: { kind: "service", subjectId: "scheduler" },
        agentRunUsageIdempotencyKey: null,
        incidentPreflightRequired: false,
        alertOccurrenceLabels: null,
      },
    });
    const session = await createSession(client.db, {
      ...workspace,
      initialMessage: task.agentConfig.prompt,
      resources: [],
      tools: resolvedTools,
      firstPartyMcpTools: resolveFirstPartyMcpToolPolicy(settings).default,
      firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      metadata: {
        model: settings.openaiModel,
        reasoningEffort: settings.openaiReasoningEffort,
        scheduledTaskId: task.id,
        scheduledTaskRunId: run.id,
        scheduledTaskRunMode: "new_session_per_run",
      },
      model: settings.openaiModel,
      reasoningEffort: settings.openaiReasoningEffort,
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: {
        kind: "service",
        subjectId: "scheduler",
        label: "OpenGeni scheduler",
      },
      createdByContext: { scheduledTaskId: task.id, scheduledTaskRunId: run.id },
      createIdempotencyKey: `scheduled-task-run:${run.id}`,
      maxNestedAgentDepthOverride: null,
      frozenNestedAgentDepthPolicy: {
        effectiveMaxNestedAgentDepth: depthPolicy.maxNestedAgentDepth,
        nestedAgentDepthPolicySource: depthPolicy.policySource,
      },
      frozenCodexCompactionMode: "portable",
      beforeCreateCommit: async (tx, sessionId) => {
        await bindScheduledTaskRunSessionInTransaction(tx, {
          accountId: workspace.accountId,
          workspaceId: workspace.workspaceId,
          runId: run.id,
          sessionId,
        });
      },
    });
    await updateScheduledTask(client.db, workspace.workspaceId, task.id, {
      agentConfig: { ...task.agentConfig, prompt: "new mutable prompt" },
    });

    const recovered = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey,
    });
    expect(recovered).toMatchObject({ action: "start", sessionId: session.id });
    const [stored] = await admin<Array<{ summary: string }>>`
      select summary from session_system_updates
      where scheduled_task_run_id = ${run.id}
    `;
    expect(stored?.summary).toBe("accepted prompt");
  });

  test("a hostile reusable create-key preclaim cannot bind scheduled work", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const settings = testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" });
    const depthPolicy = await getNestedAgentDepthDeploymentPolicy(client.db);
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "hostile create-key preclaim",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "accepted prompt", resources: [], tools: [], metadata: {} },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      metadata: {},
    });
    const runId = crypto.randomUUID();
    const producerKey = `hostile-preclaim-${crypto.randomUUID()}`;
    const createIdempotencyKey = `scheduled-task-reusable:${task.id}:${task.authorityRevision}:${task.executionDigest}`;
    const resolvedTools = [{ kind: "mcp" as const, id: "opengeni" }];
    const causalHumanAuthority = await getScheduledTaskRevisionAuthority(client.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
    });
    expect(causalHumanAuthority).not.toBeNull();
    await createScheduledTaskRun(client.db, {
      runId,
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
      taskExecutionDigest: task.executionDigest,
      triggerType: "scheduled",
      producerKey,
      acceptedExecutionSnapshot: {
        version: 1,
        task,
        resolvedModel: settings.openaiModel,
        resolvedReasoningEffort: settings.openaiReasoningEffort,
        resolvedLatencyMode: "standard",
        resolvedSandboxBackend: "none",
        resolvedSandboxOs: "linux",
        resolvedTools,
        resolvedFirstPartyMcpTools: resolveFirstPartyMcpToolPolicy(settings).default,
        resolvedFirstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
        resolvedVariableSet: null,
        resolvedRig: null,
        resolvedSlackBotConnection: null,
        targetSessionExecution: null,
        generatedSessionBinding: {
          createIdempotencyKey,
          effectiveMaxNestedAgentDepth: depthPolicy.maxNestedAgentDepth,
          nestedAgentDepthPolicySource: depthPolicy.policySource,
          codexCompactionMode: "portable",
        },
        personalConnectionDelegations: [],
        personalResourceAuthoritySubjectId: null,
        causalHumanSubjectId: causalHumanAuthority!.subjectId,
        causalHumanAuthority,
        xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
        xaiAuthoritySubjectId: null,
        connectionAuthoritySubjectId: null,
        triggerInitiator: { kind: "service", subjectId: "scheduler" },
        agentRunUsageIdempotencyKey: null,
        incidentPreflightRequired: false,
        alertOccurrenceLabels: null,
      },
    });
    const hostile = await createSession(client.db, {
      ...workspace,
      initialMessage: task.agentConfig.prompt,
      instructions: "hostile instructions",
      resources: [],
      tools: resolvedTools,
      firstPartyMcpTools: resolveFirstPartyMcpToolPolicy(settings).default,
      firstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      metadata: {
        model: settings.openaiModel,
        reasoningEffort: settings.openaiReasoningEffort,
        scheduledTaskId: task.id,
        scheduledTaskRunId: runId,
        scheduledTaskRunMode: task.runMode,
      },
      createdBy: {
        kind: "service",
        subjectId: "scheduler",
        label: "OpenGeni scheduler",
      },
      createdByContext: { scheduledTaskId: task.id, scheduledTaskRunId: runId },
      model: settings.openaiModel,
      reasoningEffort: settings.openaiReasoningEffort,
      latencyMode: "standard",
      sandboxBackend: "none",
      createIdempotencyKey,
      maxNestedAgentDepthOverride: null,
      frozenNestedAgentDepthPolicy: {
        effectiveMaxNestedAgentDepth: depthPolicy.maxNestedAgentDepth,
        nestedAgentDepthPolicySource: depthPolicy.policySource,
      },
      frozenCodexCompactionMode: "portable",
    });

    const result = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey,
    });
    expect(result).toEqual({ action: "blocked", reason: "scheduled_run_terminal" });
    const [evidence] = await admin<
      Array<{ status: string; session_id: string | null; updates: number }>
    >`
      select run.status, run.session_id,
        (select count(*)::int from session_system_updates update_value
          where update_value.scheduled_task_run_id = run.id) as updates
      from scheduled_task_runs run where run.id = ${runId}
    `;
    expect(evidence).toEqual({ status: "failed", session_id: null, updates: 0 });
    expect(hostile.instructions).toBe("hostile instructions");
  });

  test("an accepted occurrence keeps the task snapshot even if the task changes afterward", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const acceptedDelegations = delegation(workspace.subjectId, "linear", "linear.app");
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "freeze accepted occurrence",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Run with the accepted personal connection snapshot",
        resources: [],
        tools: [],
        metadata: {},
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      personalConnectionDelegations: acceptedDelegations,
      metadata: {},
    });

    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `accepted-occurrence-${crypto.randomUUID()}`,
    });
    expect(dispatched.action).toBe("start");

    const laterDelegations = delegation(workspace.subjectId, "github", "github.com");
    await updateScheduledTask(client.db, workspace.workspaceId, task.id, {
      personalConnectionDelegations: laterDelegations,
      agentConfig: {
        ...task.agentConfig,
        prompt: "Changed only after the earlier occurrence was accepted",
      },
    });

    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, workspace.workspaceId, {
      sessionId: dispatched.sessionId,
      workflowId: dispatched.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("scheduled occurrence was not claimed");
    expect(claimed.turn.personalConnectionDelegations).toEqual(acceptedDelegations);
    expect(
      await listSessionSystemUpdatesForTurn(
        client.db,
        workspace.workspaceId,
        dispatched.sessionId,
        claimed.turn.id,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "scheduled_occurrence",
        summary: "Run with the accepted personal connection snapshot",
      }),
    ]);

    const [stored] = await admin<
      Array<{
        session_authority: McpPersonalConnectionDelegation[];
        occurrence_authority: McpPersonalConnectionDelegation[];
      }>
    >`
      select
        sessions.initial_personal_connection_delegations as session_authority,
        updates.personal_connection_delegations as occurrence_authority
      from sessions
      join session_system_updates updates on updates.session_id = sessions.id
      where sessions.id = ${dispatched.sessionId}
        and updates.kind = 'scheduled_occurrence'
    `;
    expect(stored).toEqual({
      session_authority: [],
      occurrence_authority: acceptedDelegations,
    });
    expect(
      await getScheduledTaskPersonalConnectionDelegations(
        client.db,
        workspace.workspaceId,
        task.id,
      ),
    ).toEqual(laterDelegations);
  });

  test("Temporal sync failure restores every execution-affecting task field", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const originalDelegations = delegation(workspace.subjectId, "linear", "linear.app");
    const variableSet = await createVariableSet(client.db, {
      ...workspace,
      name: "scheduled restore variables",
    });
    const rig = await createRig(client.db, {
      ...workspace,
      name: "scheduled restore rig",
      createdBy: workspace.subjectId,
    });
    const reusableSession = await createSession(client.db, {
      ...workspace,
      initialMessage: "reusable scheduled session",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const created = await createScheduledTask(client.db, {
      ...workspace,
      name: "restore complete task snapshot",
      status: "paused",
      schedule: { type: "interval", everySeconds: 1_800 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "buffer_one",
      agentConfig: {
        prompt: "original prompt",
        resources: [],
        tools: [],
        metadata: { version: "original" },
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      personalConnectionDelegations: originalDelegations,
      variableSetId: variableSet.id,
      rigId: rig.id,
      metadata: { version: "original" },
    });
    const original = await updateScheduledTask(client.db, workspace.workspaceId, created.id, {
      reusableSessionId: reusableSession.id,
    });
    const restoreState = await captureScheduledTaskRestoreState(client.db, original);
    const changedDelegations = delegation(workspace.subjectId, "github", "github.com");
    const changed = await updateScheduledTask(client.db, workspace.workspaceId, original.id, {
      name: "changed name",
      status: "active",
      schedule: { type: "interval", everySeconds: 7_200 },
      runMode: "new_session_per_run",
      overlapPolicy: "skip",
      agentConfig: {
        prompt: "changed prompt",
        resources: [],
        tools: [],
        metadata: { version: "changed" },
      },
      personalConnectionDelegations: changedDelegations,
      targetSessionId: null,
      reusableSessionId: null,
      variableSetId: null,
      rigId: null,
      metadata: { version: "changed" },
    });

    await expect(
      syncUpdatedScheduledTask({
        db: client.db,
        previous: restoreState,
        task: changed,
        workflowClient: {
          syncScheduledTask: async () => {
            throw new Error("expected Temporal synchronization failure");
          },
        } as never,
      }),
    ).rejects.toThrow("expected Temporal synchronization failure");

    const restored = await getScheduledTask(client.db, workspace.workspaceId, original.id);
    expect(restored).toMatchObject({
      name: original.name,
      status: original.status,
      schedule: original.schedule,
      runMode: original.runMode,
      overlapPolicy: original.overlapPolicy,
      agentConfig: original.agentConfig,
      reusableSessionId: reusableSession.id,
      variableSetId: variableSet.id,
      rigId: rig.id,
      metadata: original.metadata,
    });
    expect(
      await getScheduledTaskPersonalConnectionDelegations(
        client.db,
        workspace.workspaceId,
        original.id,
      ),
    ).toEqual(originalDelegations);
  });

  test("a materialized reusable workspace Variable Set task keeps its causal human on the next occurrence", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const variableSet = await createVariableSet(client.db, {
      ...workspace,
      scope: "workspace",
      name: "reusable workspace variables",
    });
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "reusable workspace Variable Set",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "reusable_session",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Use the workspace Variable Set",
        resources: [],
        tools: [],
        metadata: {},
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      variableSetId: variableSet.id,
      metadata: {},
    });
    const sourceAuthority = await getScheduledTaskRevisionAuthority(client.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      taskAuthorityRevision: task.authorityRevision,
    });
    expect(sourceAuthority?.subjectId).toBe(workspace.subjectId);

    const first = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `reusable-vs-1-${crypto.randomUUID()}`,
    });
    expect(first.action).toBe("start");
    const materialized = await getScheduledTask(client.db, workspace.workspaceId, task.id);
    expect(materialized?.reusableSessionId).toBe(first.sessionId!);
    expect(materialized?.authorityRevision).toBeGreaterThan(task.authorityRevision);
    const headAuthority = await getScheduledTaskRevisionAuthority(client.db, {
      accountId: task.accountId,
      workspaceId: task.workspaceId,
      taskId: task.id,
      taskAuthorityRevision: materialized!.authorityRevision,
    });
    expect(headAuthority).toEqual(sourceAuthority);

    const second = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `reusable-vs-2-${crypto.randomUUID()}`,
    });
    expect(["start", "signal"]).toContain(second.action);
    expect(second.sessionId).toBe(first.sessionId);
    const runs = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
        workspaceId: workspace.workspaceId,
        runId: run.id,
      });
      expect(accepted?.causalHumanSubjectId).toBe(workspace.subjectId);
      expect(accepted?.causalHumanAuthority).toEqual(sourceAuthority);
      // The cold occurrence resolves the Variable Set itself; the warm one
      // inherits it from the materialized target session.
      expect(
        accepted?.resolvedVariableSet?.id ?? accepted?.targetSessionExecution?.variableSetId,
      ).toBe(variableSet.id);
    }
  });

  test("a non-human writer automates plain and workspace-secret tasks but cannot author a personal one", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const serviceSubjectId = `service-writer-${crypto.randomUUID()}`;
    const [membership] = await admin<Array<{ count: number }>>`
      select count(*)::int as count from organization_memberships
      where account_id = ${workspace.accountId} and subject_id = ${serviceSubjectId}`;
    expect(membership?.count).toBe(0);
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "service-authored plain task",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "service authored prompt", resources: [], tools: [], metadata: {} },
      createdBy: { kind: "service", subjectId: serviceSubjectId },
      metadata: {},
    });
    expect(task.createdBy).toMatchObject({ kind: "service", subjectId: serviceSubjectId });
    expect(
      await getScheduledTaskRevisionAuthority(client.db, {
        accountId: task.accountId,
        workspaceId: task.workspaceId,
        taskId: task.id,
        taskAuthorityRevision: task.authorityRevision,
      }),
    ).toBeNull();
    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `service-plain-${crypto.randomUUID()}`,
    });
    expect(dispatched.action).toBe("start");
    const [run] = await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10);
    const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: workspace.workspaceId,
      runId: run!.id,
    });
    expect(accepted?.causalHumanSubjectId).toBeNull();
    expect(accepted?.causalHumanAuthority).toBeNull();

    // A workspace Variable Set is ordinary workspace authority: a non-human
    // writer may keep automating with it, exactly as before the cutover.
    const variableSet = await createVariableSet(client.db, {
      ...workspace,
      scope: "workspace",
      name: "service writer workspace variables",
    });
    const secretsTask = await createScheduledTask(client.db, {
      ...workspace,
      name: "service-authored workspace secrets task",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "service authored secrets", resources: [], tools: [], metadata: {} },
      createdBy: { kind: "service", subjectId: serviceSubjectId },
      variableSetId: variableSet.id,
      metadata: {},
    });
    const secretsDispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: secretsTask.id,
      triggerType: "scheduled",
      producerKey: `service-workspace-secrets-${crypto.randomUUID()}`,
    });
    expect(secretsDispatched.action).toBe("start");
    const [secretsRun] = await listScheduledTaskRuns(
      client.db,
      workspace.workspaceId,
      secretsTask.id,
      10,
    );
    const secretsAccepted = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: workspace.workspaceId,
      runId: secretsRun!.id,
    });
    expect(secretsAccepted?.resolvedVariableSet?.id).toBe(variableSet.id);
    expect(secretsAccepted?.causalHumanSubjectId).toBeNull();

    // A personal (user-scoped) authority is different: it needs the exact human
    // who owns it, so a non-human writer fails closed at create.
    let failure: unknown;
    try {
      await createScheduledTask(client.db, {
        ...workspace,
        name: "service-authored personal task",
        status: "active",
        schedule: { type: "interval", everySeconds: 3_600 },
        temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: {
          prompt: "service authored personal",
          resources: [],
          tools: [],
          metadata: {},
        },
        createdBy: { kind: "service", subjectId: serviceSubjectId },
        xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "user", authorityGeneration: 1 },
        metadata: {},
      });
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("42501");
    const [stored] = await admin<Array<{ count: number }>>`
      select count(*)::int as count from scheduled_tasks
      where workspace_id = ${workspace.workspaceId}
        and name = 'service-authored personal task'`;
    expect(stored?.count).toBe(0);
  });

  test("a legacy task whose accepted execution is unrepresentable is blocked without side effects", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const oversizePrompt = "x".repeat(SCHEDULED_TASK_ACCEPTED_EXECUTION_MAX_BYTES + 100 * 1024);
    expect(Buffer.byteLength(oversizePrompt, "utf8")).toBeGreaterThan(
      SCHEDULED_TASK_ACCEPTED_EXECUTION_MAX_BYTES,
    );
    const oversizeTaskId = await insertLegacyScheduledTask(workspace, oversizePrompt);
    const stored = await getScheduledTask(client.db, workspace.workspaceId, oversizeTaskId);
    expect(stored?.agentConfig.prompt).toBe(oversizePrompt);

    const producerKey = `legacy-oversize-${crypto.randomUUID()}`;
    const first = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: oversizeTaskId,
      triggerType: "scheduled",
      producerKey,
    });
    expect(first).toEqual({ action: "blocked", reason: "scheduled_execution_unrepresentable" });
    const replay = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: oversizeTaskId,
      triggerType: "scheduled",
      producerKey: `legacy-oversize-${crypto.randomUUID()}`,
    });
    expect(replay).toEqual(first);
    const [evidence] = await admin<Array<{ runs: number; sessions: number }>>`
      select
        (select count(*)::int from scheduled_task_runs where task_id = ${oversizeTaskId}) as runs,
        (select count(*)::int from sessions where workspace_id = ${workspace.workspaceId})
          as sessions`;
    expect(evidence).toEqual({ runs: 0, sessions: 0 });
  });

  test("a legacy prompt above the occurrence payload bound is blocked; one within it dispatches", async () => {
    if (!available) return;
    // Delivery is one durable internal update, so a stored prompt that can
    // never fit that payload settles as a visible block instead of a retrying
    // activity failure that would leave an orphaned queued run and session.
    const oversizeWorkspace = await workspaceFixture();
    const oversizePrompt = "y".repeat(SCHEDULED_TASK_OCCURRENCE_PAYLOAD_MAX_BYTES + 36 * 1024);
    const oversizeTaskId = await insertLegacyScheduledTask(oversizeWorkspace, oversizePrompt);
    expect(
      await activities().dispatchScheduledTaskRun({
        workspaceId: oversizeWorkspace.workspaceId,
        taskId: oversizeTaskId,
        triggerType: "scheduled",
        producerKey: `legacy-oversize-payload-${crypto.randomUUID()}`,
      }),
    ).toEqual({ action: "blocked", reason: "scheduled_execution_unrepresentable" });
    const [oversizeEvidence] = await admin<Array<{ runs: number; sessions: number }>>`
      select
        (select count(*)::int from scheduled_task_runs where task_id = ${oversizeTaskId}) as runs,
        (select count(*)::int from sessions
          where workspace_id = ${oversizeWorkspace.workspaceId}) as sessions`;
    expect(oversizeEvidence).toEqual({ runs: 0, sessions: 0 });

    // A stored prompt that fits the occurrence payload is legacy truth the
    // ingress schema must not retroactively brick, whatever its exact size.
    const workspace = await workspaceFixture();
    const largePrompt = "y".repeat(SCHEDULED_TASK_OCCURRENCE_PAYLOAD_MAX_BYTES - 4 * 1024);
    const taskId = await insertLegacyScheduledTask(workspace, largePrompt);
    const dispatched = await activities().dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId,
      triggerType: "scheduled",
      producerKey: `legacy-large-${crypto.randomUUID()}`,
    });
    expect(dispatched.action).toBe("start");
    const [evidence] = await admin<
      Array<{ runs: number; runStatuses: string[] | null; sessions: number; updates: number }>
    >`
      select
        (select count(*)::int from scheduled_task_runs where task_id = ${taskId}) as runs,
        (select array_agg(status order by created_at) from scheduled_task_runs
          where task_id = ${taskId}) as "runStatuses",
        (select count(*)::int from sessions where workspace_id = ${workspace.workspaceId})
          as sessions,
        (select count(*)::int from session_system_updates
          where workspace_id = ${workspace.workspaceId}) as updates`;
    expect(evidence).toEqual({ runs: 1, runStatuses: ["dispatched"], sessions: 1, updates: 1 });
    const [run] = await listScheduledTaskRuns(client.db, workspace.workspaceId, taskId, 10);
    const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: workspace.workspaceId,
      runId: run!.id,
    });
    expect(accepted?.task.agentConfig.prompt).toBe(largePrompt);
  });
});

async function insertLegacyScheduledTask(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  prompt: string,
): Promise<string> {
  const taskId = crypto.randomUUID();
  await admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
    await tx`select set_config('opengeni.subject_id', ${workspace.subjectId}, true)`;
    await tx`
      insert into scheduled_tasks (
        id, account_id, workspace_id, name, status, schedule,
        temporal_schedule_id, run_mode, overlap_policy, action, agent_config,
        created_by_kind, created_by_subject_id, created_by_context,
        personal_connection_delegations, metadata
      ) values (
        ${taskId}, ${workspace.accountId}, ${workspace.workspaceId},
        ${`legacy ${prompt.length}`}, 'active',
        ${tx.json({ type: "interval", everySeconds: 3_600 })}::jsonb,
        ${`legacy-${taskId}`}, 'new_session_per_run', 'allow_concurrent',
        ${tx.json({ kind: "agent_turn" })}::jsonb,
        ${tx.json({ prompt, resources: [], tools: [], metadata: {} })}::jsonb,
        'subject', ${workspace.subjectId}, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb
      )`;
  });
  return taskId;
}
