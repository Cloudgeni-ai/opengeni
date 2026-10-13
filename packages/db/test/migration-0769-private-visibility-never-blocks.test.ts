import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  beginSessionRealtimeInTransaction,
  claimSessionWorkForAttempt,
  createDb,
  createScheduledTask,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  inspectSessionVisibilityChange,
  settleSessionAttemptInterruptions,
  stopSessionWorkForVisibilityChange,
  submitHumanPromptInTransaction,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
  type SessionActivityDatabase,
} from "../src/index";

// Migration 0769: nothing in a chat refuses making it Only me. Another
// member's pending input, their account choice for the chat, their running
// turn and a live voice session are all listed once and then dropped or
// stopped by the one confirmed change; afterwards none of that member's
// authority is usable from the chat.
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase(
    "migration-0769-private-visibility-never-blocks",
  );
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture() {
  const userId = `never-blocks-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const context = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Never blocks owner",
  });
  const legacyWorkspaceId = context.defaultWorkspaceId!;
  const personal = context.workspaceGrants.find((grant) => grant.workspaceId !== legacyWorkspaceId);
  if (!personal?.workspaceId) throw new Error("managed human has no personal workspace");
  const accountId = personal.accountId;
  const workspaceId = personal.workspaceId;
  const privateSessions = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: accountId,
    actorSubjectId: subjectId,
  });
  if (!privateSessions.enabled) {
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: privateSessions.version,
      operationId: crypto.randomUUID(),
    });
  }
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return {
    accountId,
    workspaceId,
    subjectId,
    actorSubjectId: subjectId,
    sessionId: session.id,
    other: `user:never-blocks-member-${crypto.randomUUID()}`,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function submit(f: Fixture, text: string): Promise<string> {
  const accepted = await withWorkspaceSubjectSessionActivityRls(
    client.db,
    f.workspaceId,
    f.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sessionId: f.sessionId,
          subjectId: f.subjectId,
          actor: { type: "human", subjectId: f.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text,
          resources: [],
          reasoningEffortFallback: "medium",
          source: "user",
        }),
      ),
  );
  return accepted.turnId;
}

/** Forge persisted state another member's activity would have left. */
async function forge(statement: (tx: typeof shared.admin) => Promise<unknown>): Promise<void> {
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role=replica`;
    await statement(tx as unknown as typeof shared.admin);
  });
}

/** A pending update carrying `subject`'s frozen authority (a delegation and causal subject). */
async function insertPendingUpdate(
  f: Fixture,
  subject: string,
  options: { forge?: boolean } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const delegation = {
    kind: "oauth2",
    serverId: `account-${connectionId}`,
    connectionId,
    connectionType: "mcp",
    ownerSubjectId: subject,
    providerDomain: "mcp.example.test",
    canonicalServerId: "example-mcp",
  };
  const insert = (tx: typeof shared.admin) => tx`insert into session_system_updates
      (id, account_id, workspace_id, session_id, kind, classification, source_id, dedupe_key,
       summary, payload, lineage, personal_connection_delegations, xai_provider_account_authority_snapshot)
      values (${id}, ${f.accountId}, ${f.workspaceId}, ${f.sessionId}, 'session_wait_timeout', 'info',
        ${id}, ${id}, 'Wait ended',
        ${tx.json({ type: "session_wait_timeout", deadlineAt: new Date().toISOString() } as never)},
        ${tx.json({ connectionAuthoritySubjectId: subject } as never)},
        ${tx.json([delegation] as never)}, ${tx.json({ version: 1, scope: "workspace" } as never)})`;
  if (options.forge === false) await insert(shared.admin);
  else await forge(insert);
  return id;
}

