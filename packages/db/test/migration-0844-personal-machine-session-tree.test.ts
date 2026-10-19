import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  assertPersonalMachineForAttempt,
  authorizePersonalMachineForAttempt,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  setActiveSandbox,
  submitHumanPromptInTransaction,
} from "../src";
import { withWorkspaceSubjectSessionActivityRls } from "../src/database";
import { nestedPostgresSqlState } from "../src/persistence-errors";

const migration = "0844_personal_machine_session_tree.sql";
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
    } = {},
  ) => {
    const subject = options.subject ?? subjectId;
    const session = await createSession(client.db, {
      accountId,
      workspaceId,
      initialMessage: options.firstPromptSubject ? "" : "Synthetic claim only",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: subject },
      subjectId: subject,
      ...(options.parent ? { createdByActor: options.parent } : {}),
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      firstPartyMcpTools: [],
      parentSessionId: options.parent?.sessionId ?? options.parentIdOnly ?? null,
      initialPersonalResourceAttachmentIntent: options.mode
        ? {
            mode: options.mode,
            workspaceSharedAcknowledged: true,
            sharedOutputWarningVersion: 1,
          }
        : null,
    });
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
    use,
    grants,
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
    const child = await f.create({ parent });
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
