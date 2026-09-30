import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveModelProviderForTurn } from "@opengeni/config";
import { HTTPException } from "hono/http-exception";
import {
  applyCreditDebitAfterUse,
  bootstrapWorkspace,
  checkWorkspaceAllowance,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createWorkspaceProviderCustomModel,
  deleteWorkspaceProviderCustomModel,
  getWorkspaceProviderCustomModelForExecution,
  listWorkspaceProviderCustomModels,
  setMemberAllowance,
  setWorkspaceAllowance,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type SessionCommandActor,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  sendAgentSessionMessage,
  steerAgentSession,
  type AgentSessionCommandContext,
} from "../src/application/session-commands";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("agent-session-allowance");
  if (!acquired) throw new Error("Agent command allowance verification requires PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(targetModel = "scripted-model") {
  const human = `user:agent-allowance:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "agent-allowance",
    accountExternalId: crypto.randomUUID(),
    accountName: "Agent allowance",
    workspaceExternalSource: "agent-allowance",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Agent allowance",
    subjectId: human,
  });
  const grant = access.workspaceGrants[0]!;
  const personalId = crypto.randomUUID();
  await shared.admin`insert into workspaces(id,account_id,name)
    values(${personalId},${grant.accountId},'Personal')`;
  await shared.admin`insert into organization_memberships
    (account_id,subject_id,role,status,personal_workspace_id)
    values(${grant.accountId},${human},'owner','active',${personalId})`;
  const makeSession = async (model = "scripted-model") =>
    await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Session creator is not the command initiator",
      model,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: "user:unrelated-creator" },
    });
  const start = async (
    sessionId: string,
    actor: Exclude<SessionCommandActor, { type: "agent_attempt" }> = {
      type: "human",
      subjectId: human,
    },
    model = "scripted-model",
  ) => {
    await withWorkspaceSubjectSessionActivityRls(client.db, grant.workspaceId, human, (tx) =>
      submitHumanPromptInTransaction(tx, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        subjectId: human,
        actor,
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Start exact caller turn",
        resources: [],
        model,
        reasoningEffort: "medium",
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    );
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`Fixture claim failed: ${claimed.reason}`);
    return { ...claimed, attemptId };
  };
  const caller = await makeSession();
  const claimed = await start(caller.id);
  const target = await makeSession(targetModel);
  const activeTarget = await start(target.id, undefined, targetModel);
  const context: AgentSessionCommandContext = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: "agent:request-subject-is-not-causal-human",
    callerSessionId: caller.id,
    callerTurnId: claimed.turn.id,
    callerAttemptId: claimed.attemptId,
    callerExecutionGeneration: claimed.turn.executionGeneration,
  };
  const tasks: Array<() => Promise<void>> = [];
  const deps = {
    db: client.db,
    settings: testSettings({
      billingMode: "disabled",
      usageLimitsMode: "none",
      sandboxBackend: "none",
    }),
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: async () => undefined },
    schedulePromptPostCommit: (task: () => Promise<void>) => tasks.push(task),
  };
  return {
    ...grant,
    human,
    target,
    caller,
    claimed,
    activeTarget,
    context,
    deps,
    start,
    makeSession,
    tasks,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function snapshot(scope: Fixture) {
  const { workspaceId, target } = scope;
  const [state] = await shared.admin`
    select
      (select to_jsonb(s) from sessions s where s.id=${target.id}) as session,
      (select jsonb_agg(to_jsonb(t) order by t.id) from session_turns t
        where t.workspace_id=${workspaceId}) as turns,
      (select jsonb_agg(to_jsonb(a) order by a.id) from session_turn_attempts a
        where a.workspace_id=${workspaceId}) as attempts,
      (select jsonb_agg(to_jsonb(u) order by u.id) from session_system_updates u
        where u.workspace_id=${workspaceId}) as updates,
      (select jsonb_agg(to_jsonb(i) order by i.id) from session_attempt_interruptions i
        where i.workspace_id=${workspaceId}) as interruptions,
      (select jsonb_agg(to_jsonb(e) order by e.id) from session_events e
        where e.workspace_id=${workspaceId}) as events,
      (select jsonb_agg(to_jsonb(r) order by r.id) from session_command_receipts r
        where r.workspace_id=${workspaceId}) as receipts,
      (select jsonb_agg(to_jsonb(w) order by w.session_id) from session_workflow_wake_outbox w
        where w.workspace_id=${workspaceId}) as wakes`;
  return state;
}

async function exhaust(scope: Fixture, kind: "workspace" | "member") {
  const policy = {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    actorSubjectId: scope.human,
  };
  await setWorkspaceAllowance(client.db, {
    ...policy,
    includedCredits: kind === "workspace" ? 5 : 100,
    period: "monthly",
    expectedVersion: 0,
  });
  if (kind === "member")
    await setMemberAllowance(client.db, {
      ...policy,
      subjectId: scope.human,
      rule: { credits: 5 },
      expectedVersion: 0,
    });
  await applyCreditDebitAfterUse(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    type: "model",
    amountMicros: 10,
    sourceType: "model_response",
    sourceId: `${scope.claimed.turn.id}:exhaust`,
    idempotencyKey: crypto.randomUUID(),
  });
  const refusal = await checkWorkspaceAllowance(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    subjectId: scope.human,
  });
  expect(refusal).toMatchObject({ code: "allowance_exhausted", scope: kind });
  return refusal!;
}

function command(scope: Fixture, kind: "send" | "steer", key = crypto.randomUUID()) {
  return kind === "send"
    ? sendAgentSessionMessage(scope.deps, scope.context, {
        targetSessionId: scope.target.id,
        text: "Delegated Send",
        idempotencyKey: key,
      })
    : steerAgentSession(scope.deps, scope.context, {
        targetSessionId: scope.target.id,
        instruction: "Delegated Steer",
        idempotencyKey: key,
      });
}

describe("fresh delegated Agent Send and Steer allowance admission", () => {
  for (const action of ["send", "steer"] as const) {
    test.each(["workspace", "member"] as const)(
      `${action} refuses a retained credits-funded target under %s exhaustion without writes`,
      async (kind) => {
        const scope = await fixture("gpt-5.6-luna");
        scope.deps.settings = testSettings({
          billingMode: "disabled",
          usageLimitsMode: "none",
          sandboxBackend: "none",
          modelCostPolicyJson: '{"gpt-5.6-luna":"credits"}',
        });
        expect(
          resolveModelProviderForTurn(scope.deps.settings, scope.target.model)?.model.cost,
        ).toBe("credits");
        const refusal = await exhaust(scope, kind);
        const before = await snapshot(scope);
        await expect(command(scope, action)).rejects.toMatchObject({
          status: 402,
          cause: { allowed: false, ...refusal },
        });
        expect(await snapshot(scope)).toEqual(before);
        expect(scope.tasks).toHaveLength(0);
      },
      60_000,
    );
    test.each(["workspace", "member"] as const)(
      `${action} refuses %s exhaustion before accepted work or interruption`,
      async (kind) => {
        const scope = await fixture();
        const refusal = await exhaust(scope, kind);
        const before = await snapshot(scope);
        for (let repeat = 0; repeat < 2; repeat++) {
          try {
            await command(scope, action);
            throw new Error("Expected target allowance refusal");
          } catch (error) {
            expect(error).toBeInstanceOf(HTTPException);
            expect(error).toMatchObject({
              status: 402,
              cause: { allowed: false, ...refusal },
            });
          }
        }
        expect(await snapshot(scope)).toEqual(before);
        expect(scope.tasks).toHaveLength(0);
      },
      60_000,
    );
    test(`${action} replays committed receipt after mutable exhaustion without more writes`, async () => {
      const scope = await fixture();
      const key = crypto.randomUUID();
      const applied = await command(scope, action, key);
      expect(applied.replay).toBe(false);
      await exhaust(scope, "workspace");
      const before = await snapshot(scope);
      const replay = await command(scope, action, key);
      expect(replay).toMatchObject({
        replay: true,
        updateId: applied.updateId,
        receipt: { id: applied.receipt.id },
      });
      expect(await snapshot(scope)).toEqual(before);
    }, 60_000);
    test(`${action} service caller cannot borrow an exhausted target member`, async () => {
      const scope = await fixture();
      await exhaust(scope, "member");
      const serviceSession = await scope.makeSession();
      const service = await scope.start(serviceSession.id, {
        type: "service",
        subjectId: "service:automated-work",
      });
      expect(service.turn.initiatingHumanSubjectId).toBeNull();
      scope.context = {
        ...scope.context,
        callerSessionId: serviceSession.id,
        callerTurnId: service.turn.id,
        callerAttemptId: service.attemptId,
        callerExecutionGeneration: service.turn.executionGeneration,
      };
      expect((await command(scope, action)).replay).toBe(false);
    }, 60_000);
    test(`${action} externally funded target does not acquire a credit allowance gate`, async () => {
      const scope = await fixture();
      await exhaust(scope, "workspace");
      scope.deps.settings = testSettings({
        billingMode: "disabled",
        usageLimitsMode: "none",
        sandboxBackend: "none",
        modelCostPolicyJson: '{"scripted-model":"free"}',
      });
      expect((await command(scope, action)).replay).toBe(false);
    }, 60_000);
    for (const providerKind of ["vercel_gateway", "openrouter"] as const) {
      test.each(["workspace", "member"] as const)(
        `${action} retains retired BYOK ${providerKind} funding under %s exhaustion`,
        async (kind) => {
          const upstreamModelId = "anthropic/claude-sonnet-4.6";
          const providerId = providerKind === "vercel_gateway" ? "gateway" : "openrouter";
          const scope = await fixture(`workspace-${providerId}/${upstreamModelId}`);
          const modelScope = {
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            providerKind,
          };
          const created = await createWorkspaceProviderCustomModel(client.db, {
            ...modelScope,
            upstreamModelId,
            operationId: crypto.randomUUID(),
            requestHash: "1".repeat(64),
            createdBySubjectId: scope.human,
          });
          if (!created) throw new Error("BYOK custom model creation conflicted");
          expect(
            await deleteWorkspaceProviderCustomModel(client.db, {
              ...modelScope,
              customModelId: created.id,
              expectedVersion: created.version,
              operationId: crypto.randomUUID(),
              requestHash: "2".repeat(64),
            }),
          ).toMatchObject({ outcome: "success" });
          expect(await listWorkspaceProviderCustomModels(client.db, modelScope)).toEqual([]);
          expect(
            await getWorkspaceProviderCustomModelForExecution(client.db, {
              ...modelScope,
              upstreamModelId,
            }),
          ).toMatchObject({ id: created.id, retiredAt: expect.any(Date) });
          const refusal = await exhaust(scope, kind);
          const applied = await command(scope, action);
          expect(applied.replay).toBe(false);
          expect(
            await checkWorkspaceAllowance(client.db, {
              accountId: scope.accountId,
              workspaceId: scope.workspaceId,
              subjectId: scope.human,
            }),
          ).toEqual(refusal);
        },
        60_000,
      );
    }
  }
});