/** Another member's personal subscription account, chosen for this chat. */
async function pinOtherPersonsAccount(f: Fixture): Promise<string> {
  const connectionId = crypto.randomUUID();
  await forge(async (tx) => {
    await tx`insert into subscription_connections (
        id, account_id, provider, credential_encrypted, ownership, scope_kind,
        owner_organization_membership_id, owner_subject_id, authority_id,
        authority_resource_kind, authority_generation, provider_account_id
      ) values (
        ${connectionId}::uuid, ${f.accountId}::uuid, 'codex', 'sealed', 'personal', 'people',
        ${crypto.randomUUID()}::uuid, ${f.other}, ${crypto.randomUUID()}::uuid,
        'subscription_connection', 1, ${`chatgpt-${connectionId}`}
      )`;
    await tx`insert into subscription_session_bindings (
        account_id, workspace_id, session_id, provider, connection_id, model_id, choice,
        last_switch_reason
      ) values (
        ${f.accountId}::uuid, ${f.workspaceId}::uuid, ${f.sessionId}::uuid, 'codex',
        ${connectionId}::uuid, 'gpt-test', 'explicit', 'explicit_choice'
      )`;
  });
  return connectionId;
}

async function startVoice(f: Fixture): Promise<void> {
  await withWorkspaceSessionActivityRls(client.db, f.workspaceId, (db) =>
    db.transaction((tx) =>
      beginSessionRealtimeInTransaction(tx as unknown as SessionActivityDatabase, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: f.sessionId,
        operationId: crypto.randomUUID(),
        ownerSubjectId: f.subjectId,
        browserInstanceId: `browser-${crypto.randomUUID()}`,
        ownerKey: `owner-key-${crypto.randomUUID()}-${crypto.randomUUID()}`,
        model: "gpt-live-1-boulder-alpha",
      }),
    ),
  );
}

