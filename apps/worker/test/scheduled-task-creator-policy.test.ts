import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  metadataWithTurnExecutionPolicyV1,
  readTurnExecutionPolicyV1,
  TurnExecutionPolicyV1,
} from "@opengeni/contracts";
import { resolveFirstPartyMcpToolPolicy } from "@opengeni/config";
import {
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createSession,
  claimSessionWorkForAttempt,
  getScheduledTaskRunAcceptedExecution,
  getSession,
  listScheduledTaskRuns,
  type DbClient,
  type ScheduledTaskCreatorPolicy,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices, DispatchScheduledTaskRunInput } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-creator-policy");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("scheduled-task creator policy tests require real PostgreSQL");
    }
    available = false;
    console.warn("[worker-scheduled-creator-policy] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

function activities(settingsOverrides: Parameters<typeof testSettings>[0] = {}) {
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    sandboxBackend: "none",
    ...settingsOverrides,
  });
  return {
    settings,
    activities: createScheduledTaskActivities(
      async () =>
        ({
          settings,
          db: client.db,
          bus: new MemoryEventBus(),
          wakeSessionWorkflow: async () => undefined,
        }) as unknown as ActivityServices,
    ),
  };
}

async function workspaceGrant() {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `scheduled-creator-account-${crypto.randomUUID()}`,
    accountName: "Scheduled creator policy account",
    workspaceExternalSource: "test",
    workspaceExternalId: `scheduled-creator-workspace-${crypto.randomUUID()}`,
    workspaceName: "Scheduled creator policy workspace",
    subjectId: "user:scheduled-creator-owner",
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared!.admin`insert into workspaces (account_id, name)
    values (${grant.accountId}, 'Personal schedule fixture') returning id`;
  await shared!.admin`insert into organization_memberships
    (account_id, subject_id, status, personal_workspace_id)
    values (${grant.accountId}, ${grant.subjectId}, 'active', ${personal!.id})`;
  return grant;
}

