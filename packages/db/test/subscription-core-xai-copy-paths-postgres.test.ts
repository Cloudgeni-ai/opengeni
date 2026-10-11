// M4 X2b: the compatibility copy on every path of design 5.3, "Accepted
// authority across the cutover", through the real runtime writers, as the
// restricted application role. Sources are accepted before the SuperGrok
// (`xai`) receipt; after it, each derived carrier must commit with exactly
// its source's record (the deferred commit-time check rejects a carrier
// whose writer skipped the copy), and a source without one yields the
// waiting `missing` copy: the `compat:dependent_sources_without_record`
// test. Codex never gets a record. The receipt is append-only, so this file
// uses its own database.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  addSessionSystemUpdate,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createScheduledTask,
  createSession,
  editQueuedTurnInTransaction,
  enqueueSessionTurn,
  ensureManagedAccessForUser,
  getOrCreateSessionSystemUpdateOutbox,
  initializeSessionStartAtomically,
  materializeGoalContinuation,
  sendAgentMessageInTransaction,
  settleSessionIdleWithParentOutbox,
  steerAgentSessionInTransaction,
  submitHumanPromptInTransaction,
  updateScheduledTask,
  withSessionRlsActorContext,
  withWorkspaceSessionActivityRls as withWorkspaceRls,
  withWorkspaceSubjectSessionActivityRls as withWorkspaceSubjectRls,
  type DbClient,
  type SessionCommandActor,
} from "../src";
import { rawRows } from "../src/database";

setDefaultTimeout(180_000);
const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

type Grant = { accountId: string; workspaceId: string; subjectId: string };
type Agent = {
  sessionId: string;
  turnId: string;
  actor: Extract<SessionCommandActor, { type: "agent_attempt" }>;
};
type RecordContent = {
  personal: unknown[];
  shared_pool: "workspace" | "organization" | "none";
  legacy_scope: "organization" | "workspace" | "user" | "missing";
  owner_subject_id: string | null;
};

/** An ownerless shared record, as the cutover writes for a shared-workspace source. */
const SHARED: RecordContent = {
  personal: [],
  shared_pool: "workspace",
  legacy_scope: "workspace",
  owner_subject_id: null,
};
/** The waiting copy of a pre-receipt source the cutover missed. */
const MISSING: RecordContent = {
  personal: [],
  shared_pool: "none",
  legacy_scope: "missing",
  owner_subject_id: null,
};

async function workspace(): Promise<Grant> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client!.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "SuperGrok copy paths",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "SuperGrok copy paths",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
}

async function session(
  grant: Grant,
  options: { parentSessionId?: string; createdByActor?: Agent["actor"] } = {},
) {
  return await createSession(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "copy path fixture",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
    ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    ...(options.createdByActor ? { createdByActor: options.createdByActor } : {}),
  });
}

async function submit(
  grant: Grant,
  sessionId: string,
  text: string,
  extra: { expectedDraftRevision?: number; actor?: SessionCommandActor } = {},
) {
  return await withWorkspaceSubjectRls(client!.db, grant.workspaceId, grant.subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        subjectId: grant.subjectId,
        actor: extra.actor ?? { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text,
        resources: [],
        model: "scripted-model",
        reasoningEffort: "low",
        reasoningEffortFallback: "medium",
        source: "user",
        ...(extra.expectedDraftRevision !== undefined
          ? { expectedDraftRevision: extra.expectedDraftRevision }
          : {}),
      }),
    ),
  );
}

async function claim(grant: Grant, sessionId: string, attemptId = crypto.randomUUID()) {
  const claimed = await claimSessionWorkForAttempt(client!.db, grant.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`not claimed: ${claimed.reason}`);
  return claimed.turn;
}

/** A running agent: a session whose human-submitted turn holds a live attempt. */
async function agent(grant: Grant, origin: "human" | "service" = "human"): Promise<Agent> {
  const created = await session(grant);
  if (origin === "service") {
    await initializeSessionStartAtomically(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: created.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    });
  } else {
    await submit(grant, created.id, "agent is working");
  }
  const attemptId = crypto.randomUUID();
  const turn = await claim(grant, created.id, attemptId);
  return {
    sessionId: created.id,
    turnId: turn.id,
    actor: {
      type: "agent_attempt",
      sessionId: created.id,
      turnId: turn.id,
      attemptId,
      executionGeneration: turn.executionGeneration,
    },
  };
}