async function liveSchedule(f: Fixture): Promise<string> {
  const task = await createScheduledTask(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    name: "Targets this chat",
    status: "active",
    schedule: {
      type: "once",
      runAt: new Date(Date.now() + 7_200_000).toISOString(),
      timeZone: "UTC",
    },
    temporalScheduleId: `schedule-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "skip",
    agentConfig: { prompt: "Check in", resources: [], tools: [], metadata: {} },
    metadata: {},
    createdBy: { kind: "service", subjectId: "scheduler" },
  });
  await forge(
    (tx) =>
      tx`update scheduled_tasks set reusable_session_id = ${f.sessionId} where id = ${task.id}`,
  );
  return task.id;
}

function privatize(f: Fixture, stopActiveWork: boolean) {
  return transitionSessionVisibility(client.db, {
    workspaceId: f.workspaceId,
    sessionId: f.sessionId,
    actorSubjectId: f.subjectId,
    targetVisibility: "user_private",
    expectedAuthorityEpoch: 1,
    operationKey: `visibility-${crypto.randomUUID()}`,
    ...(stopActiveWork ? { stopActiveWork: true } : {}),
  });
}

describe("making a chat Only me never refuses", () => {
  test("another member's input, account choice and running turn are dropped by one confirmation", async () => {
    const f = await fixture();
    // Another member's turn is running on a worker, with a message queued behind it.
    const running = await submit(f, "their running turn");
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
      sessionId: f.sessionId,
      workflowId: `session-${f.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed" || claimed.turn.id !== running) {
      throw new Error("turn was not claimed");
    }
    const queued = await submit(f, "queued behind it");
    await forge(
      (tx) => tx`update session_turns
        set initiator_subject_id = ${f.other}, initiating_human_subject_id = ${f.other}
        where id in (${running}, ${queued})`,
    );
    const pendingUpdate = await insertPendingUpdate(f, f.other);
    const connectionId = await pinOtherPersonsAccount(f);
    await startVoice(f);
    const schedule = await liveSchedule(f);

    const work = {
      runningTurnCount: 1,
      queuedTurnCount: 1,
      activeGoal: false,
      liveVoice: true,
      otherPeoplePendingUpdateCount: 1,
      otherPeopleAccountChoiceCount: 1,
    };
    expect((await inspectSessionVisibilityChange(client.db, f)).work).toEqual(work);
    // Without the confirmation the change answers with the summary and changes nothing.
    await expect(privatize(f, false)).rejects.toMatchObject({
      name: "SessionVisibilityWorkConflictError",
      reason: "active_work",
      work,
    });
    const [untouched] = await shared.admin<Array<{ state: string }>>`
      select state from session_system_updates where id = ${pendingUpdate}`;
    expect(untouched!.state).toBe("pending");

    // The confirmed change: stop the live attempt (the worker settles it), then
    // the same consented request completes the change.
    const stopped = await stopSessionWorkForVisibilityChange(client.db, {
      ...f,
      expectedAuthorityEpoch: 1,
      operationKey: `stop-${crypto.randomUUID()}`,
    });
    expect(stopped).toMatchObject({ interruptedAttemptCount: 1, liveAttemptCount: 1 });
    await settleSessionAttemptInterruptions(client.db, f.workspaceId, f.sessionId, attemptId);
    const changed = await privatize(f, true);
    expect(changed).toMatchObject({
      visibility: "user_private",
      changed: true,
      cancelledUpdateCount: 1,
    });

    // Nothing of the other member's remains usable from the chat.
    const turns = await shared.admin<Array<{ status: string }>>`
      select status from session_turns where session_id = ${f.sessionId} order by position`;
    expect(turns.map((turn) => turn.status)).toEqual(["cancelled", "cancelled"]);
    const [update] = await shared.admin<Array<{ state: string }>>`
      select state from session_system_updates where id = ${pendingUpdate}`;
    expect(update!.state).toBe("cancelled");
    const bindings = await shared.admin`
      select 1 from subscription_session_bindings where session_id = ${f.sessionId}`;
    expect(bindings).toHaveLength(0);
    const [connection] = await shared.admin<Array<{ id: string }>>`
      select id from subscription_connections where id = ${connectionId}`;
    expect(connection?.id).toBe(connectionId);
    const voice = await shared.admin<Array<{ state: string; endReason: string }>>`
      select state, end_reason as "endReason" from session_realtime_modes
      where session_id = ${f.sessionId}`;
    expect(voice.map((row) => ({ ...row }))).toEqual([
      { state: "ended", endReason: "authority_revoked" },
    ]);
    // A schedule's runs are authorized per run; it is left as it was.
    const [task] = await shared.admin<Array<{ status: string }>>`
      select status from scheduled_tasks where id = ${schedule}`;
    expect(task!.status).toBe("active");

    // Input that arrives later with the other member's authority (for
    // example a command they started finishing) is never delivered here.
    const late = await insertPendingUpdate(f, f.other, { forge: false });
    const own = await insertPendingUpdate(f, f.subjectId, { forge: false });
    const states = await shared.admin<Array<{ id: string; state: string }>>`
      select id, state from session_system_updates where id in (${late}, ${own})`;
    expect(new Map(states.map((row) => [row.id, row.state]))).toEqual(
      new Map([
        [late, "cancelled"],
        [own, "pending"],
      ]),
    );
    expect((await inspectSessionVisibilityChange(client.db, f)).visibility).toBe("user_private");
  });

  test("an idle chat with only another member's account choice needs one confirmation", async () => {
    const f = await fixture();
    await pinOtherPersonsAccount(f);
    await expect(privatize(f, false)).rejects.toMatchObject({
      reason: "active_work",
      work: { otherPeopleAccountChoiceCount: 1, runningTurnCount: 0 },
    });
    expect(await privatize(f, true)).toMatchObject({ visibility: "user_private", changed: true });
    const bindings = await shared.admin`
      select 1 from subscription_session_bindings where session_id = ${f.sessionId}`;
    expect(bindings).toHaveLength(0);
  });

  test("the owner's own pending input carries over untouched", async () => {
    const f = await fixture();
    const own = await insertPendingUpdate(f, f.subjectId);
    expect((await inspectSessionVisibilityChange(client.db, f)).work).toMatchObject({
      otherPeoplePendingUpdateCount: 0,
      otherPeopleAccountChoiceCount: 0,
    });
    expect(await privatize(f, false)).toMatchObject({ visibility: "user_private" });
    const [row] = await shared.admin<Array<{ state: string }>>`
      select state from session_system_updates where id = ${own}`;
    expect(row!.state).toBe("pending");
  });
});
