import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  acquireOwnerMigratedTestDatabase,
  acquireRestrictedRuntimeTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  addSessionSystemUpdate,
  applySessionTurnSettlement,
  assertPersonalMachineForAttempt,
  authorizePersonalMachineForAttempt,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSession,
  initializeSessionStartAtomically,
  LOSSLESS_TEXT_PREFIX,
  setActiveSandbox,
  submitHumanPromptInTransaction,
  withSessionRlsActorContext,
} from "../src";
import { withWorkspaceSubjectSessionActivityRls } from "../src/database";
import { migrate } from "../src/migrate";
import { nestedPostgresSqlState } from "../src/persistence-errors";
import { provisionRoles } from "../src/provision-roles";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";

const migration = "0851_personal_machine_session_tree.sql";
let shared: SharedTestDatabase;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("machine-tree");
  if (!acquired) throw new Error("Real PostgreSQL required");
  shared = acquired;
}, 900_000);
afterAll(async () => {
  await shared?.release();
}, 180_000);

type Attempt = {
  type: "agent_attempt";
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
};
type Machine = { enrollment_id: string; sandbox_id: string };

async function fixture(
  database: Pick<SharedTestDatabase, "admin" | "appUrl"> & { schema?: string } = shared,
) {
  const admin = database.admin;
  const client = createDb(database.appUrl, {
    max: 1,
    ...(database.schema ? { searchPath: database.schema } : {}),
  });
  const accountId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const personalWorkspaceId = crypto.randomUUID();
  const otherPersonalWorkspaceId = crypto.randomUUID();
  const subjectId = `human:${crypto.randomUUID()}`;
  const otherSubjectId = `human:${crypto.randomUUID()}`;
  await admin`insert into managed_accounts (id,name) values (${accountId},'machine tree')`;
  await admin`insert into workspaces (id,account_id,name) values
    (${workspaceId},${accountId},'shared'),(${personalWorkspaceId},${accountId},'personal'),
    (${otherPersonalWorkspaceId},${accountId},'other personal')`;
  await admin`insert into workspace_inference_controls (workspace_id,account_id) values
    (${workspaceId},${accountId}),(${personalWorkspaceId},${accountId}),(${otherPersonalWorkspaceId},${accountId})`;
  await admin`insert into organization_memberships (account_id,subject_id,status,personal_workspace_id)
    values (${accountId},${subjectId},'active',${personalWorkspaceId}),
      (${accountId},${otherSubjectId},'active',${otherPersonalWorkspaceId})`;
  await admin`insert into workspace_memberships (account_id,workspace_id,subject_id)
    values (${accountId},${workspaceId},${subjectId}),(${accountId},${workspaceId},${otherSubjectId})`;
  const makeMachine = async (): Promise<Machine> => {
    const [machine] = await admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id',${accountId},true),
        set_config('opengeni.workspace_id',${workspaceId},true),
        set_config('opengeni.subject_id',${subjectId},true)`;
      return tx<Machine[]>`select enrollment_id,sandbox_id from finalize_scoped_enrollment(
        ${accountId}::uuid,${workspaceId}::uuid,'user',${crypto.randomUUID()},
        true,false,'linux','x86_64','Personal machine',false)`;
    });
    if (!machine) throw new Error("Missing machine");
    return machine;
  };
  const machine = await makeMachine();
  const create = async (
    options: {
      parent?: Attempt;
      parentIdOnly?: string;
      mode?: "session" | "once";
      target?: Machine | null;
      subject?: string;
      firstPromptSubject?: string;
      message?: string;
      instructions?: string;
      modelContext?: string;
      // Production shape: an agent attempt's bearer subject is the worker
      // principal; the API sets the attempt's verified initiating human.
      worker?: { initiatingHuman: string };
    } = {},
  ) => {
    const subject = options.subject ?? subjectId;
    const worker = options.worker;
    const createInput = {
      accountId,
      workspaceId,
      initialMessage: options.message ?? (options.firstPromptSubject ? "" : "Synthetic claim only"),
      ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
      ...(options.modelContext !== undefined ? { initialModelContext: options.modelContext } : {}),
      resources: [],
      metadata: {},
      ...(worker
        ? { subjectId: "worker:first-party-mcp" }
        : { createdBy: { kind: "subject" as const, subjectId: subject }, subjectId: subject }),
      ...(options.parent ? { createdByActor: options.parent } : {}),
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
      firstPartyMcpTools: [],
      parentSessionId: options.parent?.sessionId ?? options.parentIdOnly ?? null,
      initialPersonalResourceAttachmentIntent: options.mode
        ? {
            mode: options.mode,
            workspaceSharedAcknowledged: true,
            sharedOutputWarningVersion: 1 as const,
          }
        : null,
    };
    const session = worker
      ? await withSessionRlsActorContext(
          {
            subjectId: "worker:first-party-mcp",
            initiatingHumanSubjectId: worker.initiatingHuman,
          },
          () => createSession(client.db, createInput),
        )
      : await createSession(client.db, createInput);
    const target = options.target === undefined ? machine : options.target;
    // Fixture-only setup models createSessionForRequest's pre-start route seed.
    if (target)
      await admin`update sessions set active_sandbox_id=${target.sandbox_id} where id=${session.id}`;
    if (options.firstPromptSubject) {
      await withWorkspaceSubjectSessionActivityRls(
        client.db,
        workspaceId,
        options.firstPromptSubject,
        (db) =>
          db.transaction((tx) =>
            submitHumanPromptInTransaction(tx as unknown as typeof db, {
              accountId,
              workspaceId,
              sessionId: session.id,
              subjectId: options.firstPromptSubject!,
              actor: { type: "human", subjectId: options.firstPromptSubject! },
              operationKey: crypto.randomUUID(),
              delivery: "send",
              text: "Another human's prompt",
              resources: [],
              reasoningEffortFallback: "medium",
              source: "user",
            }),
          ),
      );
    } else {
      await initializeSessionStartAtomically(client.db, {
        accountId,
        workspaceId,
        sessionId: session.id,
        reasoningEffortFallback: "medium",
        createdEventPayload: {},
      });
    }
    return session;
  };
  const claim = async (sessionId: string): Promise<Attempt> => {
    const attemptId = crypto.randomUUID();
    const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId,
      attemptId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (result.action !== "claimed") throw new Error(`Not claimed: ${result.reason}`);
    return {
      type: "agent_attempt",
      sessionId,
      turnId: result.turn.id,
      attemptId,
      executionGeneration: result.turn.executionGeneration,
    };
  };
  // Settle the attempt's turn and deliver a child result for it. The next
  // claim is the owner's service-initiated internal-update turn, which keeps
  // the receiving turn's initiating human (the turn a real parent gets when a
  // child finishes).
  const internalUpdateTurn = async (attempt: Attempt): Promise<Attempt> => {
    const [turn] =
      await admin`select trigger_event_id from session_turns where id=${attempt.turnId}`;
    await applySessionTurnSettlement(client.db, workspaceId, {
      sessionId: attempt.sessionId,
      turnId: attempt.turnId,
      attemptId: attempt.attemptId,
      triggerEventId: turn!.trigger_event_id,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [],
    });
    const update = await addSessionSystemUpdate(client.db, {
      accountId,
      workspaceId,
      sessionId: attempt.sessionId,
      kind: "child_terminal_result",
      classification: "success",
      sourceId: crypto.randomUUID(),
      dedupeKey: `machine-tree-child:${crypto.randomUUID()}`,
      summary: "Child completed",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "idle",
      },
      lineage: {
        parentSessionId: attempt.sessionId,
        parentTurnId: attempt.turnId,
        childSessionId: crypto.randomUUID(),
      },
      personalConnectionDelegations: [],
    });
    if (!update.added) throw new Error(`Child result was not added: ${update.reason}`);
    return await claim(attempt.sessionId);
  };
  const use = (attempt: Attempt, target = machine, caller = subjectId) =>
    assertPersonalMachineForAttempt(client.db, {
      accountId,
      workspaceId,
      subjectId: caller,
      ...attempt,
      enrollmentId: target.enrollment_id,
    });
  const grants =
    () => admin`select id,session_id,mode,generation from organization_user_resource_grants
    where account_id=${accountId} and action='connected_machine.use'`;
  const atomicCreationSql = (
    parent: Attempt,
    id: string,
    creator = subjectId,
    actor = parent,
    extraValues: Record<string, unknown> = {},
  ) => {
    const values = {
      id,
      account_id: accountId,
      workspace_id: workspaceId,
      initial_message: "Atomic child",
      model: "test-model",
      reasoning_effort: "medium",
      latency_mode: "standard",
      sandbox_backend: "none",
      sandbox_group_id: id,
      tool_policy: { mode: "explicit", inheritedFromSessionId: parent.sessionId },
      created_by_kind: "subject",
      created_by_subject_id: creator,
      parent_session_id: parent.sessionId,
      parent_turn_id: parent.turnId,
      status: "idle",
      ...extraValues,
    };
    return sql`select id from create_agent_child_session(${accountId}::uuid,${workspaceId}::uuid,
      ${actor.sessionId}::uuid,${actor.turnId}::uuid,${actor.attemptId}::uuid,
      ${actor.executionGeneration},${JSON.stringify(values)}::jsonb)`;
  };
  const atomic = (
    parent: Attempt,
    options: {
      id?: string;
      subject?: string;
      creator?: string;
      actor?: Partial<Attempt>;
      extraValues?: Record<string, unknown>;
    } = {},
  ) =>
    withWorkspaceSubjectSessionActivityRls(
      client.db,
      workspaceId,
      options.subject ?? subjectId,
      (db) =>
        db.execute(
          atomicCreationSql(
            parent,
            options.id ?? crypto.randomUUID(),
            options.creator ?? options.subject ?? subjectId,
            { ...parent, ...options.actor },
            options.extraValues,
          ),
        ),
    );
  const forge = async (
    parent: Attempt,
    options: { start?: boolean; witness?: string; stamp?: Partial<Attempt>; subject?: string } = {},
  ) => {
    const id = crypto.randomUUID();
    // Restricted app INSERT deliberately bypasses createSession's exact actor
    // path. Parent IDs are readable data, not creation provenance.
    const caller = options.subject ?? subjectId;
    await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, caller, async (db) => {
      await db.execute(sql`insert into sessions (
        id, account_id, workspace_id, initial_message, model, reasoning_effort,
        latency_mode, sandbox_backend, sandbox_group_id, tool_policy,
        created_by_kind, created_by_subject_id, parent_session_id, parent_turn_id,
        active_sandbox_id, status ${options.witness ? sql`, agent_creation_attempt_id` : sql``}
      ) values (${id},${accountId},${workspaceId},'forged child','test-model','medium',
        'standard','none',${id},'{"mode":"explicit","inheritedFromSessionId":null}'::jsonb,'subject',${caller},
        ${parent.sessionId},${parent.turnId},${machine.sandbox_id},'idle'
        ${options.witness ? sql`, ${options.witness}` : sql``})`);
      if (options.stamp) {
        const actor = { ...parent, ...options.stamp };
        await db.execute(atomicCreationSql(parent, id, caller, actor));
      }
    });
    if (options.start !== false)
      await initializeSessionStartAtomically(client.db, {
        accountId,
        workspaceId,
        sessionId: id,
        reasoningEffortFallback: "medium",
        createdEventPayload: {},
      });
    return id;
  };
  return {
    admin,
    client,
    accountId,
    workspaceId,
    subjectId,
    otherSubjectId,
    machine,
    makeMachine,
    create,
    claim,
    internalUpdateTurn,
    use,
    grants,
    forge,
    atomic,
  };
}

async function denied(operation: Promise<unknown>) {
  let failure: unknown;
  try {
    await operation;
  } catch (error) {
    failure = error;
  }
  expect(
    nestedPostgresSqlState(failure),
    failure instanceof Error ? failure.message : "operation unexpectedly succeeded",
  ).toBe("42501");
}

test("before migration: exact production-shaped child claim fails at the personal-machine grant raiser", async () => {
  const before = await acquireSharedTestDatabase("machine-tree-before", {
    withheldMigrations: [migration],
  });
  if (!before) throw new Error("Real PostgreSQL required");
  const f = await fixture(before);
  try {
    const parent = await f.claim((await f.create({ mode: "session" })).id);
    // Pre-migration children have no protected creation witness. Raw app-role
    // insertion preserves the historical parent/session/turn shape here.
    const child = { id: await f.forge(parent) };
    let failure: unknown;
    try {
      await f.claim(child.id);
    } catch (error) {
      failure = error;
    }
    expect(nestedPostgresSqlState(failure)).toBe("42501");
    let cause = failure as Error & { cause?: unknown };
    while (cause.cause) cause = cause.cause as typeof cause;
    expect(cause.message).toBe("personal machine use requires explicit grant");
    expect(
      await f.admin`select id from session_turn_attempts where session_id=${child.id}`,
    ).toHaveLength(0);
  } finally {
    await f.client.close();
    await before.release();
  }
}, 900_000);

for (const mode of ["session", "once"] as const) {
  test(`${mode}: child and grandchild claim and dispatch using the original grant only`, async () => {
    const f = await fixture();
    try {
      const root = await f.claim((await f.create({ mode })).id);
      const original = await f.grants();
      const child = await f.claim((await f.create({ parent: root })).id);
      const grandchild = await f.claim((await f.create({ parent: child })).id);
      expect(await f.use(child)).toBe(true);
      expect(await f.use(grandchild)).toBe(true);
      expect(await f.grants()).toEqual(original);
      const snapshots =
        await f.admin`select grant_id from session_attempt_connected_machine_authorizations
        where attempt_id in (${child.attemptId},${grandchild.attemptId})`;
      expect(snapshots.map((row) => row.grant_id)).toEqual([original[0]!.id, original[0]!.id]);
      await denied(f.use(child, f.machine, f.otherSubjectId));
    } finally {
      await f.client.close();
    }
  }, 180_000);
}

test("mid-turn human move consent is a valid originating snapshot", async () => {
  const f = await fixture();
  try {
    const root = await f.claim((await f.create({ target: null })).id);
    expect(
      await setActiveSandbox(f.client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        subjectId: f.subjectId,
        sessionId: root.sessionId,
        targetSandboxId: f.machine.sandbox_id,
        expectedEpoch: 0,
        consentToCurrentTurn: true,
      }),
    ).toMatchObject({ swapped: true });
    const child = await f.claim((await f.create({ parent: root })).id);
    const grandchild = await f.claim((await f.create({ parent: child })).id);
    expect(await f.use(child)).toBe(true);
    expect(await f.use(grandchild)).toBe(true);
    expect(await f.grants()).toHaveLength(0);
    const pending = await f.create({ parent: grandchild });
    await denied(
      f.claim((await f.create({ parent: root, firstPromptSubject: f.otherSubjectId })).id),
    );
    await denied(f.claim((await f.create({ parent: root, target: await f.makeMachine() })).id));
    await denied(f.claim((await f.create()).id));
    await f.admin`update organization_memberships set authorization_revision=authorization_revision+1
      where account_id=${f.accountId} and subject_id=${f.subjectId}`;
    expect(await f.use(child)).toBe(false);
    expect(await f.use(grandchild)).toBe(false);
    await denied(f.claim(pending.id));
  } finally {
    await f.client.close();
  }
}, 180_000);

test("a different machine, unrelated chat, parent ID without an agent edge, and a sibling are refused", async () => {
  const f = await fixture();
  try {
    const hub = await f.claim((await f.create({ target: null })).id);
    const root = await f.claim((await f.create({ parent: hub, mode: "session" })).id);
    await denied(f.claim((await f.create({ parent: root, target: await f.makeMachine() })).id));
    await denied(f.claim((await f.create()).id));
    await denied(f.claim((await f.create({ parentIdOnly: root.sessionId })).id));
    await denied(f.claim((await f.create({ parent: hub })).id));
    await denied(f.claim((await f.create({ subject: f.otherSubjectId })).id));
    const foreignRoot = await f.claim(
      (await f.create({ subject: f.otherSubjectId, target: null })).id,
    );
    await denied(f.claim((await f.create({ parent: foreignRoot, subject: f.otherSubjectId })).id));
    const child = await f.claim((await f.create({ parent: root })).id);
    expect(await f.use(child)).toBe(true);
  } finally {
    await f.client.close();
  }
}, 180_000);

test("another initiating human gets no machine use even in an owner-owned true descendant", async () => {
  const f = await fixture();
  try {
    const root = await f.claim((await f.create({ mode: "session" })).id);
    const child = await f.create({ parent: root, firstPromptSubject: f.otherSubjectId });
    await denied(f.claim(child.id));
  } finally {
    await f.client.close();
  }
}, 180_000);

test("a later move receipt cannot bypass revocation of an existing source session grant", async () => {
  const f = await fixture();
  try {
    const root = await f.claim((await f.create({ mode: "session" })).id);
    expect(
      await setActiveSandbox(f.client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        subjectId: f.subjectId,
        sessionId: root.sessionId,
        targetSandboxId: f.machine.sandbox_id,
        expectedEpoch: 0,
        consentToCurrentTurn: true,
      }),
    ).toMatchObject({ swapped: true });
    const child = await f.claim((await f.create({ parent: root })).id);
    expect(await f.use(child)).toBe(true);
    const pending = await f.create({ parent: child });
    const [grant] = await f.grants();
    await f.admin`update organization_user_resource_grants set status='revoked',revoked_at=now(),
      generation=generation+1 where id=${grant!.id}`;
    await denied(f.use(child));
    await denied(f.claim(pending.id));
    // A direct root child walks only root's receipt-bound creation attempt.
    // The revoked source grant must still block that receipt.
    const direct = await f.create({ parent: root });
    await denied(f.claim(direct.id));
  } finally {
    await f.client.close();
  }
}, 180_000);

test("the owner's service-initiated turns cover children; another initiating human does not", async () => {
  const f = await fixture();
  try {
    const root = await f.claim((await f.create({ mode: "session" })).id);
    const serviceTurn = await f.internalUpdateTurn(root);
    const [turn] = await f.admin`select initiator_kind,initiator_subject_id,
      initiating_human_subject_id from session_turns where id=${serviceTurn.turnId}`;
    expect(turn).toMatchObject({
      initiator_kind: "service",
      initiator_subject_id: "internal-update",
      initiating_human_subject_id: f.subjectId,
    });
    const owner = { initiatingHuman: f.subjectId };
    const childSession = await f.create({ parent: serviceTurn, worker: owner });
    const [witness] = await f.admin`select agent_creation_attempt_id,created_by_kind,
      created_by_subject_id from sessions where id=${childSession.id}`;
    expect(witness).toMatchObject({
      agent_creation_attempt_id: serviceTurn.attemptId,
      created_by_kind: "service",
      created_by_subject_id: "internal-update",
    });
    const child = await f.claim(childSession.id);
    expect(await f.use(child)).toBe(true);
    const grandchild = await f.claim((await f.create({ parent: child, worker: owner })).id);
    expect(await f.use(grandchild)).toBe(true);

    // A request carrying another initiating human is refused by the seam.
    await denied(f.create({ parent: serviceTurn, worker: { initiatingHuman: f.otherSubjectId } }));
    // A covered child's own turn initiated by another human stays refused.
    const foreignTurnChild = await f.create({
      parent: serviceTurn,
      worker: owner,
      firstPromptSubject: f.otherSubjectId,
    });
    await denied(f.claim(foreignTurnChild.id));

    const [grant] = await f.grants();
    await f.admin`update organization_user_resource_grants set status='revoked',revoked_at=now(),
      generation=generation+1 where id=${grant!.id}`;
    await denied(f.use(child));
    await denied(f.use(grandchild));
  } finally {
    await f.client.close();
  }
}, 180_000);

test("initial messages round-trip losslessly through ordinary and agent-child creation", async () => {
  const f = await fixture();
  try {
    const message = `nul:\u0000 lone:\udc00 prefix:${LOSSLESS_TEXT_PREFIX}0041; end`;
    expect(message).toContain("opengeni_lossless_text_v2_c4100a62:0041;");
    const ordinary = await f.create({ mode: "session", message });
    expect(ordinary.initialMessage).toBe(message);
    const root = await f.claim(ordinary.id);
    const children = [
      await f.create({ parent: root, message }),
      await f.create({ parent: root, message, worker: { initiatingHuman: f.subjectId } }),
    ];
    for (const session of [ordinary, ...children]) {
      const [stored] = await f.admin`select agent_creation_attempt_id,
        initial_message_codec_version
        from sessions where id=${session.id}`;
      expect(stored!.initial_message_codec_version).toBe(1);
      expect(stored!.agent_creation_attempt_id).toBe(
        session.id === ordinary.id ? null : root.attemptId,
      );
      expect(session.initialMessage).toBe(message);
      expect((await getSession(f.client.db, f.workspaceId, session.id))!.initialMessage).toBe(
        message,
      );
    }
  } finally {
    await f.client.close();
  }
}, 180_000);

test("plain text columns store lone surrogates as U+FFFD on both creation paths", async () => {
  const f = await fixture();
  try {
    const instructions = "persona lone:\udc00 high:\ud800 pair:\ud83d\ude00";
    const modelContext = "context lone:\udfff end";
    const replaced = (value: string) => value.replace(/\udc00|\ud800|\udfff/g, "\ufffd");
    const text = { instructions, modelContext };
    const ordinary = await f.create({ mode: "session", ...text });
    const root = await f.claim(ordinary.id);
    const children = [
      await f.create({ parent: root, ...text }),
      await f.create({ parent: root, ...text, worker: { initiatingHuman: f.subjectId } }),
    ];
    for (const session of [ordinary, ...children]) {
      const [stored] = await f.admin`select agent_creation_attempt_id, instructions,
        initial_model_context from sessions where id=${session.id}`;
      expect(stored).toEqual({
        agent_creation_attempt_id: session.id === ordinary.id ? null : root.attemptId,
        instructions: replaced(instructions),
        initial_model_context: replaced(modelContext),
      });
    }
  } finally {
    await f.client.close();
  }
}, 180_000);

for (const invalidation of ["grant_generation", "ancestor_snapshot_epoch"] as const) {
  test(`move receipt cannot bypass ${invalidation} for dispatch or new claims`, async () => {
    const f = await fixture();
    try {
      const root = await f.claim((await f.create({ mode: "session" })).id);
      await setActiveSandbox(f.client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        subjectId: f.subjectId,
        sessionId: root.sessionId,
        targetSandboxId: f.machine.sandbox_id,
        expectedEpoch: 0,
        consentToCurrentTurn: true,
      });
      const child = await f.claim((await f.create({ parent: root })).id);
      const pendingChild = await f.create({ parent: root });
      const pendingGrandchild = await f.create({ parent: child });
      if (invalidation === "grant_generation")
        await f.admin`update organization_user_resource_grants set generation=generation+1
          where account_id=${f.accountId} and session_id=${root.sessionId}`;
      else
        await f.admin`update session_attempt_connected_machine_authorizations
          set session_authority_epoch=0 where session_id=${root.sessionId}`;
      await denied(f.claim(pendingChild.id));
      await denied(f.use(child));
      await denied(f.claim(pendingGrandchild.id));
    } finally {
      await f.client.close();
    }
  }, 180_000);
}

for (const source of ["grant", "move_receipt"] as const) {
  test(`${source}: forged parent IDs without protected agent-creation provenance grant no access`, async () => {
    const f = await fixture();
    try {
      const root = await f.claim(
        (await f.create(source === "grant" ? { mode: "session" } : { target: null })).id,
      );
      if (source === "move_receipt")
        await setActiveSandbox(f.client.db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          subjectId: f.subjectId,
          sessionId: root.sessionId,
          targetSandboxId: f.machine.sandbox_id,
          expectedEpoch: 0,
          consentToCurrentTurn: true,
        });
      const forged = await f.forge(root);
      await denied(f.claim(forged));
      // Reading exact live IDs cannot upgrade a direct INSERT, even in the
      // same transaction, by invoking the atomic creation seam afterwards.
      await denied(f.forge(root, { stamp: {} }));
      await denied(f.atomic(root, { id: forged }));
    } finally {
      await f.client.close();
    }
  }, 180_000);
}

test("agent creation witnesses are insert-only and reject foreign subjects and stale attempts", async () => {
  const f = await fixture();
  try {
    const root = await f.claim((await f.create({ mode: "session" })).id);
    await denied(f.forge(root, { witness: root.attemptId }));
    await denied(f.atomic(root, { actor: { attemptId: crypto.randomUUID() } }));
    await denied(f.atomic(root, { actor: { turnId: crypto.randomUUID() } }));
    await denied(f.atomic(root, { actor: { executionGeneration: root.executionGeneration + 1 } }));
    await denied(f.atomic(root, { subject: f.otherSubjectId }));
    await denied(f.atomic(root, { subject: f.otherSubjectId, creator: f.subjectId }));
    await denied(f.atomic(root, { creator: f.otherSubjectId }));
    await denied(f.atomic(root, { extraValues: { owner_subject_id: f.otherSubjectId } }));
    const [foreignOwner] = await f.admin`select id from organization_memberships
      where account_id=${f.accountId} and subject_id=${f.otherSubjectId}`;
    await denied(
      f.atomic(root, { extraValues: { owner_organization_membership_id: foreignOwner!.id } }),
    );
    await denied(f.atomic(root, { extraValues: { agent_creation_attempt_id: root.attemptId } }));
    await denied(f.forge(root, { stamp: {}, subject: f.otherSubjectId }));
    await denied(f.create({ parent: root, subject: f.otherSubjectId }));
    const forged = await f.forge(root, { start: false });
    const scoped = (query: ReturnType<typeof sql>) =>
      withWorkspaceSubjectSessionActivityRls(f.client.db, f.workspaceId, f.subjectId, (db) =>
        db.execute(query),
      );
    await denied(
      scoped(sql`update sessions set agent_creation_attempt_id=${root.attemptId}
      where id=${forged}`),
    );
    await denied(f.atomic(root, { id: forged }));
    const [oldSeam] = await f.admin`select to_regprocedure(
      'record_session_agent_creation(uuid,uuid,uuid,uuid,uuid,uuid,integer)') as routine`;
    expect(oldSeam!.routine).toBeNull();
    const child = await f.create({ parent: root });
    const [witness] =
      await f.admin`select agent_creation_attempt_id from sessions where id=${child.id}`;
    expect(witness!.agent_creation_attempt_id).toBe(root.attemptId);
    await denied(
      scoped(sql`update sessions set agent_creation_attempt_id=null where id=${child.id}`),
    );
    await denied(scoped(sql`update sessions set parent_session_id=null where id=${child.id}`));
    const [turn] =
      await f.admin`select trigger_event_id from session_turns where id=${root.turnId}`;
    await applySessionTurnSettlement(f.client.db, f.workspaceId, {
      sessionId: root.sessionId,
      turnId: root.turnId,
      attemptId: root.attemptId,
      triggerEventId: turn!.trigger_event_id,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [],
    });
    await denied(f.atomic(root));
  } finally {
    await f.client.close();
  }
}, 180_000);

for (const change of [
  "revoked",
  "expired",
  "grant_generation",
  "membership_revision",
  "ancestor_snapshot_epoch",
] as const) {
  test(`${change}: existing descendant dispatch and new descendant claims stop`, async () => {
    const f = await fixture();
    try {
      const root = await f.claim((await f.create({ mode: "session" })).id);
      const child = await f.claim((await f.create({ parent: root })).id);
      const pending = await f.create({ parent: child });
      const [grant] = await f.grants();
      if (change === "revoked")
        await f.admin`update organization_user_resource_grants
        set status='revoked',revoked_at=now(),generation=generation+1 where id=${grant!.id}`;
      if (change === "expired")
        await f.admin`update organization_user_resource_grants
        set expires_at=now()-interval '1 second' where id=${grant!.id}`;
      if (change === "grant_generation")
        await f.admin`update organization_user_resource_grants
        set generation=generation+1 where id=${grant!.id}`;
      if (change === "membership_revision")
        await f.admin`update organization_memberships
        set authorization_revision=authorization_revision+1 where account_id=${f.accountId} and subject_id=${f.subjectId}`;
      if (change === "ancestor_snapshot_epoch")
        // Migration-owner fixture of a retained snapshot below the execution
        // floor; normal runtime writers have no UPDATE on this evidence table.
        await f.admin`update session_attempt_connected_machine_authorizations
          set session_authority_epoch=0 where session_id=${root.sessionId}`;
      await denied(f.use(child));
      await denied(f.claim(pending.id));
    } finally {
      await f.client.close();
    }
  }, 180_000);
}

test("runtime attach admission derives the same ancestor grant and remains revocable", async () => {
  const f = await fixture();
  try {
    const root = await f.claim((await f.create({ mode: "session" })).id);
    const child = await f.claim((await f.create({ parent: root, target: null })).id);
    await f.admin`update sessions set active_sandbox_id=${f.machine.sandbox_id} where id=${child.sessionId}`;
    expect(
      await authorizePersonalMachineForAttempt(f.client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        subjectId: f.subjectId,
        ...child,
        enrollmentId: f.machine.enrollment_id,
      }),
    ).toBe(true);
    expect(await f.use(child)).toBe(true);
    const [grant] = await f.grants();
    await f.admin`update organization_user_resource_grants set status='revoked',revoked_at=now(),
      generation=generation+1 where id=${grant!.id}`;
    await denied(f.use(child));
  } finally {
    await f.client.close();
  }
}, 180_000);

test("a runtime role provisioned after migration can call the creation seam and passes posture", async () => {
  const owned = await acquireOwnerMigratedTestDatabase("machine-tree-fresh-provision");
  if (!owned) throw new Error("Real PostgreSQL required");
  // Roles are cluster-wide; a unique runtime role guarantees it did not exist
  // while the migration ran, as on a fresh database before provisioning.
  const appRole = `og_tree_app_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let appClient: ReturnType<typeof createDb> | undefined;
  try {
    // Fresh-database order (dev stack and manual setup): migrate as owner
    // before the runtime role exists, then provision roles.
    await migrate(owned.ownerUrl);
    const [missing] = await owned.admin<Array<{ exists: boolean }>>`
      select exists(select 1 from pg_roles where rolname = ${appRole}) as exists`;
    expect(missing!.exists).toBe(false);
    await provisionRoles(owned.adminUrl, {
      appRole,
      appPassword: owned.appPassword,
      rlsStrategy: "force",
    });
    const seam = "public.create_agent_child_session(uuid,uuid,uuid,uuid,uuid,integer,jsonb)";
    const [privilege] = await owned.admin<Array<{ executable: boolean }>>`
      select has_function_privilege(${appRole}, ${seam}::text, 'EXECUTE') as executable`;
    expect(privilege!.executable).toBe(true);
    const appUrl = new URL(owned.ownerUrl);
    appUrl.username = appRole;
    appUrl.password = owned.appPassword;
    appClient = createDb(appUrl.toString(), { max: 1, rlsStrategy: "force" });
    const options = {
      expectedRole: appRole,
      targetSchema: "public",
      rlsStrategy: "force" as const,
    };
    expect(
      evaluateRuntimeDatabasePosture(
        await inspectRuntimeDatabasePosture(appClient.db, options),
        options,
      ),
    ).toEqual([]);
  } finally {
    await appClient?.close();
    await owned.admin.unsafe(`DROP OWNED BY "${appRole}"`).catch(() => undefined);
    await owned.release();
    await shared.admin.unsafe(`DROP ROLE IF EXISTS "${appRole}"`).catch(() => undefined);
  }
}, 900_000);

