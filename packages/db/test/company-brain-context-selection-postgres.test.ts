import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  createDb,
  createSession,
  ensureManagedAccessForUser,
  getOrganizationPrivateSessionSettings,
  getOrCreateCompanyProfileSnapshot,
  getOrCreatePreferenceRegistrySnapshot,
  getOrCreateWorkspaceInstructionPolicySnapshot,
  inspectCompanyBrainContextReceipts,
  listTaskNotes,
  nestedPostgresSqlState,
  resolveCompanyBrainContextSelection,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withSessionRlsActorContext,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("company-brain-context-selection");
  if (!shared && requireRealDatabase) {
    throw new Error("[company-brain-context-selection] real PostgreSQL is required");
  }
  if (shared) client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

type Attempt = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  ownerSubjectId: string;
};

async function fixture(
  options: {
    child?: boolean;
    privateRoot?: boolean;
    mode?: "legacy_standing" | "retrieval_only" | "absent";
  } = {},
) {
  if (!shared || !client) throw new Error("test database unavailable");
  const suffix = crypto.randomUUID();
  const userId = `context-owner-${suffix}`;
  const ownerSubjectId = `user:${userId}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Context owner",
  });
  const grant = access.workspaceGrants[0]!;
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${grant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test')
    on conflict (account_id) do nothing`;
  const privateSessionSettings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
  });
  await updateOrganizationPrivateSessionSettings(client.db, {
    organizationId: grant.accountId,
    actorSubjectId: ownerSubjectId,
    enabled: true,
    expectedVersion: privateSessionSettings.version,
    operationId: crypto.randomUUID(),
  });
  await shared.admin`
    update workspaces set settings = ${shared.admin.json(
      options.mode === "absent"
        ? { memoryEnabled: true }
        : { memoryEnabled: true, memoryPromptMode: options.mode ?? "legacy_standing" },
    )}::jsonb
    where id = ${grant.workspaceId}
  `;
  const root = await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
    createSession(client!.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "root context task",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: ownerSubjectId },
      createdByContext: {},
    }),
  );
  const child = options.child
    ? await withSessionRlsActorContext({ subjectId: ownerSubjectId }, async () =>
        createSession(client!.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          parentSessionId: root.id,
          initialMessage: "child context task",
          resources: [],
          metadata: {},
          model: "test-model",
          reasoningEffort: "medium" as const,
          latencyMode: "standard" as const,
          sandboxBackend: "none",
          createdBy: { kind: "subject", subjectId: ownerSubjectId },
          createdByContext: {},
        }),
      )
    : null;
  if (options.privateRoot) {
    await transitionSessionVisibility(client.db, {
      workspaceId: grant.workspaceId,
      sessionId: root.id,
      actorSubjectId: ownerSubjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `context-private-${suffix}`,
    });
  }
  return { grant, ownerSubjectId, root, child };
}