async function generatedTask(
  grant: Awaited<ReturnType<typeof workspaceGrant>>,
  creatorPolicy: ScheduledTaskCreatorPolicy | null,
  target?: { runMode: "existing_session" | "reusable_session"; targetSessionId?: string },
) {
  return await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    name: "Generated session creator policy",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-creator-${crypto.randomUUID()}`,
    runMode: target?.runMode ?? "new_session_per_run",
    ...(target?.targetSessionId ? { targetSessionId: target.targetSessionId } : {}),
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Run with the creator's boundary",
      resources: [],
      tools: [],
      metadata: {},
    },
    metadata: {},
    creatorPolicy,
  });
}

async function dispatchGeneratedSession(
  grant: Awaited<ReturnType<typeof workspaceGrant>>,
  taskId: string,
  settingsOverrides: Parameters<typeof testSettings>[0] = {},
  dispatchOverrides: Partial<
    Pick<
      DispatchScheduledTaskRunInput,
      "triggerType" | "credentialRestriction" | "agentRunUsageIdempotencyKey" | "initiator"
    >
  > = {},
) {
  const { settings, activities: scheduled } = activities(settingsOverrides);
  const result = await scheduled.dispatchScheduledTaskRun({
    workspaceId: grant.workspaceId,
    taskId,
    triggerType: "scheduled",
    producerKey: `scheduled-creator-${crypto.randomUUID()}`,
    ...dispatchOverrides,
  });
  const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, taskId, 10);
  if (result.action !== "start" && result.action !== "signal") {
    throw new Error(
      `unexpected dispatch result: ${JSON.stringify(result)}; run: ${JSON.stringify({
        status: run?.status,
        error: run?.error,
      })}`,
    );
  }
  const session = await getSession(client.db, grant.workspaceId, result.sessionId);
  if (!session) throw new Error("generated session missing");
  const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
    workspaceId: grant.workspaceId,
    runId: run!.id,
  });
  return { settings, session, accepted, result, run: run! };
}

describe("scheduled-task creator policy inheritance (real PostgreSQL)", () => {
  test("a human/API-created task keeps the deployment default for its generated session", async () => {
    if (!available) return;
    const grant = await workspaceGrant();
    const task = await generatedTask(grant, null);
    const { settings, session, accepted } = await dispatchGeneratedSession(grant, task.id);
    expect(session.firstPartyMcpTools).toEqual(resolveFirstPartyMcpToolPolicy(settings).default);
    expect(session.firstPartyMcpPermissions).toEqual([...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS]);
    expect(accepted?.resolvedFirstPartyMcpTools).toEqual(
      resolveFirstPartyMcpToolPolicy(settings).default,
    );
    expect(accepted?.resolvedFirstPartyMcpPermissions).toEqual([
      ...DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
    ]);
    expect(
      TurnExecutionPolicyV1.parse(accepted?.turnExecutionPolicy).credentialRestriction,
    ).toBeUndefined();
    expect(readTurnExecutionPolicyV1(session.metadata)).toEqual({ kind: "absent" });
  }, 60_000);

  test("an agent-created task's generated session inherits the frozen creator boundary", async () => {
    if (!available) return;
    // The hole: a narrowed session (title tool only, read-only permissions)
    // could schedule a task whose generated sessions received the complete
    // deployment default catalog and the full worker permission set.
    const grant = await workspaceGrant();
    const task = await generatedTask(grant, {
      firstPartyMcpTools: ["set_session_title", "scheduled_tasks_list"],
      firstPartyMcpPermissions: ["sessions:read", "scheduled_tasks:manage"],
      sessionPolicy: { agentAccess: null, scopeSubjectId: null, memoryScope: null },
    });
    const { settings, session, accepted } = await dispatchGeneratedSession(grant, task.id);
    expect(session.firstPartyMcpTools).toEqual(["set_session_title", "scheduled_tasks_list"]);
    expect(session.firstPartyMcpPermissions).toEqual(["sessions:read", "scheduled_tasks:manage"]);
    expect(accepted?.resolvedFirstPartyMcpTools).toEqual([
      "set_session_title",
      "scheduled_tasks_list",
    ]);
    expect(accepted?.resolvedFirstPartyMcpPermissions).toEqual([
      "sessions:read",
      "scheduled_tasks:manage",
    ]);
    expect(resolveFirstPartyMcpToolPolicy(settings).default.length).toBeGreaterThan(2);
  }, 60_000);

  test("the deployment ceiling still applies on top of the frozen creator selection", async () => {
    if (!available) return;
    const grant = await workspaceGrant();
    const task = await generatedTask(grant, {
      firstPartyMcpTools: ["set_session_title", "scheduled_tasks_list", "sessions_list"],
      firstPartyMcpPermissions: ["sessions:read"],
      sessionPolicy: null,
    });
    const { session } = await dispatchGeneratedSession(grant, task.id, {
      allowedFirstPartyMcpTools: ["set_session_title", "sessions_list"],
    });
    expect(session.firstPartyMcpTools).toEqual(["set_session_title", "sessions_list"]);
    expect(session.firstPartyMcpPermissions).toEqual(["sessions:read"]);
  }, 60_000);

  test("a manual setup caller ceiling does not become generated-session standing policy", async () => {
    if (!available) return;
    const grant = await workspaceGrant();
    const task = await generatedTask(grant, null);
    const { session, accepted, result } = await dispatchGeneratedSession(
      grant,
      task.id,
      {},
      {
        triggerType: "manual",
        initiator: { kind: "subject", subjectId: grant.subjectId },
        credentialRestriction: "developer_setup",
        agentRunUsageIdempotencyKey: `manual-setup-${crypto.randomUUID()}`,
      },
    );
    expect(TurnExecutionPolicyV1.parse(accepted?.turnExecutionPolicy).credentialRestriction).toBe(
      "developer_setup",
    );
    expect(readTurnExecutionPolicyV1(session.metadata).kind).toBe("absent");
    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: session.id,
      workflowId: result.workflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`unexpected claim: ${claimed.action}`);
    const frozen = readTurnExecutionPolicyV1(claimed.turn.metadata);
    expect(frozen.kind).toBe("valid");
    if (frozen.kind !== "valid") throw new Error("manual accepted turn policy missing");
    expect(frozen.policy.credentialRestriction).toBe("developer_setup");
  }, 60_000);

  test.each(["new_session_per_run", "reusable_session", "existing_session"] as const)(
    "%s dispatch freezes setup restriction into accepted runs and claimed turns",
    async (runMode) => {
      if (!available) return;
      const grant = await workspaceGrant();
      const { settings } = activities();
      const targetSession =
        runMode === "existing_session"
          ? await createSession(client.db, {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              initialMessage: "Existing schedule target",
              resources: [],
              tools: [],
              metadata: {},
              model: settings.openaiModel,
              // Match the metadata-free target's database admission default.
              reasoningEffort: "medium",
              latencyMode: "standard",
              sandboxBackend: "none",
            })
          : null;
      const task = await generatedTask(
        grant,
        {
          firstPartyMcpTools: ["set_session_title", "scheduled_tasks_list"],
          firstPartyMcpPermissions: ["sessions:read", "scheduled_tasks:manage"],
          sessionPolicy: null,
          credentialRestriction: "developer_setup",
        },
        runMode === "new_session_per_run"
          ? undefined
          : { runMode, ...(targetSession ? { targetSessionId: targetSession.id } : {}) },
      );
      const { session, accepted, result } = await dispatchGeneratedSession(grant, task.id);
      const policy = TurnExecutionPolicyV1.parse(accepted?.turnExecutionPolicy);
      expect(policy.credentialRestriction).toBe("developer_setup");
      if (runMode !== "existing_session") {
        const initial = readTurnExecutionPolicyV1(session.metadata);
        expect(initial.kind).toBe("valid");
        if (initial.kind !== "valid") throw new Error("generated session policy missing");
        expect(initial.policy).toEqual(policy);
      } else {
        expect(session.id).toBe(targetSession!.id);
        // A restricted occurrence does not rewrite the target's original authority.
        expect(session.metadata).toEqual({});
      }
      const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
        sessionId: session.id,
        workflowId: result.workflowId,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (claimed.action !== "claimed") throw new Error(`unexpected claim: ${claimed.action}`);
      const frozen = readTurnExecutionPolicyV1(claimed.turn.metadata);
      expect(frozen.kind).toBe("valid");
      if (frozen.kind !== "valid") throw new Error("scheduled accepted turn policy missing");
      expect(frozen.policy.credentialRestriction).toBe("developer_setup");
    },
    60_000,
  );

  for (const runMode of ["new_session_per_run", "reusable_session"] as const) {
    test.each(["missing", "altered"] as const)(
      `${runMode} rejects %s standing setup policy during generated-session binding`,
      async (tampering) => {
        if (!available) return;
        const grant = await workspaceGrant();
        const task = await generatedTask(
          grant,
          {
            firstPartyMcpTools: ["set_session_title", "scheduled_tasks_list"],
            firstPartyMcpPermissions: ["sessions:read", "scheduled_tasks:manage"],
            sessionPolicy: null,
            credentialRestriction: "developer_setup",
          },
          runMode === "reusable_session" ? { runMode } : undefined,
        );
        const create = opengeniDb.createSessionWithIdempotencyKeyResult;
        const creation = spyOn(
          opengeniDb,
          "createSessionWithIdempotencyKeyResult",
        ).mockImplementation(async (db, input) => {
          const policy = readTurnExecutionPolicyV1(input.metadata);
          expect(policy.kind).toBe("valid");
          if (policy.kind !== "valid") throw new Error("standing setup policy missing");
          expect(policy.policy.credentialRestriction).toBe("developer_setup");
          const metadata = { ...input.metadata };
          if (tampering === "missing") {
            delete metadata.turnExecutionPolicyV1;
          } else {
            Object.assign(
              metadata,
              metadataWithTurnExecutionPolicyV1({}, { ...policy.policy, latencyMode: "priority" }),
            );
          }
          return await create(db, { ...input, metadata });
        });
        try {
          const { activities: scheduled } = activities();
          expect(
            await scheduled.dispatchScheduledTaskRun({
              workspaceId: grant.workspaceId,
              taskId: task.id,
              triggerType: "scheduled",
              producerKey: `scheduled-creator-${crypto.randomUUID()}`,
            }),
          ).toEqual({ action: "blocked", reason: "scheduled_run_terminal" });
          expect(creation).toHaveBeenCalledTimes(1);
          const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, task.id, 10);
          expect(run).toMatchObject({
            status: "failed",
            error: "scheduled_run_authority_proof_rejected",
          });
          const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
            workspaceId: grant.workspaceId,
            runId: run!.id,
          });
          expect(
            TurnExecutionPolicyV1.parse(accepted?.turnExecutionPolicy).credentialRestriction,
          ).toBe("developer_setup");
        } finally {
          creation.mockRestore();
        }
      },
      60_000,
    );
  }
});
