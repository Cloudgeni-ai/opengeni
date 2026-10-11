import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  adoptConnectedMachineSessionBackgroundCommand,
  appendSessionEvents,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createClaudeSubscriptionAccount,
  createDb,
  createSession,
  createXaiSubscriptionCredential,
  initializeSessionStartAtomically,
  listOutstandingSessionSystemUpdates,
  markSessionWorkflowWakeDelivered,
  setInitialActiveClaudeCredential,
  setInitialActiveXaiCredential,
  settleConnectedMachineSessionBackgroundCommand,
  settleSessionInputWait,
  settleSessionIdleWithParentOutbox,
  upsertOrganizationClaudeSubscription,
  upsertOrganizationXaiSubscription,
  waitForSessionInputWithEvent,
  type SessionWorkflowWakeDeliveryResult,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

import { notifyParentOfChildIdle, type NotifyServices } from "../src/activities/parent-wake";
import { SUBSCRIPTION_PROVIDER_CUTOVER_MIGRATIONS } from "@opengeni/db";

// Characterizes the legacy SuperGrok runtime, which runs only before the
// drained SuperGrok cutover: the database withholds that migration. Removed
// with the legacy runtime.
const LEGACY_XAI_WORLD = {
  withheldMigrations: [SUBSCRIPTION_PROVIDER_CUTOVER_MIGRATIONS.xai!],
};

// The child-to-parent handoff with real PostgreSQL. Only the Temporal
// transport is replaced: the recorder stands in for signalWithStart and then
// runs the same durable acknowledgement the production signaler runs.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
type PoolSnapshot =
  | { version: 1; scope: "organization" | "workspace" }
  | { version: 1; scope: "user"; authorityGeneration: number };