/**
 * A managed organization's owner in their Personal workspace, with a running
 * private session: task revisions record an exact human authorizer only for
 * an organization member.
 */
async function managed(): Promise<{ grant: Grant; caller: Agent }> {
  const userId = `xai-copy-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "SuperGrok copy paths",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const [membership] = await shared!.admin<{ personal_workspace_id: string }[]>`
    select personal_workspace_id::text as personal_workspace_id from organization_memberships
    where account_id = ${accountId}::uuid and subject_id = ${subjectId} and status = 'active'
      and revoked_at is null limit 1`;
  const grant = { accountId, workspaceId: membership!.personal_workspace_id, subjectId };
  const created = await withSessionRlsActorContext({ subjectId }, () =>
    createSession(client!.db, {
      accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "copy path fixture",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      visibility: "user_private",
      subjectId,
      createdBy: { kind: "subject", subjectId },
      createdByContext: {},
    }),
  );
  await withSessionRlsActorContext({ subjectId }, () =>
    enqueueSessionTurn(client!.db, {
      accountId,
      workspaceId: grant.workspaceId,
      sessionId: created.id,
      triggerEventId: crypto.randomUUID(),
      temporalWorkflowId: `session-${created.id}`,
      source: "user",
      prompt: "copy path fixture",
      resources: [],
      tools: [],
      model: "scripted-model",
      reasoningEffort: "medium",
      sandboxBackend: "none",
      metadata: {},
      initiator: { kind: "subject", subjectId },
    }),
  );
  const attemptId = crypto.randomUUID();
  const turn = await claim(grant, created.id, attemptId);
  return {
    grant,
    caller: {
      sessionId: created.id,
      turnId: turn.id,
      actor: {
        type: "agent_attempt",
        sessionId: created.id,
        turnId: turn.id,
        attemptId,
        executionGeneration: turn.executionGeneration,
      },
    },
  };
}

function scheduledTask(grant: Grant, createdByActor?: Agent["actor"]) {
  const create = () =>
    createScheduledTask(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "SuperGrok copy path task",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `xai-copy-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "Check the deployment", resources: [], tools: [], metadata: {} },
      metadata: {},
      ...(createdByActor
        ? { createdByActor }
        : { createdBy: { kind: "subject", subjectId: grant.subjectId } }),
    } as never);
  return createdByActor
    ? create()
    : withSessionRlsActorContext({ subjectId: grant.subjectId }, create);
}

/** A record the drained cutover writes for a pre-receipt source (the owner writes it). */
async function cutoverRecord(
  grant: Grant,
  carrier: { kind: "session_initial" | "session_turn" | "scheduled_task"; id: string },
  content: RecordContent,
) {
  const column = {
    session_initial: "session_id",
    session_turn: "turn_id",
    scheduled_task: "scheduled_task_id",
  }[carrier.kind];
  await shared!.admin.unsafe(
    `insert into opengeni_private.subscription_authority_compat (
      account_id, workspace_id, provider, carrier_kind, ${column}, personal, shared_pool,
      legacy_scope, owner_subject_id
    ) values ($1::uuid, $2::uuid, 'xai', $3, $4::uuid, $5::text::jsonb, $6, $7, $8)`,
    [
      grant.accountId,
      grant.workspaceId,
      carrier.kind,
      carrier.id,
      JSON.stringify(content.personal),
      content.shared_pool,
      content.legacy_scope,
      content.owner_subject_id,
    ],
  );
}

/** Every record of a carrier, by provider. */
async function records(carrierKind: string, carrierId: string, revision?: number) {
  return [
    ...(await shared!.admin<(RecordContent & { provider: string })[]>`
      select provider, personal, shared_pool, legacy_scope, owner_subject_id
      from opengeni_private.subscription_authority_compat
      where carrier_kind = ${carrierKind}
        and ${carrierId}::uuid in (session_id, turn_id, scheduled_task_id, system_update_id, outbox_id)
        and (${revision ?? null}::bigint is null or task_authority_revision = ${revision ?? null}::bigint)
      order by provider`),
  ];
}

function only(content: RecordContent) {
  return [{ provider: "xai", ...content }];
}

async function updatesOf(sessionId: string) {
  return await shared!.admin<{ id: string; kind: string; delivered_turn_id: string | null }[]>`
    select id::text as id, kind, delivered_turn_id::text as delivered_turn_id
    from session_system_updates where session_id = ${sessionId}::uuid order by created_at, id`;
}

