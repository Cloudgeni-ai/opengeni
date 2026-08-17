import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { createDb, createScheduledTask, createSession, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("scheduled-combined-once");
  if (!shared) {
    available = false;
    console.warn("[worker-scheduled-combined-once] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

function activities() {
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({ databaseUrl: shared!.appUrl, sandboxBackend: "none" }),
        db: client.db,
        bus: new MemoryEventBus(),
      }) as unknown as ActivityServices,
  );
}

async function fixture() {
  const subjectId = `combined-subject-${crypto.randomUUID()}`;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`combined-${crypto.randomUUID()}`}) returning id`;
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'combined personal') returning id`;
  const [target] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'combined target') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${personal!.id}, ${account!.id}), (${target!.id}, ${account!.id})`;
  const [membership] = await admin<{ id: string }[]>`
    insert into organization_memberships
      (account_id, subject_id, status, personal_workspace_id, authorization_revision)
    values (${account!.id}, ${subjectId}, 'active', ${personal!.id}, 1) returning id`;
  await admin`insert into workspace_memberships
    (account_id, workspace_id, subject_id, role, permissions)
    values (${account!.id}, ${target!.id}, ${subjectId}, 'owner', '[]'::jsonb)`;

  const [variableSet] = await admin<{ id: string }[]>`
    insert into workspace_variable_sets (account_id, workspace_id, name)
    values (${account!.id}, ${personal!.id}, ${`combined-vs-${crypto.randomUUID()}`}) returning id`;
  const [variableAuthority] = await admin<{ id: string }[]>`
    insert into organization_user_resource_authorities
      (account_id, organization_membership_id, resource_kind, resource_id,
       origin_workspace_id, generation, status)
    values (${account!.id}, ${membership!.id}, 'variable_set', ${variableSet!.id},
      ${personal!.id}, 1, 'active') returning id`;
  await admin`update workspace_variable_sets set authority_scope='user',
    authority_id=${variableAuthority!.id}, owner_organization_membership_id=${membership!.id},
    origin_workspace_id=${personal!.id} where id=${variableSet!.id}`;
  const [variableGrant] = await admin<{ id: string }[]>`
    insert into organization_user_resource_grants
      (account_id, authority_id, owner_organization_membership_id, workspace_id,
       action, mode, context, generation, status)
    values (${account!.id}, ${variableAuthority!.id}, ${membership!.id}, ${target!.id},
      'variable_set.use', 'always', 'workspace_shared', 1, 'active') returning id`;

  const connection = await admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
    await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
    const [row] = await tx<
      Array<{
        id: string;
        authorityId: string;
        authorityGeneration: number;
      }>
    >`insert into connections
      (account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted)
      values (${account!.id}, ${target!.id}, ${subjectId},
        'combined-once.example.com', 'oauth2', 'ciphertext')
      returning id, authority_id as "authorityId",
        authority_generation::int as "authorityGeneration"`;
    return row!;
  });
  const connectionGrant = await admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${account!.id}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${target!.id}, true)`;
    await tx`select set_config('opengeni.subject_id', ${subjectId}, true)`;
    const [row] = await tx<Array<{ id: string; generation: number }>>`
      select grant_id as id, grant_generation::int as generation
      from issue_self_connection_use_grant(
        ${account!.id}::uuid, ${connection.authorityId}::uuid,
        ${target!.id}::uuid, 'always', 'workspace_shared', null, true
      )`;
    return row!;
  });
  const initialDelegation = {
    serverId: "combined-once",
    connectionId: connection.id,
    originWorkspaceId: target!.id,
    ownerSubjectId: subjectId,
    providerDomain: "combined-once.example.com",
    kind: "oauth2" as const,
    connectionType: "mcp" as const,
    userDelegation: {
      authorityId: connection.authorityId,
      grantId: connectionGrant.id,
      organizationId: account!.id,
      workspaceId: target!.id,
      sessionId: null,
      action: "connection.use" as const,
      mode: "always" as const,
      context: "workspace_shared" as const,
      authorityEpoch: null,
      authorityGeneration: connection.authorityGeneration,
      grantGeneration: connectionGrant.generation,
    },
  };
  const session = await createSession(client.db, {
    accountId: account!.id,
    workspaceId: target!.id,
    subjectId,
    initialMessage: "combined once authority target",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
    variableSetId: variableSet!.id,
    personalConnectionDelegations: [initialDelegation],
  });
  const [{ authorityEpoch, visibility }] = await admin<
    Array<{
      authorityEpoch: number;
      visibility: "workspace_shared";
    }>
  >`select authority_epoch::int as "authorityEpoch", visibility
    from sessions where id=${session.id}`;
  await admin`update organization_user_resource_grants set
      mode='once', session_id=${session.id}, context=${visibility},
      authority_epoch=${authorityEpoch}, updated_at=now()
    where id in (${variableGrant!.id}, ${connectionGrant.id})`;
  const delegation = {
    ...initialDelegation,
    userDelegation: {
      ...initialDelegation.userDelegation,
      sessionId: session.id,
      mode: "once" as const,
      context: visibility,
      authorityEpoch,
    },
  };
  return {
    accountId: account!.id,
    workspaceId: target!.id,
    personalWorkspaceId: personal!.id,
    subjectId,
    variableSetId: variableSet!.id,
    variableGrantId: variableGrant!.id,
    connectionGrantId: connectionGrant.id,
    session,
    delegation,
  };
}