async function seedAttempt(input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  ownerSubjectId: string;
  turnId?: string;
  generation?: number;
  source?: "user" | "compaction";
}): Promise<Attempt> {
  if (!shared) throw new Error("test database unavailable");
  const turnId = input.turnId ?? crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const generation = input.generation ?? 1;
  await shared.admin.begin(async (sql) => {
    await sql`select set_config('opengeni.session_inference_claim', '1', true)`;
    if (input.turnId) {
      await sql`
        update session_turn_attempts set state = 'closed', outcome = 'interrupted_recoverable',
          closed_at = now() where workspace_id = ${input.workspaceId} and turn_id = ${turnId}
          and state in ('claimed','running')
      `;
      await sql`
        update session_turns set execution_generation = ${generation}, active_attempt_id = null,
          status = 'recovering' where workspace_id = ${input.workspaceId} and id = ${turnId}
      `;
    } else {
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, model,
          reasoning_effort, sandbox_backend, execution_generation,
          initiator_kind, initiator_subject_id, initiator_context,
          initiating_human_subject_id
        ) values (
          ${turnId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
          ${crypto.randomUUID()}, ${`context-selection-${turnId}`}, 'running', ${input.source ?? "user"}, 1,
          'context selection fixture', 'test-model', 'medium', 'none', ${generation},
          'subject', ${input.ownerSubjectId}, '{}'::jsonb, ${input.ownerSubjectId}
        )
      `;
    }
    await sql`
      update sessions set active_turn_id = ${turnId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${input.sessionId}
    `;
    await sql`
      update session_turns set active_attempt_id = ${attemptId}, status = 'running'
      where workspace_id = ${input.workspaceId} and id = ${turnId}
    `;
    await sql`
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, temporal_workflow_id, temporal_workflow_run_id,
        temporal_activity_id, verified_control_revision, authority_epoch,
        authority_visibility, authority_owner_organization_membership_id,
        mcp_approval_policies
      ) values (
        ${attemptId}, ${input.accountId}, ${input.workspaceId}, ${input.sessionId},
        ${turnId}, ${generation}, 'running', ${`context-selection-${turnId}`},
        ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0,
        (select authority_epoch from sessions where id = ${input.sessionId}),
        (select visibility from sessions where id = ${input.sessionId}),
        (select owner_organization_membership_id from sessions where id = ${input.sessionId}),
        '{}'::jsonb
      )
    `;
  });
  return { ...input, turnId, attemptId, executionGeneration: generation };
}

function claims(attempt: Attempt) {
  return {
    accountId: attempt.accountId,
    workspaceId: attempt.workspaceId,
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
  };
}

async function prepareSnapshots(attempt: Attempt): Promise<void> {
  await withSessionRlsActorContext(
    {
      subjectId: "worker:context",
      initiatingHumanSubjectId: attempt.ownerSubjectId,
    },
    async () => {
      await getOrCreateCompanyProfileSnapshot(client!.db, claims(attempt));
      await getOrCreateWorkspaceInstructionPolicySnapshot(client!.db, claims(attempt));
      await getOrCreatePreferenceRegistrySnapshot(client!.db, claims(attempt));
    },
  );
}

async function resolve(attempt: Attempt) {
  return await withSessionRlsActorContext(
    {
      subjectId: "worker:context",
      initiatingHumanSubjectId: attempt.ownerSubjectId,
    },
    async () => resolveCompanyBrainContextSelection(client!.db, claims(attempt)),
  );
}

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}

describe("accepted-turn Company Brain context selection", () => {
  test("keeps both context-selection routines security definer with a pinned search path", async () => {
    if (!shared) return;
    const routines = await shared.admin<
      Array<{ name: string; securityDefiner: boolean; settings: string[] | null }>
    >`
      select procedure.proname as "name",
        procedure.prosecdef as "securityDefiner",
        procedure.proconfig as "settings"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = current_schema()
        and procedure.proname in (
          'capture_company_brain_turn_context_snapshot',
          'company_brain_context_get_or_create_selection'
        )
      order by procedure.proname
    `;
    expect(routines.map((routine) => routine.name)).toEqual([
      "capture_company_brain_turn_context_snapshot",
      "company_brain_context_get_or_create_selection",
    ]);
    const [schemaRow] = await shared.admin<Array<{ schema: string }>>`
      select current_schema() as "schema"
    `;
    const schema = schemaRow?.schema;
    expect(schema).toBeString();
    for (const routine of routines) {
      expect(routine.securityDefiner).toBe(true);
      expect(routine.settings).toEqual([`search_path=${schema}, pg_catalog`]);
    }
  });

  test.each(["user", "compaction"] as const)(
    "recovery reuses accepted legacy workspace instructions for %s turns",
    async (source) => {
      if (!shared || !client) return;
      const f = await fixture();
      await shared.admin`
        update workspaces set agent_instructions = ${`accepted-${source}`}
        where id = ${f.grant.workspaceId}
      `;
      const firstAttempt = await seedAttempt({
        accountId: f.grant.accountId,
        workspaceId: f.grant.workspaceId,
        sessionId: f.root.id,
        ownerSubjectId: f.ownerSubjectId,
        source,
      });
      await prepareSnapshots(firstAttempt);
      const first = await resolve(firstAttempt);
      await shared.admin`
        update workspaces set agent_instructions = ${`changed-${source}`}
        where id = ${f.grant.workspaceId}
      `;
      const recovery = await seedAttempt({ ...firstAttempt, generation: 2, source });
      await prepareSnapshots(recovery);
      const replay = await resolve(recovery);
      expect(replay.receipt.turnContextSnapshotId).toBe(first.receipt.turnContextSnapshotId);
      expect(replay.receipt.turnContextSnapshotHash).toBe(first.receipt.turnContextSnapshotHash);
      expect(replay.legacyWorkspaceInstructions).toBe(`accepted-${source}`);
    },
    180_000,
  );

  test("derives root and child containment and denies cross-session, cross-tenant, and direct runtime table access", async () => {
    if (!shared || !client) return;
    const f = await fixture({ child: true, mode: "retrieval_only" });
    const rootAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      ownerSubjectId: f.ownerSubjectId,
    });
    const childAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.child!.id,
      ownerSubjectId: f.ownerSubjectId,
    });
    await prepareSnapshots(rootAttempt);
    await prepareSnapshots(childAttempt);
    expect((await resolve(rootAttempt)).receipt).toMatchObject({
      rootSessionId: f.root.id,
      sessionRole: "root",
      companyProfileIncluded: true,
      selectedMemoryCount: 0,
    });
    expect((await resolve(childAttempt)).receipt).toMatchObject({
      rootSessionId: f.root.id,
      sessionRole: "child",
      companyProfileIncluded: false,
      selectedMemoryCount: 0,
    });
    expect((await resolve(childAttempt)).workspaceMemory).toBeNull();

    await expectSqlState(
      () =>
        resolveCompanyBrainContextSelection(client!.db, {
          ...claims(childAttempt),
          sessionId: f.root.id,
        }),
      "42501",
    );
    const other = await fixture();
    await expectSqlState(
      () =>
        resolveCompanyBrainContextSelection(client!.db, {
          ...claims(childAttempt),
          accountId: other.grant.accountId,
          workspaceId: other.grant.workspaceId,
        }),
      "42501",
    );

    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      await expectSqlState(
        () =>
          app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`select * from company_brain_context_selection_receipts limit 1`;
          }),
        "42501",
      );
      await expectSqlState(
        () =>
          app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`select * from company_brain_turn_context_snapshots limit 1`;
          }),
        "42501",
      );
      await expectSqlState(
        () =>
          app.begin(async (sql) => {
            await sql`select set_config('opengeni.account_id', ${f.grant.accountId}, true)`;
            await sql`select set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true)`;
            await sql`delete from company_brain_context_selection_receipts where false`;
          }),
        "42501",
      );
    } finally {
      await app.end();
    }
  }, 180_000);

  test("derives private-session visibility from the accepted turn without ambient worker identity", async () => {
    if (!shared || !client) return;
    const f = await fixture({ privateRoot: true });
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      ownerSubjectId: f.ownerSubjectId,
    });
    await prepareSnapshots(attempt);
    const selected = await resolveCompanyBrainContextSelection(client.db, claims(attempt));
    expect(selected.receipt).toMatchObject({
      rootSessionId: f.root.id,
      turnContextSnapshotSource: "accepted_turn",
    });
  }, 180_000);

  test("starts another member's turn in a shared child of a private chat without opening that chat's task tree", async () => {
    if (!shared || !client) return;
    const f = await fixture({ child: true, privateRoot: true, mode: "retrieval_only" });
    const [child] = await shared.admin<{ visibility: string; authority_epoch: number }[]>`
      select visibility, authority_epoch from sessions where id = ${f.child!.id}`;
    if (child!.visibility !== "workspace_shared") {
      await transitionSessionVisibility(client.db, {
        workspaceId: f.grant.workspaceId,
        sessionId: f.child!.id,
        actorSubjectId: f.ownerSubjectId,
        targetVisibility: "workspace_shared",
        expectedAuthorityEpoch: Number(child!.authority_epoch),
        operationKey: `context-share-child-${crypto.randomUUID()}`,
      });
    }
    const visibilities = await shared.admin<{ id: string; visibility: string }[]>`
      select id, visibility from sessions where id in (${f.root.id}, ${f.child!.id})
      order by (id = ${f.root.id}) desc`;
    expect([...visibilities]).toEqual([
      { id: f.root.id, visibility: "user_private" },
      { id: f.child!.id, visibility: "workspace_shared" },
    ]);

    // Another member prompts the shared child. The private parent stays the owner's alone.
    const memberSubjectId = `user:member-${crypto.randomUUID()}`;
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.child!.id,
      ownerSubjectId: memberSubjectId,
    });
    await prepareSnapshots(attempt);
    const selected = await resolve(attempt);
    expect(selected.receipt).toMatchObject({
      rootSessionId: f.root.id,
      sessionRole: "child",
    });

    // Task notes coordinate the whole tree, including the private parent, so
    // they stay closed to a member who cannot see that parent.
    await expectSqlState(
      () =>
        withSessionRlsActorContext(
          { subjectId: "worker:context", initiatingHumanSubjectId: memberSubjectId },
          async () => listTaskNotes(client!.db, claims(attempt)),
        ),
      "42501",
    );

    // A member who cannot see the addressed chat itself is still refused.
    const other = await fixture({ child: true, privateRoot: true, mode: "retrieval_only" });
    const [otherChild] = await shared.admin<{ authority_epoch: number }[]>`
      select authority_epoch from sessions where id = ${other.child!.id}`;
    await transitionSessionVisibility(client.db, {
      workspaceId: other.grant.workspaceId,
      sessionId: other.child!.id,
      actorSubjectId: other.ownerSubjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: Number(otherChild!.authority_epoch),
      operationKey: `context-private-child-${crypto.randomUUID()}`,
    });
    const refused = await seedAttempt({
      accountId: other.grant.accountId,
      workspaceId: other.grant.workspaceId,
      sessionId: other.child!.id,
      ownerSubjectId: memberSubjectId,
    });
    await prepareSnapshots(refused).catch(() => undefined);
    await expectSqlState(() => resolve(refused), "42501");
  }, 180_000);

  test("inspects only existing receipts for the exact initiating human and visible task tree", async () => {
    if (!shared || !client) return;
    const f = await fixture({ child: true, mode: "retrieval_only" });
    const rootAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      ownerSubjectId: f.ownerSubjectId,
    });
    const childAttempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.child!.id,
      ownerSubjectId: f.ownerSubjectId,
    });
    await prepareSnapshots(rootAttempt);
    await prepareSnapshots(childAttempt);
    const rootSelection = await resolve(rootAttempt);
    const childSelection = await resolve(childAttempt);

    const inspected = await inspectCompanyBrainContextReceipts(client.db, {
      workspaceId: f.grant.workspaceId,
      subjectId: f.ownerSubjectId,
      limit: 10,
    });
    expect(inspected.map((item) => item.id).sort()).toEqual(
      [rootSelection.receipt.id, childSelection.receipt.id].sort(),
    );
    expect(inspected.find((item) => item.id === rootSelection.receipt.id)).toMatchObject({
      sessionId: f.root.id,
      rootSessionId: f.root.id,
      sessionRole: "root",
      selectedMemoryCount: 0,
      renderedMemoryCount: 0,
    });
    expect(JSON.stringify(inspected)).not.toContain("memorySelections");
    expect(JSON.stringify(inspected)).not.toContain("legacyWorkspaceInstructions");

    const recovery = await seedAttempt({ ...rootAttempt, generation: 2 });
    await prepareSnapshots(recovery);
    const byRecoveryAttempt = await inspectCompanyBrainContextReceipts(client.db, {
      workspaceId: f.grant.workspaceId,
      subjectId: f.ownerSubjectId,
      attemptId: recovery.attemptId,
      limit: 1,
    });
    expect(byRecoveryAttempt.map((item) => item.id)).toEqual([rootSelection.receipt.id]);

    const otherSubject = `user:other-${crypto.randomUUID()}`;
    expect(
      await inspectCompanyBrainContextReceipts(client.db, {
        workspaceId: f.grant.workspaceId,
        subjectId: otherSubject,
      }),
    ).toEqual([]);
  }, 180_000);

  test("keeps private receipts owner-only and resists app-role TEMP relation shadowing", async () => {
    if (!shared || !client) return;
    const f = await fixture({ privateRoot: true });
    const attempt = await seedAttempt({
      accountId: f.grant.accountId,
      workspaceId: f.grant.workspaceId,
      sessionId: f.root.id,
      ownerSubjectId: f.ownerSubjectId,
    });
    await prepareSnapshots(attempt);
    const selected = await resolve(attempt);
    expect(
      await inspectCompanyBrainContextReceipts(client.db, {
        workspaceId: f.grant.workspaceId,
        subjectId: f.ownerSubjectId,
        attemptId: attempt.attemptId,
      }),
    ).toHaveLength(1);

    const app = postgres(shared.appUrl, { max: 1, prepare: false });
    try {
      const otherSubject = `user:other-${crypto.randomUUID()}`;
      const denied = await app.begin(async (sql) => {
        await sql`select
          set_config('opengeni.account_id', ${f.grant.accountId}, true),
          set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true),
          set_config('opengeni.subject_id', ${otherSubject}, true)`;
        return await sql`select * from company_brain_inspect_context_receipts(
          ${f.grant.accountId}::uuid, ${f.grant.workspaceId}::uuid,
          ${otherSubject}::text, ${attempt.attemptId}::uuid, null, null, 1
        )`;
      });
      expect([...denied]).toEqual([]);

      const projected = await app.begin(async (sql) => {
        await sql`select
          set_config('opengeni.account_id', ${f.grant.accountId}, true),
          set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true),
          set_config('opengeni.subject_id', ${f.ownerSubjectId}, true)`;
        await sql`create temporary table company_brain_context_selection_receipts (
          id uuid, account_id uuid, workspace_id uuid, session_id uuid,
          root_session_id uuid, turn_id uuid
        )`;
        await sql`create temporary table session_turns (
          id uuid, account_id uuid, workspace_id uuid, session_id uuid
        )`;
        await sql`create temporary table session_turn_attempts (
          id uuid, account_id uuid, workspace_id uuid, session_id uuid, turn_id uuid
        )`;
        return await sql<Array<{ receiptId: string }>>`
          select receipt_id as "receiptId"
          from company_brain_inspect_context_receipts(
            ${f.grant.accountId}::uuid, ${f.grant.workspaceId}::uuid,
            ${f.ownerSubjectId}::text, ${attempt.attemptId}::uuid, null, null, 1
          )
        `;
      });
      expect(projected.map((row) => ({ receiptId: row.receiptId }))).toEqual([
        { receiptId: selected.receipt.id },
      ]);

      await expectSqlState(
        () =>
          app.begin(async (sql) => {
            await sql`select
              set_config('opengeni.account_id', ${f.grant.accountId}, true),
              set_config('opengeni.workspace_id', ${f.grant.workspaceId}, true),
              set_config('opengeni.subject_id', ${f.ownerSubjectId}, true)`;
            await sql`select * from company_brain_inspect_context_receipts(
              ${f.grant.accountId}::uuid, ${f.grant.workspaceId}::uuid,
              'user:forged'::text, null, null, null, 20
            )`;
          }),
        "42501",
      );
    } finally {
      await app.end();
    }
  }, 180_000);
});