async function turnsOf(sessionId: string) {
  return await shared!.admin<{ id: string; source: string; status: string }[]>`
    select id::text as id, source, status from session_turns
    where session_id = ${sessionId}::uuid order by position, created_at`;
}

/** Settle a claimed turn idle. */
async function settleIdle(
  grant: Grant,
  sessionId: string,
  turn: { id: string; triggerEventId: string },
  attemptId: string,
) {
  const settled = await applySessionTurnSettlement(client!.db, grant.workspaceId, {
    sessionId,
    turnId: turn.id,
    triggerEventId: turn.triggerEventId,
    attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { reason: "test" } }],
  });
  if (settled.action !== "settled") throw new Error(`not settled: ${settled.action}`);
}

/** A session with an active goal whose human-accepted initial turn ran and settled idle. */
async function goalSession(grant: Grant) {
  const created = await createSession(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "start",
    resources: [],
    tools: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client!.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: created.id,
    clientEventId: `initial:${created.id}`,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    goal: { text: "Finish the copy path proof", mutationPolicy: "preserve_intent" },
  });
  const attemptId = crypto.randomUUID();
  const turn = await claim(grant, created.id, attemptId);
  await settleIdle(grant, created.id, turn, attemptId);
  return { sessionId: created.id, turnId: turn.id };
}

/**
 * One fixture world per expectation: `recorded` sources hold the cutover's
 * ownerless shared record, the others none (a missed source).
 */
type World = {
  grant: Grant;
  caller: Agent;
  /** A session that never ran: its own row is the receiving source. */
  target: { id: string };
  /** A session with two queued human prompts, the second edited after the receipt. */
  edited: { sessionId: string; turnId: string; version: number };
  /** A goal session whose human-accepted turn ran and settled idle. */
  goal: { sessionId: string; turnId: string };
  /** A managed owner's running agent and their human-created task, re-authorized after the receipt. */
  scheduled: { grant: Grant; caller: Agent; task: { id: string } };
};

async function world(): Promise<World> {
  const grant = await workspace();
  const caller = await agent(grant);
  const target = await session(grant, { parentSessionId: caller.sessionId });
  const editedSession = await session(grant);
  await submit(grant, editedSession.id, "first queued prompt");
  const second = await submit(grant, editedSession.id, "second queued prompt");
  const [secondRow] = await shared!.admin<{ version: number }[]>`
    select version from session_turns where id = ${second.turnId}::uuid`;
  const goal = await goalSession(grant);
  const owner = await managed();
  const task = await scheduledTask(owner.grant);
  const [revision] = await shared!.admin<{ count: number }[]>`
    select count(*)::int as count from scheduled_task_revision_authorities
    where task_id = ${task.id}::uuid`;
  if (revision!.count !== 1) throw new Error("the fixture task has no authorized revision");
  return {
    grant,
    caller,
    target: { id: target.id },
    edited: { sessionId: editedSession.id, turnId: second.turnId, version: secondRow!.version },
    goal,
    scheduled: { ...owner, task: { id: task.id } },
  };
}

let recorded: World | null = null;
let missed: World | null = null;
/** A service-origin agent (no human) and the owner-caused source it messages. */
let foreign: { grant: Grant; caller: Agent; target: { id: string } } | null = null;

