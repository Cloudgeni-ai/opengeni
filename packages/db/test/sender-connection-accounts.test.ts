import type { ScheduledTaskRunAcceptedExecution } from "@opengeni/contracts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { updateScheduledTaskForApi } from "@opengeni/core";
import {
  createDb,
  createSession,
  sendAgentMessageInTransaction,
  steerAgentSessionInTransaction,
  createScheduledTask,
  createScheduledTaskRun,
  getScheduledTaskRevisionAuthority,
  getNestedAgentDepthDeploymentPolicy,
  bindScheduledTaskRunSessionInTransaction,
  addSessionSystemUpdateWithSourceMutation,
  settleScheduledTaskRunInTransaction,
  claimSessionWorkForAttempt,
  listOwnedConnectionAccounts,
  resolveAcceptedConnectionUse,
  scheduledTaskMutationOwnerMatches,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src";

let shared: SharedTestDatabase | null;
let client: DbClient;

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_SENDER_TEST_ADMIN_URL;
  const appUrl = process.env.OPENGENI_SENDER_TEST_APP_URL;
  if (Boolean(adminUrl) !== Boolean(appUrl)) throw new Error("Set both sender test database URLs");
  if (adminUrl && appUrl) {
    const admin = postgres(adminUrl, { max: 2 });
    shared = {
      admin,
      adminUrl,
      appUrl,
      release: async () => {
        await admin.end();
      },
    };
  } else {
    shared = await acquireSharedTestDatabase("sender-connection-accounts");
  }
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test("workspace-only agent messages claim revoked receipts without inventing a human", async () => {
  if (!shared) return;
  const sql = shared.admin;
  for (const change of ["revoked", "generation"] as const) {
    const [account] =
      await sql`insert into managed_accounts (name) values ('workspace message receipt') returning id`;
    const [workspace] =
      await sql`insert into workspaces (account_id,name) values (${account!.id},'workspace message receipt') returning id`;
    const [personal] =
      await sql`insert into workspaces (account_id,name) values (${account!.id},'Personal fixture') returning id`;
    const human = `user:${crypto.randomUUID()}`;
    const scope = { accountId: account!.id as string, workspaceId: workspace!.id as string };
    await sql`insert into organization_memberships (account_id,subject_id,status,personal_workspace_id) values (${scope.accountId},${human},'active',${personal!.id})`;
    await sql`insert into workspace_memberships (account_id,workspace_id,subject_id) values (${scope.accountId},${scope.workspaceId},${human})`;
    await sql`insert into workspace_inference_controls (account_id,workspace_id) values (${scope.accountId},${scope.workspaceId})`;
    const [connection] =
      await sql`insert into connections (account_id,workspace_id,provider_domain,kind,credential_encrypted)
      values (${scope.accountId},${scope.workspaceId},'mail.test','oauth2','fixture-ciphertext') returning id,authority_generation`;
    const binding = {
      serverId: `account-${"b".repeat(64)}`,
      canonicalServerId: "mail",
      connectionId: connection!.id as string,
      originWorkspaceId: scope.workspaceId,
      subjectScope: "workspace" as const,
      ownerSubjectId: null,
      accountLabel: "Workspace mail",
      providerDomain: "mail.test",
      kind: "oauth2" as const,
      connectionRef: {
        connectionId: connection!.id as string,
        providerDomain: "mail.test",
        subjectScope: "workspace" as const,
        kind: "oauth2" as const,
      },
      connectionAuthorityGeneration: Number(connection!.authority_generation),
    };
    const source = await createSession(client.db, {
      ...scope,
      initialMessage: "",
      subjectId: human,
      createdBy: { kind: "subject", subjectId: human },
      resources: [],
      tools: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await withWorkspaceSubjectSessionActivityRls(client.db, scope.workspaceId, human, (tx) =>
      submitHumanPromptInTransaction(tx, {
        ...scope,
        sessionId: source.id,
        subjectId: human,
        actor: { type: "human", subjectId: human },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Use workspace mail",
        resources: [],
        model: "test-model",
        reasoningEffort: "low",
        reasoningEffortFallback: "low",
        source: "user",
        personalConnectionDelegations: [],
        mcpAccountBindings: [binding],
      }),
    );
    const sourceAttempt = crypto.randomUUID();
    const claimedSource = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: source.id,
      workflowId: `session-${source.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: sourceAttempt,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimedSource.action !== "claimed") throw new Error("Source was not claimed");
    const target = await createSession(client.db, {
      ...scope,
      initialMessage: "",
      parentSessionId: source.id,
      resources: [],
      tools: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    if (change === "revoked") {
      await sql`update connections set status='revoked' where id=${binding.connectionId}`;
    } else {
      await sql`update connections set authority_generation=authority_generation+1 where id=${binding.connectionId}`;
    }
    const sent = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      scope.workspaceId,
      human,
      (tx) =>
        sendAgentMessageInTransaction(tx, {
          ...scope,
          targetSessionId: target.id,
          operationKey: crypto.randomUUID(),
          text: "Process the result",
          actor: {
            type: "agent_attempt",
            sessionId: source.id,
            turnId: claimedSource.turn.id,
            attemptId: sourceAttempt,
            executionGeneration: claimedSource.turn.executionGeneration,
          },
        }),
    );
    const [update] =
      await sql`select lineage,personal_connection_delegations,mcp_account_bindings from session_system_updates where id=${sent.updateId}`;
    expect(update!.lineage.connectionAuthoritySubjectId).toBeUndefined();
    expect(update!.personal_connection_delegations).toEqual([]);
    expect(update!.mcp_account_bindings).toEqual([binding]);
    const targetAttempt = crypto.randomUUID();
    const claimedTarget = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: target.id,
      workflowId: `session-${target.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: targetAttempt,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimedTarget.action !== "claimed")
      throw new Error(`Message was not claimed: ${claimedTarget.action}`);
    const [turn] =
      await sql`select initiator_kind,initiating_human_subject_id,personal_connection_delegations,mcp_account_bindings from session_turns where id=${claimedTarget.turn.id}`;
    expect(turn).toMatchObject({
      initiator_kind: "service",
      initiating_human_subject_id: null,
      personal_connection_delegations: [],
      mcp_account_bindings: [binding],
    });
    for (const usePhase of ["credential_resolution", "provider_request"] as const) {
      const result = await resolveAcceptedConnectionUse(client.db, {
        ...scope,
        sessionId: target.id,
        turnId: claimedTarget.turn.id,
        attemptId: targetAttempt,
        executionGeneration: claimedTarget.turn.executionGeneration,
        physicalRequestId: crypto.randomUUID(),
        usePhase,
        serverId: binding.serverId,
        connectionId: binding.connectionId,
        providerDomain: binding.providerDomain,
        connectionKind: "oauth2",
        subjectScope: "workspace",
      });
      expect(result).toMatchObject({
        status: "denied",
        reason:
          change === "revoked" ? "connection_status_inactive" : "connection_generation_changed",
      });
    }
  }
}, 180_000);

test("owner inventory works without private conversation activation and isolates participants", async () => {
  if (!shared) return;
  const sql = shared.admin;
  const [account] =
    await sql`insert into managed_accounts (name) values ('sender inventory') returning id`;
  const [origin] =
    await sql`insert into workspaces (account_id, name) values (${account!.id}, 'origin') returning id`;
  const [target] =
    await sql`insert into workspaces (account_id, name) values (${account!.id}, 'shared') returning id`;
  const alice = `user:${crypto.randomUUID()}`;
  const bob = `user:${crypto.randomUUID()}`;
  for (const subject of [alice, bob]) {
    const [personal] =
      await sql`insert into workspaces (account_id, name) values (${account!.id}, 'personal') returning id`;
    await sql`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id) values (${account!.id}, ${subject}, 'active', ${personal!.id})`;
    await sql`insert into workspace_memberships (account_id, workspace_id, subject_id) values (${account!.id}, ${target!.id}, ${subject})`;
  }
  const connectionIds: string[] = [];
  for (const subject of [alice, bob]) {
    const id = await sql.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${account!.id}, true), set_config('opengeni.workspace_id', ${origin!.id}, true), set_config('opengeni.subject_id', ${subject}, true)`;
      const [connection] =
        await tx`insert into connections (account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted)
        values (${account!.id}, ${origin!.id}, ${subject}, 'mail.example.test', 'oauth2', 'fixture-ciphertext') returning id`;
      return connection!.id as string;
    });
    connectionIds.push(id);
  }
  const scope = { accountId: account!.id as string, workspaceId: target!.id as string };
  // A restricted caller alone is insufficient: a superuser function owner can
  // bypass FORCE RLS and conceal a broken production lifecycle context.
  const ownerRole = `sender_inventory_${crypto.randomUUID().replaceAll("-", "")}`;
  const functionName = `${ownerRole}_fn`;
  const [functionRow] = await sql<
    { definition: string }[]
  >`select pg_get_functiondef('list_owned_connection_accounts(uuid,uuid)'::regprocedure) as definition`;
  if (!functionRow) throw new Error("Sender inventory migration is missing");
  await sql.unsafe(`create role "${ownerRole}" nologin nosuperuser nobypassrls`);
  try {
    await sql.unsafe(`grant usage on schema public to "${ownerRole}"`);
    await sql.unsafe(`grant usage on schema opengeni_private to "${ownerRole}"`);
    // Mirror a migration owner's object access without its local superuser
    // privilege. FORCE-RLS still evaluates every policy and helper normally.
    await sql.unsafe(
      `grant execute on all functions in schema public, opengeni_private to "${ownerRole}"`,
    );
    await sql.unsafe(
      `grant select on all tables in schema public, opengeni_private to "${ownerRole}"`,
    );
    await sql.unsafe(`grant update on connections to "${ownerRole}"`);
    await sql.unsafe(
      functionRow.definition.replace(
        "public.list_owned_connection_accounts(",
        `public.${functionName}(`,
      ),
    );
    await sql.unsafe(`alter function ${functionName}(uuid,uuid) owner to "${ownerRole}"`);
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${scope.accountId}, true), set_config('opengeni.workspace_id', ${scope.workspaceId}, true), set_config('opengeni.subject_id', ${alice}, true)`;
      return await tx.unsafe(`select connection_id from ${functionName}($1::uuid,$2::uuid)`, [
        scope.accountId,
        scope.workspaceId,
      ]);
    });
    expect(rows.map((row) => row.connection_id)).toEqual([connectionIds[0]]);
    const scopedRead = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role "${ownerRole}"`);
      await tx`select set_config('opengeni.account_id', ${scope.accountId}, true), set_config('opengeni.workspace_id', ${scope.workspaceId}, true), set_config('opengeni.subject_id', ${bob}, true)`;
      const connections =
        await tx`select id from opengeni_private.read_sender_connection(${scope.accountId}::uuid, ${origin!.id}::uuid, ${connectionIds[0]!}::uuid, ${alice})`;
      const [context] =
        await tx`select current_setting('opengeni.workspace_id') as workspace, current_setting('opengeni.subject_id') as subject`;
      return { ids: connections.map((row) => row.id), context };
    });
    expect(scopedRead).toEqual({
      ids: [connectionIds[0]],
      context: { workspace: scope.workspaceId, subject: bob },
    });
  } finally {
    await sql.unsafe(`drop function if exists ${functionName}(uuid,uuid)`);
    await sql.unsafe(`drop owned by "${ownerRole}"`);
    await sql.unsafe(`drop role "${ownerRole}"`);
  }
  expect(await listOwnedConnectionAccounts(client.db, { ...scope, subjectId: alice })).toEqual([
    { connectionId: connectionIds[0]!, originWorkspaceId: origin!.id },
  ]);
  expect(await listOwnedConnectionAccounts(client.db, { ...scope, subjectId: bob })).toEqual([
    { connectionId: connectionIds[1]!, originWorkspaceId: origin!.id },
  ]);
  expect(
    await listOwnedConnectionAccounts(client.db, {
      ...scope,
      subjectId: `user:${crypto.randomUUID()}`,
    }),
  ).toEqual([]);
  await sql`insert into workspace_inference_controls (workspace_id, account_id) values (${scope.workspaceId}, ${scope.accountId})`;
  const session = await createSession(client.db, {
    ...scope,
    subjectId: alice,
    createdBy: { kind: "subject", subjectId: alice },
    initialMessage: "sender connection test",
    resources: [],
    tools: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const selection = {
    serverId: "mail",
    connectionId: connectionIds[0]!,
    originWorkspaceId: origin!.id as string,
    ownerSubjectId: alice,
    providerDomain: "mail.example.test",
    kind: "oauth2" as const,
  };
  const submit = (personalConnectionDelegations: (typeof selection)[]) =>
    withWorkspaceSubjectSessionActivityRls(client.db, scope.workspaceId, alice, (tx) =>
      submitHumanPromptInTransaction(tx, {
        ...scope,
        sessionId: session.id,
        subjectId: alice,
        actor: { type: "human", subjectId: alice },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Use my connected account",
        resources: [],
        model: "test-model",
        reasoningEffort: "low",
        reasoningEffortFallback: "low",
        source: "user",
        personalConnectionDelegations,
      }),
    );
  // A superuser function owner would conceal FORCE-RLS policy defects.
  const executionOwner = `sender_execution_${crypto.randomUUID().replaceAll("-", "")}`;
  const routines = await sql<{ signature: string; owner: string }[]>`
    select p.oid::regprocedure::text as signature, pg_get_userbyid(p.proowner) as owner
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='opengeni_private' and p.proname in (
      'capture_accepted_turn_connection_authorities','capture_scheduled_turn_connection_authorities'))
       or (n.nspname='public' and p.proname in ('resolve_accepted_connection_use',
         'admit_scheduled_task_run_connection_authorities','bind_scheduled_task_run_connection_authorities',
         'validate_scheduled_agent_run_live_authority'))`;
  expect(routines).toHaveLength(6);
  const quoteIdentifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  await sql.unsafe(`create role "${executionOwner}" nologin nosuperuser nobypassrls`);
  try {
    await sql.unsafe(`grant usage on schema public, opengeni_private to "${executionOwner}"`);
    await sql.unsafe(
      `grant select, insert, update, delete on all tables in schema public, opengeni_private to "${executionOwner}"`,
    );
    await sql.unsafe(
      `grant usage on all sequences in schema public, opengeni_private to "${executionOwner}"`,
    );
    await sql.unsafe(
      `grant execute on all functions in schema public, opengeni_private to "${executionOwner}"`,
    );
    for (const routine of routines)
      await sql.unsafe(`alter function ${routine.signature} owner to "${executionOwner}"`);
    const accepted = await submit([selection]);
    const snapshots =
      await sql`select owner_subject_id, authority_source, grant_id from turn_connection_authority_snapshots where session_id = ${session.id}`;
    expect([...snapshots]).toEqual([
      { owner_subject_id: alice, authority_source: "sender", grant_id: null },
    ]);
    await expect(
      submit([{ ...selection, connectionId: connectionIds[1]!, ownerSubjectId: bob }]),
    ).rejects.toBeTruthy();
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error("Sender test turn was not claimed");
    expect(claim.turn.id).toBe(accepted.turnId);
    const use = {
      ...scope,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
      physicalRequestId: crypto.randomUUID(),
      usePhase: "credential_resolution" as const,
      serverId: "mail",
      connectionId: selection.connectionId,
      providerDomain: selection.providerDomain,
      connectionKind: "oauth2" as const,
      subjectScope: "subject" as const,
      ownerSubjectId: alice,
    };
    expect(await resolveAcceptedConnectionUse(client.db, use)).toMatchObject({
      status: "authorized",
      originWorkspaceId: origin!.id,
      attribution: { ownerSubjectId: alice, grantId: null },
    });
    const child = await createSession(client.db, {
      ...scope,
      parentSessionId: session.id,
      initialMessage: "Child work",
      resources: [],
      tools: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const actor = {
      type: "agent_attempt" as const,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    };
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      scope.workspaceId,
      alice,
      async (tx) => {
        await sendAgentMessageInTransaction(tx, {
          ...scope,
          targetSessionId: child.id,
          actor,
          operationKey: crypto.randomUUID(),
          text: "Continue my work",
        });
        await steerAgentSessionInTransaction(tx, {
          ...scope,
          targetSessionId: child.id,
          actor,
          operationKey: crypto.randomUUID(),
          instruction: "Keep my account",
        });
      },
    );
    const successors = await sql`select personal_connection_delegations as accounts,
      lineage ->> 'connectionAuthoritySubjectId' as owner
      from session_system_updates where session_id = ${child.id}
        and kind in ('agent_message', 'agent_steer_instruction')`;
    expect([...successors]).toEqual([
      { accounts: [selection], owner: alice },
      { accounts: [selection], owner: alice },
    ]);
    const task = await createScheduledTask(client.db, {
      ...scope,
      name: "Personal empty schedule",
      status: "paused",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "skip",
      createdBy: { kind: "subject", subjectId: alice },
      agentConfig: { prompt: "Check later", resources: [], tools: [], metadata: {} },
      metadata: {},
    });
    expect(task.ownerSubjectId).toBe(alice);
    const ownerGrant = {
      ...scope,
      subjectId: alice,
      principalKind: "human_session" as const,
      permissions: ["scheduled_tasks:manage" as const],
    };
    await expect(
      updateScheduledTaskForApi(client.db, { ...ownerGrant, subjectId: bob }, task.id, {
        name: "Hijacked",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await updateScheduledTaskForApi(client.db, ownerGrant, task.id, { name: "My schedule" }),
    ).toMatchObject({ name: "My schedule", ownerSubjectId: alice });
    expect(
      await scheduledTaskMutationOwnerMatches(client.db, {
        workspaceId: scope.workspaceId,
        taskId: task.id,
        createdBy: { kind: "subject", subjectId: alice },
      }),
    ).toBe(true);
    expect(
      await scheduledTaskMutationOwnerMatches(client.db, {
        workspaceId: scope.workspaceId,
        taskId: task.id,
        createdBy: { kind: "subject", subjectId: bob },
      }),
    ).toBe(false);
    await expect(
      (async () => {
        await sql`update scheduled_tasks set owner_subject_id = ${bob} where id = ${task.id}`;
      })(),
    ).rejects.toMatchObject({ code: "42501" });
    const scheduled = await createScheduledTask(client.db, {
      ...scope,
      name: "Current sender accounts",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      createdBy: { kind: "subject", subjectId: alice },
      agentConfig: {
        prompt: "Use my current mail account",
        resources: [],
        tools: [{ kind: "mcp", id: "mail" }],
        metadata: {},
        connectionAccounts: [],
      },
      metadata: {},
    });
    const revisionAuthority = await getScheduledTaskRevisionAuthority(client.db, {
      ...scope,
      taskId: scheduled.id,
      taskAuthorityRevision: scheduled.authorityRevision,
    });
    const depth = await getNestedAgentDepthDeploymentPolicy(client.db);
    const acceptedExecution: ScheduledTaskRunAcceptedExecution = {
      version: 1,
      task: scheduled,
      resolvedModel: "test-model",
      resolvedReasoningEffort: "low",
      resolvedLatencyMode: "standard",
      resolvedSandboxBackend: "none",
      resolvedSandboxOs: "linux",
      resolvedTools: scheduled.agentConfig.tools,
      resolvedFirstPartyMcpTools: [],
      resolvedFirstPartyMcpPermissions: [],
      resolvedVariableSet: null,
      resolvedRig: null,
      resolvedSlackBotConnection: null,
      targetSessionExecution: null,
      generatedSessionBinding: {
        createIdempotencyKey: `sender-schedule:${scheduled.id}`,
        effectiveMaxNestedAgentDepth: depth.maxNestedAgentDepth,
        nestedAgentDepthPolicySource: depth.policySource,
        codexCompactionMode: "portable",
      },
      personalConnectionDelegations: [selection],
      personalResourceAuthoritySubjectId: null,
      causalHumanSubjectId: alice,
      causalHumanAuthority: revisionAuthority,
      xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
      xaiAuthoritySubjectId: null,
      connectionAuthoritySubjectId: alice,
      triggerInitiator: { kind: "service", subjectId: "scheduler" },
      agentRunUsageIdempotencyKey: null,
      incidentPreflightRequired: false,
      alertOccurrenceLabels: null,
    };
    const run = await createScheduledTaskRun(client.db, {
      workspaceId: scope.workspaceId,
      taskId: scheduled.id,
      taskAuthorityRevision: scheduled.authorityRevision,
      taskExecutionDigest: scheduled.executionDigest,
      triggerType: "manual",
      producerKey: crypto.randomUUID(),
      acceptedExecutionSnapshot: acceptedExecution,
    });
    expect(run).toMatchObject({ status: "queued", error: null });
    const runAccounts = await sql`
      select connection_id, owner_subject_id, grant_id,
        canonical_snapshot ->> 'authoritySource' as source
      from scheduled_task_run_connection_authority_snapshots where run_id = ${run.id}`;
    expect([...runAccounts]).toEqual([
      {
        connection_id: selection.connectionId,
        owner_subject_id: alice,
        grant_id: null,
        source: "sender",
      },
    ]);
    const scheduledSession = await createSession(client.db, {
      ...scope,
      initialMessage: scheduled.agentConfig.prompt,
      resources: [],
      tools: scheduled.agentConfig.tools,
      firstPartyMcpTools: [],
      firstPartyMcpPermissions: [],
      metadata: {
        model: "test-model",
        reasoningEffort: "low",
        scheduledTaskId: scheduled.id,
        scheduledTaskRunId: run.id,
        scheduledTaskRunMode: "new_session_per_run",
      },
      model: "test-model",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "service", subjectId: "scheduler", label: "OpenGeni scheduler" },
      createdByContext: { scheduledTaskId: scheduled.id, scheduledTaskRunId: run.id },
      createIdempotencyKey: acceptedExecution.generatedSessionBinding!.createIdempotencyKey,
      maxNestedAgentDepthOverride: null,
      frozenNestedAgentDepthPolicy: {
        effectiveMaxNestedAgentDepth: depth.maxNestedAgentDepth,
        nestedAgentDepthPolicySource: depth.policySource,
      },
      frozenCodexCompactionMode: "portable",
      beforeCreateCommit: async (tx, sessionId) => {
        await bindScheduledTaskRunSessionInTransaction(tx, { ...scope, runId: run.id, sessionId });
      },
    });
    await addSessionSystemUpdateWithSourceMutation(
      client.db,
      {
        ...scope,
        sessionId: scheduledSession.id,
        kind: "scheduled_occurrence",
        classification: "info",
        sourceId: run.id,
        dedupeKey: `scheduled-task-run:${run.id}`,
        summary: scheduled.agentConfig.prompt,
        payload: {
          type: "scheduled_occurrence",
          text: scheduled.agentConfig.prompt,
          scheduledTaskId: scheduled.id,
          scheduledTaskRunId: run.id,
          tools: scheduled.agentConfig.tools,
        },
        lineage: {
          scheduledTaskId: scheduled.id,
          scheduledTaskRunId: run.id,
          causalHumanSubjectId: alice,
          connectionAuthoritySubjectId: alice,
        },
        personalConnectionDelegations: [selection],
        xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
        scheduledTaskRunId: run.id,
      },
      async (tx, eventId) => {
        if (!eventId) throw new Error("Missing scheduled occurrence event");
        await settleScheduledTaskRunInTransaction(tx, {
          workspaceId: scope.workspaceId,
          runId: run.id,
          sessionId: scheduledSession.id,
          triggerEventId: eventId,
          status: "dispatched",
        });
      },
    );
    const scheduledAttemptId = crypto.randomUUID();
    const scheduledClaim = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
      sessionId: scheduledSession.id,
      workflowId: `session-${scheduledSession.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: scheduledAttemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (scheduledClaim.action !== "claimed")
      throw new Error("Scheduled sender turn was not claimed");
    expect(scheduledClaim.turn.initiatingHumanSubjectId).toBe(alice);
    expect(
      await resolveAcceptedConnectionUse(client.db, {
        ...use,
        sessionId: scheduledSession.id,
        turnId: scheduledClaim.turn.id,
        attemptId: scheduledAttemptId,
        executionGeneration: scheduledClaim.turn.executionGeneration,
        physicalRequestId: crypto.randomUUID(),
      }),
    ).toMatchObject({
      status: "authorized",
      attribution: { ownerSubjectId: alice, grantId: null },
    });
    await sql`delete from workspace_memberships where account_id = ${account!.id} and workspace_id = ${target!.id} and subject_id = ${alice}`;
    expect(
      await resolveAcceptedConnectionUse(client.db, {
        ...use,
        physicalRequestId: crypto.randomUUID(),
      }),
    ).toMatchObject({ status: "denied" });
    expect(await listOwnedConnectionAccounts(client.db, { ...scope, subjectId: alice })).toEqual(
      [],
    );
  } finally {
    for (const routine of routines)
      await sql.unsafe(
        `alter function ${routine.signature} owner to ${quoteIdentifier(routine.owner)}`,
      );
    await sql.unsafe(`drop owned by "${executionOwner}"`);
    await sql.unsafe(`drop role "${executionOwner}"`);
  }
});
