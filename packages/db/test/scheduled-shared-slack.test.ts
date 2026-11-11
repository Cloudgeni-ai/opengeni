import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OpenGeniSlackBotConnectionMetadata,
} from "@opengeni/contracts";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createDb,
  createConnection,
  createScheduledTask,
  createScheduledTaskRun,
  getNestedAgentDepthDeploymentPolicy,
  nestedPostgresSqlState,
} from "../src";
import { withRlsContext, rawRows } from "../src/database";
import { availableSlackBotConnectionMetadata } from "../src/organization-slack-bots";
import { migrate } from "../src/migrate";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";
import { provisionRoles } from "../src/provision-roles";

test("shared Slack bot schedules admit and recheck exact live sharing under FORCE RLS", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("scheduled-shared-slack");
  if (!owned) throw new Error("PostgreSQL required");
  let client: ReturnType<typeof createDb> | undefined;
  try {
    await migrate(owned.ownerUrl);
    await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
    const appUrl = new URL(owned.ownerUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = owned.appPassword;
    client = createDb(appUrl.toString());
    await assertRuntimeDatabasePosture(client.db, {
      rlsStrategy: "force",
      expectedRole: "opengeni_app",
      targetSchema: "public",
    });
    const accountId = crypto.randomUUID();
    const home = { accountId, workspaceId: crypto.randomUUID() };
    const target = { accountId, workspaceId: crypto.randomUUID() };
    await owned.admin`insert into managed_accounts(id,name) values (${accountId},'Bot schedule QA')`;
    for (const scope of [home, target]) {
      await owned.admin`insert into workspaces(id,account_id,name,settings) values (${scope.workspaceId},${accountId},'Bot workspace','{}')`;
      await owned.admin`insert into workspace_inference_controls(account_id,workspace_id) values (${accountId},${scope.workspaceId})`;
    }
    const bot = await createConnection(client.db, {
      ...home,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "app_install",
      credentialEncrypted: "fixture",
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
      verifiedInstallAt: new Date(),
      verifiedInstallVersion: 1,
      metadata: {
        credentialRole: "opengeni_slack_bot",
        credentialLabel: "OpenGeni Slack bot",
        slackTeamId: "T0SCHEDULE",
        slackTeamName: "Schedule fixture",
        botId: "B0SCHEDULE",
        botUserId: "U0SCHEDULE",
        botDisplayName: "OpenGeni",
        verifiedAt: new Date().toISOString(),
      },
      createdBySubjectId: "user:owner",
    });
    await owned.admin`insert into opengeni_private.organization_slack_bot_access(connection_id,account_id,home_workspace_id,enabled,generation,updated_by_subject_id) values (${bot.id},${accountId},${home.workspaceId},true,1,'user:owner')`;
    const connection = (await availableSlackBotConnectionMetadata(client.db, target))[0]!;
    expect(connection.id).toBe(bot.id);
    expect(connection.metadata.organizationSharingGeneration).toBe(1);
    const task = await createScheduledTask(client.db, {
      ...target,
      name: "Shared bot schedule",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `qa-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Post as the selected bot",
        resources: [],
        tools: [],
        metadata: {},
        slackBotConnectionId: bot.id,
      },
      createdBy: { kind: "service", subjectId: "scheduler" },
      metadata: {},
    });
    const depthPolicy = await getNestedAgentDepthDeploymentPolicy(client.db);
    const runId = crypto.randomUUID();
    const acceptedExecution = {
      version: 1 as const,
      task,
      resolvedModel: "scripted-model",
      resolvedReasoningEffort: "medium" as const,
      resolvedLatencyMode: "standard" as const,
      resolvedSandboxBackend: "none" as const,
      resolvedSandboxOs: "linux" as const,
      resolvedTools: [],
      resolvedFirstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      resolvedFirstPartyMcpPermissions: [...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS],
      resolvedVariableSet: null,
      resolvedRig: null,
      resolvedSlackBotConnection: {
        id: connection.id,
        version: connection.version,
        verifiedInstallVersion: connection.verifiedInstallVersion!,
        metadata: OpenGeniSlackBotConnectionMetadata.parse(connection.metadata),
      },
      targetSessionExecution: null,
      generatedSessionBinding: {
        createIdempotencyKey: `scheduled-task-run:${runId}`,
        effectiveMaxNestedAgentDepth: depthPolicy.maxNestedAgentDepth,
        nestedAgentDepthPolicySource: depthPolicy.policySource,
        codexCompactionMode: "portable" as const,
      },
      personalConnectionDelegations: [],
      personalResourceAuthoritySubjectId: null,
      causalHumanSubjectId: null,
      causalHumanAuthority: null,
      xaiProviderAccountAuthoritySnapshot: { version: 1 as const, scope: "workspace" as const },
      claudeProviderAccountAuthoritySnapshot: { version: 1 as const, scope: "workspace" as const },
      claudeAuthoritySubjectId: null,
      xaiAuthoritySubjectId: null,
      connectionAuthoritySubjectId: null,
      triggerInitiator: { kind: "service" as const, subjectId: "scheduler" },
      agentRunUsageIdempotencyKey: null,
      incidentPreflightRequired: false,
      alertOccurrenceLabels: null,
    };

    const admit = (snapshot = acceptedExecution) =>
      createScheduledTaskRun(client!.db, {
        runId: crypto.randomUUID(),
        workspaceId: snapshot.task.workspaceId,
        taskId: snapshot.task.id,
        taskAuthorityRevision: snapshot.task.authorityRevision,
        taskExecutionDigest: snapshot.task.executionDigest,
        triggerType: "scheduled",
        producerKey: crypto.randomUUID(),
        acceptedExecutionSnapshot: snapshot,
      });
    const run = await admit();
    expect(run.status).toBe("queued");
    const live = async (selectedRunId = run.id, scope = target) =>
      withRlsContext(client!.db, scope, async (tx) => {
        const [row] = await rawRows<{ denial: string | null }>(
          tx,
          sql`select validate_scheduled_agent_run_live_authority(${accountId}::uuid,${scope.workspaceId}::uuid,${selectedRunId}::uuid) as denial`,
        );
        const [context] = await rawRows<{ workspace: string }>(
          tx,
          sql`select current_setting('opengeni.workspace_id') as workspace`,
        );
        expect(context!.workspace).toBe(scope.workspaceId);
        return row!.denial;
      });
    expect(await live()).toBeNull();
    await owned.admin`update opengeni_private.organization_slack_bot_access set generation=2 where connection_id=${bot.id}`;
    expect(await live()).toBe("scheduled_slack_bot_changed");
    const rejected = async (snapshot = acceptedExecution) => {
      const error = await admit(snapshot).then(
        () => null,
        (caught) => caught,
      );
      expect(nestedPostgresSqlState(error)).toBe("40001");
    };
    await rejected();
    await owned.admin`update opengeni_private.organization_slack_bot_access set generation=1,workspace_ids=${[target.workspaceId]}::uuid[] where connection_id=${bot.id}`;
    expect(await live()).toBeNull();
    await admit();
    await owned.admin`update opengeni_private.organization_slack_bot_access set workspace_ids=${[home.workspaceId]}::uuid[] where connection_id=${bot.id}`;
    expect(await live()).toBe("scheduled_slack_bot_changed");
    await rejected();
    await owned.admin`update opengeni_private.organization_slack_bot_access set workspace_ids=null,enabled=false where connection_id=${bot.id}`;
    expect(await live()).toBe("scheduled_slack_bot_changed");
    await rejected();
    await owned.admin`update opengeni_private.organization_slack_bot_access set enabled=true where connection_id=${bot.id}`;
    expect(await live()).toBeNull();
    // An intact, usable alternative installation must not replace the selected bot.
    const alternative = await createConnection(client.db, {
      ...target,
      subjectId: null,
      providerDomain: "slack.com",
      kind: "app_install",
      credentialEncrypted: "alternative",
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
      verifiedInstallAt: new Date(),
      verifiedInstallVersion: 1,
      metadata: { ...bot.metadata, slackTeamId: "T0OTHER", botId: "B0OTHER", botUserId: "U0OTHER" },
      createdBySubjectId: "user:owner",
    });
    await rejected({
      ...acceptedExecution,
      resolvedSlackBotConnection: {
        id: alternative.id,
        version: alternative.version,
        verifiedInstallVersion: 1,
        metadata: OpenGeniSlackBotConnectionMetadata.parse(alternative.metadata),
      },
    });
    await rejected({
      ...acceptedExecution,
      resolvedSlackBotConnection: { ...acceptedExecution.resolvedSlackBotConnection, version: 2 },
    });
    // Missing sharing generation cannot turn a remote installation into a local one.
    await rejected({
      ...acceptedExecution,
      resolvedSlackBotConnection: {
        ...acceptedExecution.resolvedSlackBotConnection,
        metadata: OpenGeniSlackBotConnectionMetadata.parse(bot.metadata),
      },
    });
    // Local installations need no organization share and retain their exact identity.
    const localTask = await createScheduledTask(client.db, {
      ...home,
      name: "Local bot schedule",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: task.agentConfig,
      createdBy: { kind: "service", subjectId: "scheduler" },
      metadata: {},
    });
    const localRun = await admit({
      ...acceptedExecution,
      task: localTask,
      resolvedSlackBotConnection: {
        ...acceptedExecution.resolvedSlackBotConnection,
        metadata: OpenGeniSlackBotConnectionMetadata.parse(bot.metadata),
      },
    });
    expect(localRun.status).toBe("queued");
    expect(await live(localRun.id, home)).toBeNull();
    // A different organization cannot name this installation even with its metadata.
    const otherAccount = crypto.randomUUID(),
      otherWorkspace = crypto.randomUUID();
    await owned.admin`insert into managed_accounts(id,name) values (${otherAccount},'Other organization')`;
    await owned.admin`insert into workspaces(id,account_id,name,settings) values (${otherWorkspace},${otherAccount},'Other workspace','{}')`;
    await owned.admin`insert into workspace_inference_controls(account_id,workspace_id) values (${otherAccount},${otherWorkspace})`;
    const otherTask = await createScheduledTask(client.db, {
      accountId: otherAccount,
      workspaceId: otherWorkspace,
      name: "Foreign bot schedule",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: task.agentConfig,
      createdBy: { kind: "service", subjectId: "scheduler" },
      metadata: {},
    });
    await rejected({ ...acceptedExecution, task: otherTask });
    // Revocation serializes against the accepted claim's share lock.
    await withRlsContext(client.db, target, async (tx) => {
      const [row] = await rawRows<{ denial: string | null }>(
        tx,
        sql`select validate_scheduled_agent_run_live_authority(${accountId}::uuid,${target.workspaceId}::uuid,${run.id}::uuid) as denial`,
      );
      expect(row!.denial).toBeNull();
      const error = await owned.admin
        .begin(async (admin) => {
          await admin`set local lock_timeout='100ms'`;
          await admin`update opengeni_private.organization_slack_bot_access set enabled=false where connection_id=${bot.id}`;
        })
        .then(
          () => null,
          (caught) => caught,
        );
      expect(nestedPostgresSqlState(error)).toBe("55P03");
    });
    await owned.admin`update opengeni_private.organization_slack_bot_access set enabled=false where connection_id=${bot.id}`;
    expect(await live()).toBe("scheduled_slack_bot_changed");
    expect(await live(localRun.id, home)).toBeNull();
  } finally {
    await client?.close();
    await owned.release();
  }
}, 180_000);