let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb> | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-parent-wake", LEGACY_XAI_WORLD);
  if (!shared) {
    if (requireRealDatabase) throw new Error("Parent wake PostgreSQL harness is unavailable");
    console.warn("[worker-parent-wake] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

test.each(["organization", "personal"] as const)(
  "SUB-ACCESS-01: real child, background-command, and wait-timeout producers coalesce with accepted %s Claude and SuperGrok snapshots",
  async (scope) => {
    if (!shared || !client) return;
    const admin = shared.admin;
    const db = client.db;
    const suffix = crypto.randomUUID();
    const subjectId = `user:${suffix}`;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('Worker parent wake SUB-ACCESS-01') returning id`;
    const accountId = account!.id;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${accountId}, 'Shared test workspace') returning id`;
    const workspaceId = workspace!.id;
    const encryptionKey = new Uint8Array(32).fill(23);
    const [personalWorkspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${accountId}, 'Personal test fixture') returning id`;
    await admin`insert into workspace_inference_controls (account_id, workspace_id) values (${accountId}, ${workspaceId})`;
    await admin`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) values (
        ${accountId}, ${subjectId}, 'owner', 'active', ${personalWorkspace!.id}
      )`;
    await admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, role, permissions
      ) values (
        ${accountId}, ${workspaceId}, ${subjectId}, 'owner', '[]'::jsonb
      )`;

    if (scope === "personal") {
      const claudeIdentity = crypto.randomUUID();
      const claude = await createClaudeSubscriptionAccount(db, {
        accountId,
        workspaceId,
        subjectId,
        scope: "user",
        encryptionKey,
        secret: {
          version: 1,
          token: "sk-ant-oat01-parent-wake-personal",
          identity: { accountUuid: claudeIdentity, deviceId: "d".repeat(64) },
        },
        providerAccountId: claudeIdentity,
        label: null,
        accountEmail: null,
        planType: "claude_max",
        expiresAt: null,
      });
      await setInitialActiveClaudeCredential(db, {
        accountId,
        workspaceId,
        subjectId,
        authoritySnapshot: claude.authoritySnapshot,
        credentialId: claude.account.id,
      });
      const xai = await createXaiSubscriptionCredential(db, {
        accountId,
        workspaceId,
        subjectId,
        scope: "user",
        encryptionKey,
        secret: { version: 1, accessToken: "parent-wake-personal" },
        providerAccountId: `parent-wake-personal-${crypto.randomUUID()}`,
      });
      await setInitialActiveXaiCredential(db, {
        accountId,
        workspaceId,
        subjectId,
        authoritySnapshot: xai.authoritySnapshot,
        credentialId: xai.account.id,
      });
    } else {
      const claudeIdentity = crypto.randomUUID();
      await upsertOrganizationClaudeSubscription(db, {
        organizationId: accountId,
        actorSubjectId: subjectId,
        encryptionKey,
        secret: {
          version: 1,
          token: "sk-ant-oat01-parent-wake-org",
          identity: { accountUuid: claudeIdentity, deviceId: "e".repeat(64) },
        },
        providerAccountId: claudeIdentity,
        label: null,
        accountEmail: null,
        expiresAt: null,
      });
      await upsertOrganizationXaiSubscription(db, {
        organizationId: accountId,
        actorSubjectId: subjectId,
        providerAccountId: `parent-wake-org-${crypto.randomUUID()}`,
        encryptionKey,
        secret: { version: 1, accessToken: "parent-wake-org" },
        label: null,
        accountEmail: null,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    }

    async function start(
      message: string,
      parent?: {
        session: { id: string };
        turn: { id: string; executionGeneration: number };
        attemptId: string;
      },
    ) {
      const [parentAuthority] = parent
        ? await admin<{ claude: PoolSnapshot; xai: PoolSnapshot }[]>`
            select claude_provider_account_authority_snapshot as claude,
              xai_provider_account_authority_snapshot as xai
            from session_turns where id = ${parent.turn.id}`
        : [];
      const session = await createSession(db, {
        accountId,
        workspaceId,
        subjectId,
        ...(parent
          ? {
              parentSessionId: parent.session.id,
              initialClaudeProviderAccountAuthoritySnapshot: parentAuthority!.claude,
              initialXaiProviderAccountAuthoritySnapshot: parentAuthority!.xai,
              createdByActor: {
                type: "agent_attempt" as const,
                attemptId: parent.attemptId,
                sessionId: parent.session.id,
                turnId: parent.turn.id,
                executionGeneration: parent.turn.executionGeneration,
              },
            }
          : {}),
        initialMessage: message,
        resources: [],
        tools: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        model: "scripted-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none",
      });
      await initializeSessionStartAtomically(db, {
        accountId,
        workspaceId,
        sessionId: session.id,
        clientEventId: `initial:${session.id}`,
        reasoningEffortFallback: "low",
        createdEventPayload: {},
      });
      const attemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(db, workspaceId, {
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId,
        dispatchId: `dispatch-${crypto.randomUUID()}`,
        trigger: { kind: "next" },
      });
      if (claimed.action !== "claimed") throw new Error("turn was not claimed");
      await appendSessionEvents(db, workspaceId, session.id, [
        {
          type: "turn.started",
          turnId: claimed.turn.id,
          turnGeneration: claimed.turn.executionGeneration,
          turnAttemptId: attemptId,
          payload: { triggerEventId: claimed.turn.triggerEventId },
        },
      ]);
      return { session, turn: claimed.turn, attemptId };
    }

    async function settleIdle(started: Awaited<ReturnType<typeof start>>) {
      const result = await applySessionTurnSettlement(db, workspaceId, {
        sessionId: started.session.id,
        turnId: started.turn.id,
        triggerEventId: started.turn.triggerEventId,
        attemptId: started.attemptId,
        turnStatus: "completed",
        sessionStatus: "idle",
        activeTurnId: null,
        events: [{ type: "turn.completed", payload: { reason: "test" } }],
      });
      expect(result.action).toBe("settled");
    }

    const parent = await start("delegate and wait for child work");
    const [accepted] = await admin<{ claude: PoolSnapshot; xai: PoolSnapshot }[]>`
      select claude_provider_account_authority_snapshot as claude,
        xai_provider_account_authority_snapshot as xai
      from session_turns where id = ${parent.turn.id}`;
    expect(accepted?.claude.scope).toBe(scope === "personal" ? "user" : "organization");
    expect(accepted?.xai).toEqual(accepted?.claude);

    const child = await start("complete delegated work", parent);
    const [childAuthority] = await admin<{ claude: PoolSnapshot; xai: PoolSnapshot }[]>`
      select claude_provider_account_authority_snapshot as claude,
        xai_provider_account_authority_snapshot as xai
      from session_turns where id = ${child.turn.id}`;
    expect(childAuthority).toEqual(accepted);

    const wait = await waitForSessionInputWithEvent(db, workspaceId, parent.session.id, {
      reason: "waiting for child completion",
      timeoutSeconds: 600,
      command: {
        accountId,
        actor: {
          type: "agent_attempt",
          sessionId: parent.session.id,
          turnId: parent.turn.id,
          attemptId: parent.attemptId,
          executionGeneration: parent.turn.executionGeneration,
        },
        operationKey: crypto.randomUUID(),
      },
    });
    const command = {
      accountId,
      workspaceId,
      sessionId: parent.session.id,
      commandId: crypto.randomUUID(),
      controlWorkspaceId: workspaceId,
      enrollmentId: crypto.randomUUID(),
      connectionInstanceId: crypto.randomUUID(),
      opId: crypto.randomUUID(),
    };
    await adoptConnectedMachineSessionBackgroundCommand(db, {
      ...command,
      turnId: parent.turn.id,
      attemptId: parent.attemptId,
      executionGeneration: parent.turn.executionGeneration,
      command: "printf completed",
    });
    await settleConnectedMachineSessionBackgroundCommand(db, {
      ...command,
      outcome: "exited",
      exitCode: 0,
      reason: "op_exit",
    });

    await settleIdle(parent);
    await settleIdle(child);
    const boundary = await settleSessionIdleWithParentOutbox(db, workspaceId, child.session.id);
    if (boundary.action !== "settled" || !boundary.notifyParent) {
      throw new Error("Child terminal-result outbox was not created");
    }
    const errors: string[] = [];
    const services: NotifyServices = {
      db,
      bus: { publish: async () => undefined } as unknown as EventBus,
      settings: {} as Settings,
      observability: {
        info: () => undefined,
        error: (message: string) => errors.push(message),
      } as unknown as NotifyServices["observability"],
      wakeSessionWorkflow: async (wake) =>
        await markSessionWorkflowWakeDelivered(db, {
          accountId: wake.accountId,
          workspaceId: wake.workspaceId,
          sessionId: wake.sessionId,
          temporalWorkflowId: wake.workflowId,
          wakeRevision: wake.wakeRevision,
        }),
    };
    await notifyParentOfChildIdle(services, workspaceId, child.session.id, boundary.episodeKey);
    expect(errors).toEqual([]);

    // Insert the eligible child update before the timeout so inbox planning
    // selects receiver-owned execution context before coalescing both with the
    // background-command result.
    await admin`
      update sessions set input_wait_until = now() - interval '1 second'
      where id = ${parent.session.id} and input_wait_turn_id = ${wait.waitTurnId}`;
    expect(
      await settleSessionInputWait(db, {
        accountId,
        workspaceId,
        sessionId: parent.session.id,
        waitTurnId: wait.waitTurnId,
        disposition: "timeout",
      }),
    ).toMatchObject({ action: "timeout" });

    const pending = await admin<
      { id: string; kind: string; claude: PoolSnapshot; xai: PoolSnapshot }[]
    >`
      select id, kind, claude_provider_account_authority_snapshot as claude,
        xai_provider_account_authority_snapshot as xai
      from session_system_updates
      where session_id = ${parent.session.id}
        and kind = any(${["child_terminal_result", "background_command_result", "session_wait_timeout"]}::text[])
      order by created_at, id`;
    expect(pending.map((row) => row.kind).sort()).toEqual([
      "background_command_result",
      "child_terminal_result",
      "session_wait_timeout",
    ]);
    for (const update of pending) {
      expect(update.claude).toEqual(accepted!.claude);
      expect(update.xai).toEqual(accepted!.xai);
    }

    const delivered = await claimSessionWorkForAttempt(db, workspaceId, {
      sessionId: parent.session.id,
      workflowId: `session-${parent.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(delivered.action).toBe("claimed");
    if (delivered.action !== "claimed") throw new Error("Coalesced updates were not delivered");
    const [deliveredAuthority] = await admin<
      {
        claude: PoolSnapshot;
        xai: PoolSnapshot;
        execution_context_turn_id: string | null;
      }[]
    >`
      select claude_provider_account_authority_snapshot as claude,
        xai_provider_account_authority_snapshot as xai, execution_context_turn_id
      from session_turns where id = ${delivered.turn.id}`;
    expect(deliveredAuthority).toMatchObject(accepted!);
    expect(deliveredAuthority?.execution_context_turn_id).toBe(parent.turn.id);
    const deliveredRows = await admin<{ state: string; delivered_turn_id: string | null }[]>`
      select state, delivered_turn_id from session_system_updates
      where id = any(${pending.map((row) => row.id)}::uuid[])
      order by created_at, id`;
    expect(deliveredRows).toEqual(
      pending.map(() => ({ state: "delivered", delivered_turn_id: delivered.turn.id })),
    );
  },
);

test("a finished child signals its parent parked in wait_for_input immediately", async () => {
  if (!shared || !client) return;
  const admin = shared.admin;
  const db = client.db;
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "worker-parent-wake",
    accountExternalId: `account-${suffix}`,
    accountName: "Worker parent wake",
    workspaceExternalSource: "worker-parent-wake",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Worker parent wake",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;

  async function start(
    message: string,
    parent?: {
      session: { id: string };
      turn: { id: string; executionGeneration: number };
      attemptId: string;
    },
  ) {
    const [parentAuthority] = parent
      ? await admin<
          { xai: PoolSnapshot; claude: PoolSnapshot }[]
        >`select xai_provider_account_authority_snapshot as xai,
            claude_provider_account_authority_snapshot as claude
          from session_turns where id = ${parent.turn.id}`
      : [];
    const session = await createSession(db, {
      accountId,
      workspaceId,
      ...(parent
        ? {
            parentSessionId: parent.session.id,
            initialXaiProviderAccountAuthoritySnapshot: parentAuthority!.xai,
            initialClaudeProviderAccountAuthoritySnapshot: parentAuthority!.claude,
            createdByActor: {
              type: "agent_attempt" as const,
              attemptId: parent.attemptId,
              sessionId: parent.session.id,
              turnId: parent.turn.id,
              executionGeneration: parent.turn.executionGeneration,
            },
          }
        : {}),
      initialMessage: message,
      resources: [],
      tools: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error("turn was not claimed");
    await appendSessionEvents(db, workspaceId, session.id, [
      {
        type: "turn.started",
        turnId: claimed.turn.id,
        turnGeneration: claimed.turn.executionGeneration,
        turnAttemptId: attemptId,
        payload: { triggerEventId: claimed.turn.triggerEventId },
      },
    ]);
    // The start wake is consumed by this claim long before the turn ends.
    await admin`update session_workflow_wake_outbox set delivered_revision = wake_revision
      where session_id = ${session.id}`;
    return { session, turn: claimed.turn, attemptId };
  }

  async function settleIdle(started: Awaited<ReturnType<typeof start>>) {
    const settled = await applySessionTurnSettlement(db, workspaceId, {
      sessionId: started.session.id,
      turnId: started.turn.id,
      triggerEventId: started.turn.triggerEventId,
      attemptId: started.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { reason: "test" } }],
    });
    expect(settled.action).toBe("settled");
  }

  // The parent delegates, parks in wait_for_input, and its turn settles idle.
  const parent = await start("delegate the audit and wait");
  const child = await start("run the audit", parent);
  await waitForSessionInputWithEvent(db, workspaceId, parent.session.id, {
    reason: "waiting for the audit child",
    timeoutSeconds: 600,
    command: {
      accountId,
      actor: {
        type: "agent_attempt",
        sessionId: parent.session.id,
        turnId: parent.turn.id,
        attemptId: parent.attemptId,
        executionGeneration: parent.turn.executionGeneration,
      },
      operationKey: crypto.randomUUID(),
    },
  });
  await settleIdle(parent);
  const [deadline] = await admin<Array<{ wake_revision: number | string; reason: string }>>`
    select wake_revision, reason from session_workflow_wake_outbox
    where session_id = ${parent.session.id}`;
  expect(deadline?.reason).toBe("session_input_wait_deadline");

  // A close racing the still-owned turn cannot publish a parent result.
  expect(await settleSessionIdleWithParentOutbox(db, workspaceId, child.session.id)).toEqual({
    action: "stale",
    episodeKey: null,
    events: [],
  });
  expect(await listOutstandingSessionSystemUpdates(db, workspaceId, parent.session.id)).toEqual([]);

  // The child finishes; its idle boundary commits the parent outbox row.
  await settleIdle(child);
  const boundary = await settleSessionIdleWithParentOutbox(db, workspaceId, child.session.id);
  if (boundary.action !== "settled" || !boundary.notifyParent) {
    throw new Error("child idle boundary did not notify its parent");
  }

  const signals: Array<{
    sessionId: string;
    wakeRevision: number;
    delivery: SessionWorkflowWakeDeliveryResult;
  }> = [];
  const errors: string[] = [];
  const services: NotifyServices = {
    db,
    bus: { publish: async () => undefined } as unknown as EventBus,
    settings: {} as Settings,
    observability: {
      info: () => undefined,
      error: (message: string) => {
        errors.push(message);
      },
    } as unknown as NotifyServices["observability"],
    wakeSessionWorkflow: async (wake) => {
      const delivery = await markSessionWorkflowWakeDelivered(db, {
        accountId: wake.accountId,
        workspaceId: wake.workspaceId,
        sessionId: wake.sessionId,
        temporalWorkflowId: wake.workflowId,
        wakeRevision: wake.wakeRevision,
      });
      signals.push({ sessionId: wake.sessionId, wakeRevision: wake.wakeRevision, delivery });
      return delivery;
    },
  };
  await notifyParentOfChildIdle(services, workspaceId, child.session.id, boundary.episodeKey);

  // A signal during close or an activity retry may revisit the same boundary.
  // It must neither create another result nor signal the parent twice.
  expect(await settleSessionIdleWithParentOutbox(db, workspaceId, child.session.id)).toMatchObject({
    action: "settled",
    episodeKey: boundary.episodeKey,
    notifyParent: true,
  });
  await notifyParentOfChildIdle(services, workspaceId, child.session.id, boundary.episodeKey);

  expect(errors).toEqual([]);
  const pending = await listOutstandingSessionSystemUpdates(db, workspaceId, parent.session.id);
  expect(pending.map((update) => update.kind)).toEqual(["child_terminal_result"]);
  // The parent is signalled now, on the deadline's revision, instead of waiting
  // for the periodic dispatcher. The acknowledgement keeps the revision open
  // until a claim consumes the result.
  expect(signals).toEqual([
    {
      sessionId: parent.session.id,
      wakeRevision: Number(deadline!.wake_revision),
      delivery: { action: "pending_admission", blocker: "pending_machine_input" },
    },
  ]);
}, 60_000);