test("the new helper is owner-only and preserves grants for unrelated resource kinds", async () => {
  const [row] = await shared.admin`select has_function_privilege('opengeni_app',
    'personal_machine_grant_covers_descendant(uuid,uuid,uuid,uuid)','EXECUTE') as executable`;
  expect(row!.executable).toBe(false);
  const [receiptHelper] = await shared.admin`select has_function_privilege('opengeni_app',
    'personal_machine_turn_consent_covers_descendant(uuid,uuid,uuid)','EXECUTE') as executable`;
  expect(receiptHelper!.executable).toBe(false);
  const [definition] =
    await shared.admin`select pg_get_functiondef('admit_session_attempt_personal_resources()'::regprocedure) as body`;
  expect(definition!.body).not.toContain("personal_machine_grant_covers_descendant");
});

test("non-superuser migration owner and FORCE RLS preserve both tree-consent paths", async () => {
  const database = await acquireRestrictedRuntimeTestDatabase("machine-tree-owner", "machine_tree");
  if (!database) throw new Error("Real PostgreSQL required");
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    // The harness preinstalls pgcrypto in public; atomic attachment digest
    // functions resolve extensions in the dedicated data schema instead.
    await database.admin.unsafe("ALTER EXTENSION pgcrypto SET SCHEMA machine_tree");
    const [role] =
      await database.admin`select rolsuper,rolbypassrls from pg_roles where rolname=${database.ownerRole}`;
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
    f = await fixture(database);
    const root = await f.claim((await f.create({ mode: "session" })).id);
    const child = await f.claim((await f.create({ parent: root })).id);
    const grandchild = await f.claim((await f.create({ parent: child })).id);
    expect(await f.use(grandchild)).toBe(true);
    const movedRoot = await f.claim((await f.create({ target: null })).id);
    expect(
      await setActiveSandbox(f.client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        subjectId: f.subjectId,
        sessionId: movedRoot.sessionId,
        targetSandboxId: f.machine.sandbox_id,
        expectedEpoch: 0,
        consentToCurrentTurn: true,
      }),
    ).toMatchObject({ swapped: true });
    const movedChild = await f.claim((await f.create({ parent: movedRoot })).id);
    expect(await f.use(movedChild)).toBe(true);
  } finally {
    await f?.client.close();
    await database.release();
  }
}, 900_000);