async function createCombinedTask(value: Awaited<ReturnType<typeof fixture>>) {
  return createScheduledTask(client.db, {
    accountId: value.accountId,
    workspaceId: value.workspaceId,
    createdBy: { kind: "subject", subjectId: value.subjectId },
    name: `combined-once-${crypto.randomUUID()}`,
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `combined-once-${crypto.randomUUID()}`,
    runMode: "existing_session",
    targetSessionId: value.session.id,
    overlapPolicy: "allow_concurrent",
    agentConfig: { prompt: "consume both once grants", resources: [], tools: [], metadata: {} },
    personalConnectionDelegations: [value.delegation],
    variableSetId: value.variableSetId,
    metadata: {},
  });
}

async function facts(
  value: Awaited<ReturnType<typeof fixture>>,
  taskId: string,
  producerKey: string,
) {
  const [row] = await admin<Array<Record<string, unknown>>>`
    select
      (select status from organization_user_resource_grants where id=${value.connectionGrantId})
        as "connectionGrantStatus",
      (select status from organization_user_resource_grants where id=${value.variableGrantId})
        as "variableGrantStatus",
      (select count(*)::int from scheduled_task_runs run
       where run.task_id=${taskId} and run.producer_key=${producerKey}) as runs,
      (select min(status) from scheduled_task_runs run
       where run.task_id=${taskId} and run.producer_key=${producerKey}) as "runStatus",
      (select min(error) from scheduled_task_runs run
       where run.task_id=${taskId} and run.producer_key=${producerKey}) as "runError",
      (select count(*)::int from scheduled_task_run_connection_authority_snapshots snapshot
       join scheduled_task_runs run on run.id=snapshot.run_id
       where run.task_id=${taskId} and run.producer_key=${producerKey}) as "connectionRunSnapshots",
      (select count(*)::int from scheduled_task_run_personal_resource_snapshots snapshot
       join scheduled_task_runs run on run.id=snapshot.run_id
       where run.task_id=${taskId} and run.producer_key=${producerKey}) as "personalRunSnapshots",
      (select count(*)::int from connection_use_once_consumption_receipts receipt
       where receipt.grant_id=${value.connectionGrantId}) as "connectionReceipts",
      (select count(*)::int from scheduled_task_run_personal_resource_once_receipts receipt
       where receipt.grant_id=${value.variableGrantId}) as "personalScheduledReceipts",
      (select count(*)::int from personal_resource_once_consumption_receipts receipt
       where receipt.grant_id=${value.variableGrantId}) as "personalAttemptReceipts"`;
  return row!;
}

test("combined once success consumes both once grants and replay is receipt-idempotent", async () => {
  if (!available) return;
  const value = await fixture();
  const task = await createCombinedTask(value);
  const producerKey = `combined-success-${crypto.randomUUID()}`;
  const first = await activities().dispatchScheduledTaskRun({
    workspaceId: value.workspaceId,
    taskId: task.id,
    triggerType: "scheduled",
    producerKey,
  });
  const firstFacts = await facts(value, task.id, producerKey);
  const replay = await activities().dispatchScheduledTaskRun({
    workspaceId: value.workspaceId,
    taskId: task.id,
    triggerType: "scheduled",
    producerKey,
  });
  const replayFacts = await facts(value, task.id, producerKey);
  expect(first).toMatchObject({ action: "signal", sessionId: value.session.id });
  expect(replay).toMatchObject({
    action: "signal",
    sessionId: value.session.id,
    triggerEventId: first.action === "signal" ? first.triggerEventId : undefined,
  });
  expect(firstFacts).toEqual({
    connectionGrantStatus: "consumed",
    variableGrantStatus: "consumed",
    runs: 1,
    runStatus: "dispatched",
    runError: null,
    connectionRunSnapshots: 1,
    personalRunSnapshots: 1,
    connectionReceipts: 1,
    personalScheduledReceipts: 1,
    personalAttemptReceipts: 0,
  });
  expect(replayFacts).toEqual(firstFacts);
});

test("combined later personal admission failure rolls connection work back", async () => {
  if (!available) return;
  const value = await fixture();
  const task = await createCombinedTask(value);
  await admin`update organization_user_resource_grants
    set generation=generation+1, updated_at=now() where id=${value.variableGrantId}`;
  const producerKey = `combined-rollback-${crypto.randomUUID()}`;
  const result = await activities().dispatchScheduledTaskRun({
    workspaceId: value.workspaceId,
    taskId: task.id,
    triggerType: "scheduled",
    producerKey,
  });
  const after = await facts(value, task.id, producerKey);
  expect(result).toEqual({ action: "blocked", reason: "scheduled_run_terminal" });
  expect(after).toEqual({
    connectionGrantStatus: "active",
    variableGrantStatus: "active",
    runs: 1,
    runStatus: "failed",
    runError: "scheduled_run_authority_proof_rejected",
    connectionRunSnapshots: 0,
    personalRunSnapshots: 0,
    connectionReceipts: 0,
    personalScheduledReceipts: 0,
    personalAttemptReceipts: 0,
  });
});
