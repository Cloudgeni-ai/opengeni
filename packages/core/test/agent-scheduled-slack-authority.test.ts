import { afterAll, beforeAll, expect, test } from "bun:test";
import { CreateScheduledTaskRequest, type AccessGrant, type ScheduledTask } from "@opengeni/contracts";
import {
  claimSessionWorkForAttempt,
  createConnection,
  createDb,
  createScheduledTaskRun,
  createSession,
  ensureManagedAccessForUser,
  getNestedAgentDepthDeploymentPolicy,
  getScheduledTaskCreatorPolicy,
  getScheduledTaskPersonalConnectionDelegations,
  getScheduledTaskRevisionAuthority,
  getScheduledTargetSessionExecution,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import { acquireSharedTestDatabase, testSettings, type SharedTestDatabase } from "@opengeni/testing";
import type { AccessGrantAuthorization } from "../src/access";
import { issueManagedHumanUserResourceGrant, revokeManagedHumanUserResourceGrant } from "../src/application/user-resource-grants";
import { freezePersonalConnectionDelegations } from "../src/domain/personal-connection-delegations";
import { createValidatedScheduledTask } from "../src/domain/scheduled-tasks";

const slack = {
  id: "slack", url: "https://mcp.slack.com/mcp", cacheToolsList: false,
  connectionRef: { providerDomain: "slack.com", kind: "oauth2" as const, subjectScope: "subject" as const },
};
const tools = [{ kind: "mcp" as const, id: "slack" }];
const firstPartyMcpTools = ["scheduled_tasks_create", "session_get"] as const;
const firstPartyMcpPermissions = ["scheduled_tasks:manage", "sessions:read", "sessions:control", "connections:read"] as const;
const settings = testSettings({ mcpServers: [slack], sandboxBackend: "none" });
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb> | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-agent-scheduled-slack-authority");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("Real PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => { await client?.close(); await shared?.release(); }, 180_000);