beforeAll(async () => {
  if (!realDb) return;
  shared = await acquireSharedTestDatabase("subscription-core-xai-copy-paths");
  if (!shared) throw new Error("Real PostgreSQL is required");
  client = createDb(shared.appUrl, { max: 6 });
  // Every source is accepted before the receipt.
  recorded = await world();
  missed = await world();
  const foreignGrant = await workspace();
  const foreignCaller = await agent(foreignGrant, "service");
  const foreignTarget = await session(foreignGrant, { parentSessionId: foreignCaller.sessionId });
  await submit(foreignGrant, foreignTarget.id, "the owner's own work");
  foreign = { grant: foreignGrant, caller: foreignCaller, target: { id: foreignTarget.id } };
  // Inert before the receipt: no provider holds records.
  const [before] = await rawRows<{ providers: string[] }>(
    client.db,
    sql`select opengeni_private.subscription_authority_compat_providers() as providers`,
  );
  expect(before!.providers).toEqual([]);
  await shared.admin`
    insert into opengeni_private.subscription_provider_cutover_receipts (
      provider, migration, committed_at, seed_rotation
    ) values ('xai', '0799_subscription_core_xai_cutover.sql', clock_timestamp(),
      '{"mode":"spread"}')`;
  // What the drained cutover wrote for the recorded world's sources.
  const sources = recorded;
  await cutoverRecord(sources.grant, { kind: "session_turn", id: sources.caller.turnId }, SHARED);
  await cutoverRecord(sources.grant, { kind: "session_initial", id: sources.target.id }, SHARED);
  await cutoverRecord(sources.grant, { kind: "session_turn", id: sources.edited.turnId }, SHARED);
  await cutoverRecord(sources.grant, { kind: "session_turn", id: sources.goal.turnId }, SHARED);
  const owner = sources.scheduled;
  await cutoverRecord(owner.grant, { kind: "session_turn", id: owner.caller.turnId }, SHARED);
  await cutoverRecord(owner.grant, { kind: "scheduled_task", id: owner.task.id }, SHARED);
  // The owner's own `user` record, which work caused by anyone else must not carry.
  const [ownerTurn] = await turnsOf(foreign.target.id);
  await cutoverRecord(
    foreign.grant,
    { kind: "session_turn", id: ownerTurn!.id },
    {
      personal: [],
      shared_pool: "none",
      legacy_scope: "user",
      owner_subject_id: foreign.grant.subjectId,
    },
  );
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe.skipIf(!realDb)("SuperGrok compatibility copies on every path (M4 X2b)", () => {
  test("runs as the non-superuser, non-bypass application role", async () => {
    const [role] = await rawRows<{ currentUser: string; superuser: boolean; bypassRls: boolean }>(
      client!.db,
      sql`select current_user as "currentUser", rolsuper as superuser,
          rolbypassrls as "bypassRls"
        from pg_catalog.pg_roles where rolname = current_user`,
    );
    expect(role).toEqual({ currentUser: "opengeni_app", superuser: false, bypassRls: false });
    const [providers] = await rawRows<{ providers: string[] }>(
      client!.db,
      sql`select opengeni_private.subscription_authority_compat_providers() as providers`,
    );
    expect(providers!.providers).toEqual(["xai"]);
  });

  for (const name of ["recorded", "missed"] as const) {
    const expected = () => (name === "recorded" ? SHARED : MISSING);
    const current = () => (name === "recorded" ? recorded! : missed!);

    test(`${name}: Agent message, Steer and their delivering turn copy the receiving source`, async () => {
      const { grant, caller, target } = current();
      await withWorkspaceRls(client!.db, grant.workspaceId, (db) =>
        db.transaction((tx) =>
          sendAgentMessageInTransaction(tx as unknown as typeof db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            targetSessionId: target.id,
            actor: caller.actor,
            operationKey: crypto.randomUUID(),
            text: "helper request",
          }),
        ),
      );
      await withWorkspaceRls(client!.db, grant.workspaceId, (db) =>
        db.transaction((tx) =>
          steerAgentSessionInTransaction(tx as unknown as typeof db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            targetSessionId: target.id,
            actor: caller.actor,
            operationKey: crypto.randomUUID(),
            instruction: "new direction",
          }),
        ),
      );
      const updates = await updatesOf(target.id);
      expect(updates.map((update) => update.kind)).toEqual([
        "agent_message",
        "agent_steer_instruction",
      ]);
      for (const update of updates) {
        expect(await records("session_system_update", update.id)).toEqual(only(expected()));
      }
      // The internal turn delivering both copies them (causal delivery).
      const delivering = await claim(grant, target.id);
      expect((await updatesOf(target.id)).map((update) => update.delivered_turn_id)).toEqual([
        delivering.id,
        delivering.id,
      ]);
      expect(await records("session_turn", delivering.id)).toEqual(only(expected()));
    });

    test(`${name}: an Agent prompt copies the receiving session's source`, async () => {
      const { grant, caller } = current();
      // A child without turns: its receiving source is its spawning parent turn.
      const child = await session(grant, {
        parentSessionId: caller.sessionId,
        createdByActor: caller.actor,
      });
      const prompt = await submit(grant, child.id, "agent prompt", { actor: caller.actor });
      expect(await records("session_turn", prompt.turnId)).toEqual(only(expected()));
    });

    test(`${name}: child creation, its first turn, the child outbox and the child result copy the spawning turn`, async () => {
      const { grant, caller } = current();
      const child = await session(grant, {
        parentSessionId: caller.sessionId,
        createdByActor: caller.actor,
      });
      expect(await records("session_initial", child.id)).toEqual(only(expected()));
      await initializeSessionStartAtomically(client!.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: child.id,
        reasoningEffortFallback: "medium",
        createdEventPayload: {},
      });
      const [firstTurn] = await turnsOf(child.id);
      expect(await records("session_turn", firstTurn!.id)).toEqual(only(expected()));
      // The child's idle settlement writes its result to the parent's outbox.
      const childAttemptId = crypto.randomUUID();
      const childTurn = await claim(grant, child.id, childAttemptId);
      await settleIdle(grant, child.id, childTurn, childAttemptId);
      await settleSessionIdleWithParentOutbox(client!.db, grant.workspaceId, child.id);
      const settledOutbox = await shared!.admin<{ id: string }[]>`
        select id::text as id from session_system_update_outbox
        where source_session_id = ${child.id}::uuid`;
      expect(settledOutbox.length).toBeGreaterThan(0);
      for (const row of settledOutbox) {
        expect(await records("session_system_update_outbox", row.id)).toEqual(only(expected()));
      }
      // An enriched result for the same parent, by its own dedupe key.
      const dedupeKey = `child-completion:${child.id}:xai-copy`;
      const outbox = await getOrCreateSessionSystemUpdateOutbox(client!.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sourceSessionId: child.id,
        targetSessionId: caller.sessionId,
        dedupeKey,
        kind: "child_terminal_result",
        classification: "success",
        sourceId: child.id,
        summary: "Child completed",
        payload: { type: "child_terminal_result", childSessionId: child.id, status: "idle" },
        lineage: { childSessionId: child.id, parentSessionId: caller.sessionId },
        personalConnectionDelegations: [],
        mcpAccountBindings: null,
        xaiProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
        claudeProviderAccountAuthoritySnapshot: { version: 1, scope: "workspace" },
      } as never);
      expect(await records("session_system_update_outbox", outbox.id)).toEqual(only(expected()));
      const result = await addSessionSystemUpdate(client!.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: caller.sessionId,
        kind: "child_terminal_result",
        classification: "success",
        sourceId: child.id,
        dedupeKey,
        summary: "Child completed",
        payload: { type: "child_terminal_result", childSessionId: child.id, status: "idle" },
        lineage: { childSessionId: child.id, parentSessionId: caller.sessionId },
      });
      if (result.reason !== "added") throw new Error(`not added: ${result.reason}`);
      expect(await records("session_system_update", result.update.id)).toEqual(only(expected()));
    });

    test(`${name}: a goal continuation, its delivering turn and a later compaction copy their sources`, async () => {
      const { grant, goal } = current();
      const materialized = await materializeGoalContinuation(client!.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: goal.sessionId,
        workflowId: `session-${goal.sessionId}`,
        defaultMaxAutoContinuations: null,
        budgetBlocked: null,
        policy: {
          model: "scripted-model",
          reasoningEffort: "low",
          latencyMode: "standard" as const,
          tools: [],
          sandboxBackend: "none",
        },
        prompt: (target: { text: string }, count: number) => `continue ${target.text} (${count})`,
      } as never);
      expect(materialized).toBeTruthy();
      const [continuation] = (await updatesOf(goal.sessionId)).filter(
        (update) => update.kind === "goal_continuation",
      );
      expect(await records("session_system_update", continuation!.id)).toEqual(only(expected()));
      // The pure goal continuation's delivering turn reads its causal turn.
      const attemptId = crypto.randomUUID();
      const delivering = await claim(grant, goal.sessionId, attemptId);
      expect(delivering.source).toBe("goal");
      expect(await records("session_turn", delivering.id)).toEqual(only(expected()));
      // Compaction continues the latest started turn: the delivering one,
      // whose `turn.started` the worker records (a fixture here).
      await shared!.admin`insert into session_events (
          account_id, workspace_id, session_id, sequence, type, turn_id, payload
        ) values (${grant.accountId}::uuid, ${grant.workspaceId}::uuid, ${goal.sessionId}::uuid,
          (select coalesce(max(sequence), 0) + 1 from session_events
            where session_id = ${goal.sessionId}::uuid),
          'turn.started', ${delivering.id}::uuid, '{}'::jsonb)`;
      await settleIdle(grant, goal.sessionId, delivering, attemptId);
      await shared!.admin`update sessions set compact_requested = true
        where id = ${goal.sessionId}::uuid`;
      const compaction = await claim(grant, goal.sessionId);
      expect(compaction.source).toBe("compaction");
      expect(await records("session_turn", compaction.id)).toEqual(only(expected()));
    });

    test(`${name}: a causal update copies its causal turn`, async () => {
      const { grant, caller } = current();
      const update = await addSessionSystemUpdate(client!.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: caller.sessionId,
        kind: "child_terminal_result",
        classification: "success",
        sourceId: crypto.randomUUID(),
        dedupeKey: `xai-copy:${crypto.randomUUID()}`,
        summary: "Child done",
        payload: {
          type: "child_terminal_result",
          childSessionId: crypto.randomUUID(),
          status: "idle",
        },
        lineage: { parentTurnId: caller.turnId },
      });
      if (update.reason !== "added") throw new Error(`not added: ${update.reason}`);
      expect(await records("session_system_update", update.update.id)).toEqual(only(expected()));
    });

    test(`${name}: an agent-created task and its revision copy the creating turn`, async () => {
      const { grant, caller } = current().scheduled;
      const task = await scheduledTask(grant, caller.actor);
      expect(await records("scheduled_task", task.id)).toEqual(only(expected()));
      expect(
        await records("scheduled_task_revision", task.id, Number(task.authorityRevision)),
      ).toEqual(only(expected()));
    });

    test(`${name}: a new revision of a pre-receipt task copies the task`, async () => {
      const { grant, task } = current().scheduled;
      const updated = await withSessionRlsActorContext({ subjectId: grant.subjectId }, () =>
        updateScheduledTask(client!.db, grant.workspaceId, task.id, {
          refreshPersonalResourceAuthority: true,
          authorityUpdatedBy: { kind: "subject", subjectId: grant.subjectId },
        }),
      );
      expect(
        await records("scheduled_task_revision", task.id, Number(updated!.authorityRevision)),
      ).toEqual(only(expected()));
    });

    test(`${name}: an edited prompt copies the exact turn withdrawn for its edit`, async () => {
      const { grant, edited } = current();
      const checkedOut = await withWorkspaceSubjectRls(
        client!.db,
        grant.workspaceId,
        grant.subjectId,
        (db) =>
          db.transaction((tx) =>
            editQueuedTurnInTransaction(tx as unknown as typeof db, {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              sessionId: edited.sessionId,
              turnId: edited.turnId,
              subjectId: grant.subjectId,
              expectedTurnVersion: edited.version,
              expectedDraftRevision: 0,
              replaceDraft: false,
              actor: { type: "human", subjectId: grant.subjectId },
              operationKey: crypto.randomUUID(),
            }),
          ),
      );
      const resubmitted = await submit(grant, edited.sessionId, checkedOut.draft.text, {
        expectedDraftRevision: checkedOut.draft.revision,
      });
      expect(await records("session_turn", resubmitted.turnId)).toEqual(only(expected()));
    });

    test(`${name}: a new human acceptance is never a copy`, async () => {
      const { grant, edited } = current();
      const fresh = await submit(grant, edited.sessionId, "a new prompt");
      expect(await records("session_turn", fresh.turnId)).toEqual([]);
      const freshSession = await session(grant);
      expect(await records("session_initial", freshSession.id)).toEqual([]);
    });
  }

  test("a `user` source copied by work another human (or no human) caused gets no record", async () => {
    const { grant, caller, target } = foreign!;
    await withWorkspaceRls(client!.db, grant.workspaceId, (db) =>
      db.transaction((tx) =>
        sendAgentMessageInTransaction(tx as unknown as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          targetSessionId: target.id,
          actor: caller.actor,
          operationKey: crypto.randomUUID(),
          text: "from a service agent",
        }),
      ),
    );
    const [message] = await updatesOf(target.id);
    expect(message!.kind).toBe("agent_message");
    expect(await records("session_system_update", message!.id)).toEqual([]);
  });

  test("Codex never gets a record", async () => {
    const [codex] = await shared!.admin<{ count: number }[]>`
      select count(*)::int as count from opengeni_private.subscription_authority_compat
      where provider <> 'xai'`;
    expect(codex!.count).toBe(0);
  });
});