async function fixture(mode: "always" | "session") {
  const db = client!.db;
  const userId = `scheduled-slack-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(db, { userId, email: `${userId}@example.test`, name: "Scheduled Slack owner" });
  const grant = access.workspaceGrants[0]!;
  const authorization = { grant, accountGrant: access.accountGrants[0] ?? null, authenticatedSubjectId: subjectId,
    contextIntegrity: true, canonicalManagedHumanSession: true } satisfies AccessGrantAuthorization;
  const session = await createSession(db, { accountId: grant.accountId, workspaceId: grant.workspaceId,
    subjectId, createdBy: { kind: "subject", subjectId }, initialMessage: "", resources: [], tools,
    firstPartyMcpTools: [...firstPartyMcpTools], firstPartyMcpPermissions: [...firstPartyMcpPermissions],
    metadata: {}, model: "scripted-model", reasoningEffort: "medium", latencyMode: "standard", sandboxBackend: "none" });
  const connection = await createConnection(db, { accountId: grant.accountId, workspaceId: grant.workspaceId,
    subjectId, providerDomain: "slack.com", kind: "oauth2", credentialEncrypted: "test-never-sent" });
  const issued = await issueManagedHumanUserResourceGrant({ db }, authorization, grant.workspaceId, connection.authorityId!, {
    scope: "user", resourceKind: "connection", mode, context: "workspace_shared", workspaceSharedAcknowledged: true,
    ...(mode === "session" ? { sessionId: session.id, expectedAuthorityEpoch: 1 } : {}),
  });
  const delegations = await freezePersonalConnectionDelegations({ db, workspaceId: grant.workspaceId,
    settings, tools, source: { kind: "subject", subjectId, accountId: grant.accountId },
    authoritySelections: [{ serverId: "slack", connectionId: connection.id, userDelegation: issued.delegation }] });
  await withWorkspaceSubjectSessionActivityRls(db, grant.workspaceId, subjectId, (tx) => submitHumanPromptInTransaction(tx, {
    accountId: grant.accountId, workspaceId: grant.workspaceId, sessionId: session.id, subjectId,
    actor: { type: "human", subjectId }, operationKey: crypto.randomUUID(), delivery: "send", text: "Schedule my Slack work",
    resources: [], model: "scripted-model", reasoningEffort: "medium", reasoningEffortFallback: "medium", source: "user",
    personalConnectionDelegations: delegations,
  }));
  const attemptId = crypto.randomUUID();
  const claimed = await withWorkspaceSessionActivityRls(db, grant.workspaceId, (tx) => claimSessionWorkForAttempt(tx, grant.workspaceId, {
    sessionId: session.id, workflowId: `session-${session.id}`, workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(), attemptId, trigger: { kind: "next" },
  }));
  if (claimed.action !== "claimed") throw new Error(`Expected live agent, got ${claimed.action}`);
  const agentGrant = { ...grant, subjectId: "worker:first-party-mcp", principalKind: "agent",
    permissions: [...firstPartyMcpPermissions], metadata: { sessionId: session.id, turnId: claimed.turn.id,
      attemptId, executionGeneration: claimed.turn.executionGeneration } } satisfies AccessGrant;
  const createTask = (targetSessionId = mode === "session" ? session.id : undefined) => createValidatedScheduledTask({
    db, settings, objectStorage: null, grant: agentGrant, toolsProvided: true,
    payload: CreateScheduledTaskRequest.parse({ name: "My Slack schedule", schedule: { type: "manual" },
      runMode: targetSessionId ? "existing_session" : "new_session_per_run", targetSessionId,
      agentConfig: { prompt: "Read my latest Slack message", tools, resources: [], model: "scripted-model", sandboxBackend: "none" } }),
  });
  return { grant, authorization, subjectId, session, connection, issued, delegations, createTask };
}

async function createOccurrence(task: ScheduledTask, subjectId: string) {
  const db = client!.db;
  const binding = { accountId: task.accountId, workspaceId: task.workspaceId, taskId: task.id, taskAuthorityRevision: task.authorityRevision };
  const causalHumanAuthority = await getScheduledTaskRevisionAuthority(db, binding);
  const personalConnectionDelegations = await getScheduledTaskPersonalConnectionDelegations(db, task.workspaceId, task.id);
  const creatorPolicy = await getScheduledTaskCreatorPolicy(db, task.workspaceId, task.id);
  if (!creatorPolicy) throw new Error("Agent-created task must freeze creator policy");
  const targetSessionExecution = task.targetSessionId
    ? await getScheduledTargetSessionExecution(db, task.workspaceId, task.targetSessionId, subjectId) : null;
  const depth = await getNestedAgentDepthDeploymentPolicy(db);
  const runId = crypto.randomUUID();
  return await createScheduledTaskRun(db, { runId, workspaceId: task.workspaceId, taskId: task.id,
    taskAuthorityRevision: task.authorityRevision, taskExecutionDigest: task.executionDigest,
    triggerType: "scheduled", producerKey: `scheduled-slack:${runId}`,
    acceptedExecutionSnapshot: {
      version: 1, task, resolvedModel: "scripted-model", resolvedReasoningEffort: "medium", resolvedLatencyMode: "standard",
      resolvedSandboxBackend: "none", resolvedSandboxOs: "linux", resolvedTools: tools,
      resolvedFirstPartyMcpTools: creatorPolicy.firstPartyMcpTools,
      resolvedFirstPartyMcpPermissions: creatorPolicy.firstPartyMcpPermissions,
      resolvedVariableSet: null, resolvedRig: null, resolvedSlackBotConnection: null, targetSessionExecution,
      generatedSessionBinding: targetSessionExecution ? null : { createIdempotencyKey: `scheduled-slack:${runId}`,
        effectiveMaxNestedAgentDepth: depth.maxNestedAgentDepth, nestedAgentDepthPolicySource: depth.policySource, codexCompactionMode: "portable" },
      personalConnectionDelegations, personalResourceAuthoritySubjectId: null, causalHumanSubjectId: subjectId, causalHumanAuthority,
      connectionAuthoritySubjectId: subjectId, xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" }, xaiAuthoritySubjectId: null,
      triggerInitiator: { kind: "service", subjectId: "scheduler" }, agentRunUsageIdempotencyKey: null,
      incidentPreflightRequired: false, alertOccurrenceLabels: null,
    },
  });
}

test("a live agent carries its human's standing Slack consent into a generated scheduled occurrence", async () => {
  if (!client || !shared) return;
  const f = await fixture("always");
  const task = await f.createTask();
  expect(task.createdBy).toMatchObject({ kind: "subject", subjectId: f.subjectId });
  expect(await getScheduledTaskPersonalConnectionDelegations(client.db, task.workspaceId, task.id)).toEqual(f.delegations);
  const run = await createOccurrence(task, f.subjectId);
  expect(run.status).toBe("queued");
  const snapshots = await shared.admin`select owner_subject_id, grant_id, grant_mode from scheduled_task_run_connection_authority_snapshots where run_id = ${run.id}`;
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ owner_subject_id: f.subjectId, grant_id: f.issued.grantId, grant_mode: "always" });
  await revokeManagedHumanUserResourceGrant({ db: client.db }, f.authorization, f.grant.workspaceId, f.issued.grantId);
  await expect(f.createTask()).rejects.toThrow();
  const revokedRun = await createOccurrence(task, f.subjectId);
  expect(revokedRun.status).toBe("failed");
  expect(revokedRun.error).toContain("authority");
}, 180_000);

test("a live agent retains exact-session Slack consent only for that same scheduled destination", async () => {
  if (!client || !shared) return;
  const f = await fixture("session");
  const task = await f.createTask();
  const run = await createOccurrence(task, f.subjectId);
  expect(run.status).toBe("queued");
  const snapshots = await shared.admin`select owner_subject_id, grant_id, grant_mode from scheduled_task_run_connection_authority_snapshots where run_id = ${run.id}`;
  expect(snapshots[0]).toMatchObject({ owner_subject_id: f.subjectId, grant_id: f.issued.grantId, grant_mode: "session" });
}, 180_000);
