import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  NewSessionDraftOptions,
  ReasoningEffort,
  ResourceRef,
  ToolRef,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { and, eq, sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  consumeNewSessionDraftInTransaction,
  createDb,
  createSession,
  getNewSessionDraftInTransaction,
  initializeSessionStartAtomically,
  NewSessionDraftAccessError,
  NewSessionDraftConflictError,
  newSessionDraftToolsProvided,
  removeWorkspaceMember,
  saveNewSessionDraftInTransaction,
  withWorkspaceSubjectRls,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("new-session-drafts");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(subjectId = `subject-${crypto.randomUUID()}`) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "new-session-drafts-test",
    accountExternalId: `account-${suffix}`,
    accountName: "New-session drafts test",
    workspaceExternalSource: "new-session-drafts-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "New-session drafts test",
    subjectId,
  });
  return { grant: access.workspaceGrants[0]!, subjectId };
}

function draftInput(
  context: Awaited<ReturnType<typeof fixture>>,
  expectedRevision: number,
  overrides: Partial<{
    text: string;
    resources: ResourceRef[];
    tools: ToolRef[];
    toolsProvided: boolean;
    model: string;
    reasoningEffort: ReasoningEffort;
    options: NewSessionDraftOptions;
  }> = {},
) {
  return {
    accountId: context.grant.accountId,
    workspaceId: context.grant.workspaceId!,
    subjectId: context.subjectId,
    expectedRevision,
    text: overrides.text ?? "Recover this private draft",
    resources: overrides.resources ?? [],
    tools: overrides.tools ?? [],
    toolsProvided: overrides.toolsProvided ?? false,
    model: overrides.model ?? "scripted-model",
    reasoningEffort: overrides.reasoningEffort ?? ("low" as const),
    options: overrides.options ?? {},
  };
}

async function saveDraft(
  context: Awaited<ReturnType<typeof fixture>>,
  expectedRevision: number,
  overrides?: Parameters<typeof draftInput>[2],
) {
  return await withWorkspaceSubjectRls(
    client.db,
    context.grant.workspaceId!,
    context.subjectId,
    (db) => saveNewSessionDraftInTransaction(db, draftInput(context, expectedRevision, overrides)),
  );
}

async function readDraft(workspaceId: string, subjectId: string) {
  return await withWorkspaceSubjectRls(client.db, workspaceId, subjectId, (db) =>
    getNewSessionDraftInTransaction(db, { workspaceId, subjectId }),
  );
}

async function createUninitializedSession(context: Awaited<ReturnType<typeof fixture>>) {
  return await createSession(client.db, {
    accountId: context.grant.accountId,
    workspaceId: context.grant.workspaceId!,
    initialMessage: "Start from the durable draft",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
}

async function initialize(
  context: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  expectedRevision: number,
  subjectId = context.subjectId,
) {
  return await initializeSessionStartAtomically(client.db, {
    accountId: context.grant.accountId,
    workspaceId: context.grant.workspaceId!,
    sessionId,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    consumeNewSessionDraft: { subjectId, expectedRevision },
  });
}

describe("actor-private new-session drafts (real PostgreSQL + FORCE RLS)", () => {
  test("markerless legacy rows preserve narrowed and empty tool intent through seeding", async () => {
    for (const tools of [[{ kind: "mcp", id: "docs" }], []] as ToolRef[][]) {
      const context = await fixture();
      const legacy = await withWorkspaceSubjectRls(
        client.db,
        context.grant.workspaceId!,
        context.subjectId,
        (db) =>
          db
            .insert(schema.newSessionDrafts)
            .values({
              accountId: context.grant.accountId,
              workspaceId: context.grant.workspaceId!,
              subjectId: context.subjectId,
              revision: 1,
              text: "legacy draft",
              resources: [],
              tools,
              model: "scripted-model",
              reasoningEffort: "low",
              // No toolsProvided marker: this is a pre-marker row.
              sessionOptions: {},
            })
            .returning(),
      );
      expect(legacy[0]).toBeDefined();
      expect(newSessionDraftToolsProvided(legacy[0]!)).toBe(true);

      const seeded = await withWorkspaceSubjectRls(
        client.db,
        context.grant.workspaceId!,
        context.subjectId,
        (db) =>
          consumeNewSessionDraftInTransaction(db, {
            workspaceId: context.grant.workspaceId!,
            subjectId: context.subjectId,
            expectedRevision: 1,
          }),
      );
      expect(seeded).toBe(true);
      expect(await readDraft(context.grant.workspaceId!, context.subjectId)).toMatchObject({
        revision: 2,
        tools,
        sessionOptions: { toolsProvided: true },
      });
    }
  });

  test("enables and forces RLS with an actor-qualified policy", async () => {
    const [role] = await shared.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'opengeni_app'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

    const [table] = await shared.admin<
      {
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }[]
    >`
      select relrowsecurity, relforcerowsecurity
      from pg_class
      where oid = 'new_session_drafts'::regclass`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const [policy] = await shared.admin<{ qual: string; withCheck: string }[]>`
      select qual, with_check as "withCheck"
      from pg_policies
      where schemaname = current_schema()
        and tablename = 'new_session_drafts'
        and policyname = 'workspace_isolation'`;
    expect(policy?.qual).toContain("current_subject_id()");
    expect(policy?.qual).toContain("workspace_rls_visible(account_id, workspace_id)");
    expect(policy?.withCheck).toContain("current_subject_id()");
  });

  test("isolates drafts by subject within a workspace and by workspace", async () => {
    const owner = await fixture("subject:shared");
    const otherWorkspace = await fixture("subject:shared");
    const saved = await saveDraft(owner, 0);

    expect(saved).toMatchObject({ subjectId: owner.subjectId, revision: 1 });
    expect(await readDraft(owner.grant.workspaceId!, owner.subjectId)).toMatchObject({
      id: saved.id,
      text: "Recover this private draft",
    });
    expect(await readDraft(owner.grant.workspaceId!, "subject:other")).toBeNull();
    expect(await readDraft(otherWorkspace.grant.workspaceId!, owner.subjectId)).toBeNull();

    await expect(
      withWorkspaceSubjectRls(client.db, owner.grant.workspaceId!, "subject:other", (db) =>
        db
          .update(schema.newSessionDrafts)
          .set({ text: "overwrite" })
          .where(eq(schema.newSessionDrafts.id, saved.id))
          .returning(),
      ),
    ).resolves.toEqual([]);
    expect((await readDraft(owner.grant.workspaceId!, owner.subjectId))?.text).toBe(
      "Recover this private draft",
    );
  });

  test("increments revisions and reports the authoritative revision on stale saves", async () => {
    const context = await fixture();
    const first = await saveDraft(context, 0);
    expect(first.revision).toBe(1);

    const second = await saveDraft(context, 1, { text: "second revision" });
    expect(second).toMatchObject({ id: first.id, revision: 2, text: "second revision" });

    try {
      await saveDraft(context, 1, { text: "stale overwrite" });
      throw new Error("Expected stale save to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(NewSessionDraftConflictError);
      expect((error as NewSessionDraftConflictError).currentRevision).toBe(2);
    }
    expect((await readDraft(context.grant.workspaceId!, context.subjectId))?.text).toBe(
      "second revision",
    );
  });

  test("allows explicitly exempt API-key and delegated service actors without memberships", async () => {
    const context = await fixture(`user:${crypto.randomUUID()}`);
    const subjects = [`api_key:${crypto.randomUUID()}`, "worker:first-party-mcp"];

    for (const subjectId of subjects) {
      const [membership] = await shared.admin<{ count: number }[]>`
        select count(*)::int as count
        from workspace_memberships
        where workspace_id = ${context.grant.workspaceId!}
          and subject_id = ${subjectId}`;
      expect(membership?.count).toBe(0);

      const saved = await withWorkspaceSubjectRls(
        client.db,
        context.grant.workspaceId!,
        subjectId,
        (db) =>
          saveNewSessionDraftInTransaction(db, {
            ...draftInput(context, 0),
            subjectId,
            requireWorkspaceMembership: false,
          }),
      );
      expect(saved).toMatchObject({ subjectId, revision: 1 });
      expect(await readDraft(context.grant.workspaceId!, subjectId)).toMatchObject({
        id: saved.id,
        subjectId,
      });
    }
  });

  test("turns a concurrent revision-zero insert race into one typed conflict", async () => {
    const context = await fixture();
    const [left, right] = await Promise.allSettled([
      saveDraft(context, 0, { text: "left" }),
      saveDraft(context, 0, { text: "right" }),
    ]);
    const fulfilled = [left, right].filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof saveDraft>>> =>
        result.status === "fulfilled",
    );
    const rejected = [left, right].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]!.value.revision).toBe(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(NewSessionDraftConflictError);
    expect((rejected[0]!.reason as NewSessionDraftConflictError).currentRevision).toBe(1);
  });

  test("turns only an exact accepted revision into a safe seed after durable initialization", async () => {
    const exact = await fixture();
    await saveDraft(exact, 0, {
      text: "private prompt",
      resources: [
        {
          kind: "repository",
          uri: "https://github.com/acme/private.git",
          ref: "main",
          mountPath: "repos/private",
          provider: "github",
          credentialBindingId: "secret-binding",
          access: "write",
          repositoryId: 123,
          installationId: 456,
          connectionId: "secret-connection",
          githubRepositoryId: 789,
          githubInstallationId: 456,
        },
        { kind: "file", fileId: crypto.randomUUID() },
      ],
      tools: [{ kind: "mcp", id: "docs" }],
      toolsProvided: true,
      options: {
        sandboxBackend: "selfhosted",
        targetSandboxId: crypto.randomUUID(),
        workingDir: "projects/opengeni",
        variableSetId: crypto.randomUUID(),
        rigId: crypto.randomUUID(),
        goal: { text: "do not retain", successCriteria: "never" },
        firstPartyMcpPermissions: ["sessions:create"],
      },
    });
    const exactSession = await createUninitializedSession(exact);
    const initialized = await initialize(exact, exactSession.id, 1);
    expect(initialized.turn?.status).toBe("queued");
    const seeded = await readDraft(exact.grant.workspaceId!, exact.subjectId);
    expect(seeded).toMatchObject({
      revision: 2,
      text: "",
      resources: [
        {
          kind: "repository",
          uri: "https://github.com/acme/private.git",
          ref: "main",
          mountPath: "repos/private",
          githubRepositoryId: 789,
          githubInstallationId: 456,
        },
      ],
      tools: [{ kind: "mcp", id: "docs" }],
      model: "scripted-model",
      reasoningEffort: "low",
    });
    expect(seeded?.sessionOptions).toEqual({
      sandboxBackend: "selfhosted",
      targetSandboxId: expect.any(String),
      workingDir: "projects/opengeni",
      variableSetId: expect.any(String),
      rigId: expect.any(String),
      toolsProvided: true,
    });

    const advanced = await fixture();
    await saveDraft(advanced, 0);
    await saveDraft(advanced, 1, { text: "newer sibling-tab revision" });
    const advancedSession = await createUninitializedSession(advanced);
    const acceptedOldRevision = await initialize(advanced, advancedSession.id, 1);
    expect(acceptedOldRevision.turn?.status).toBe("queued");
    expect(await readDraft(advanced.grant.workspaceId!, advanced.subjectId)).toMatchObject({
      revision: 2,
      text: "newer sibling-tab revision",
    });

    const revisionZero = await withWorkspaceSubjectRls(
      client.db,
      advanced.grant.workspaceId!,
      advanced.subjectId,
      (db) =>
        consumeNewSessionDraftInTransaction(db, {
          workspaceId: advanced.grant.workspaceId!,
          subjectId: advanced.subjectId,
          expectedRevision: 0,
        }),
    );
    expect(revisionZero).toBe(false);
  });

  test("creates a realtime-first idle shell without a user event, turn, or workflow wake", async () => {
    const context = await fixture();
    await saveDraft(context, 0, { text: "private pre-session draft" });
    const session = await createUninitializedSession(context);

    const initialized = await initializeSessionStartAtomically(client.db, {
      accountId: context.grant.accountId,
      workspaceId: context.grant.workspaceId!,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      consumeNewSessionDraft: { subjectId: context.subjectId, expectedRevision: 1 },
      deferInitialTurn: true,
    });

    expect(initialized.turn).toBeNull();
    expect(initialized.workflowWakeRevision).toBeNull();
    expect(initialized.events.map((event) => event.type)).toEqual(["session.created"]);
    expect(await readDraft(context.grant.workspaceId!, context.subjectId)).toMatchObject({
      revision: 2,
      text: "",
    });

    const [state] = await shared.admin<
      Array<{ status: string; eventTypes: string[]; turns: number; wakes: number }>
    >`
      select
        s.status,
        coalesce(array_agg(e.type order by e.sequence) filter (where e.id is not null), '{}') as "eventTypes",
        (select count(*)::int from session_turns t where t.session_id = s.id) as turns,
        (select count(*)::int from session_workflow_wake_outbox w where w.session_id = s.id) as wakes
      from sessions s
      left join session_events e on e.session_id = s.id
      where s.id = ${session.id}
      group by s.id`;
    expect(state).toEqual({ status: "idle", eventTypes: ["session.created"], turns: 0, wakes: 0 });
  });

  test("an idempotent initialization retry cannot consume a later draft with a reused revision", async () => {
    const context = await fixture();
    await saveDraft(context, 0, { text: "accepted draft" });
    const session = await createUninitializedSession(context);

    const initialized = await initialize(context, session.id, 1);
    expect(initialized.turn?.status).toBe("queued");
    expect((await readDraft(context.grant.workspaceId!, context.subjectId))?.revision).toBe(2);

    const laterDraft = await saveDraft(context, 2, { text: "later independent draft" });
    expect(laterDraft.revision).toBe(3);

    await initialize(context, session.id, 1);

    expect(await readDraft(context.grant.workspaceId!, context.subjectId)).toMatchObject({
      id: laterDraft.id,
      revision: 3,
      text: "later independent draft",
    });
  });

  test("removing a workspace member also removes that subject's private draft", async () => {
    const context = await fixture();
    await saveDraft(context, 0);

    expect(
      await removeWorkspaceMember(client.db, context.grant.workspaceId!, context.subjectId),
    ).toBe(true);

    const [count] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count
      from new_session_drafts
      where workspace_id = ${context.grant.workspaceId!}
        and subject_id = ${context.subjectId}`;
    expect(count?.count).toBe(0);
  });

  test("a member removal that wins the lock rejects a stale authorized draft write", async () => {
    const context = await fixture();
    await saveDraft(context, 0);
    let removalLocked!: () => void;
    let finishRemoval!: () => void;
    const locked = new Promise<void>((resolve) => {
      removalLocked = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      finishRemoval = resolve;
    });

    const removal = withWorkspaceSubjectRls(
      client.db,
      context.grant.workspaceId!,
      context.subjectId,
      async (db) => {
        const [membership] = await db
          .select({ id: schema.workspaceMemberships.id })
          .from(schema.workspaceMemberships)
          .where(
            and(
              eq(schema.workspaceMemberships.workspaceId, context.grant.workspaceId!),
              eq(schema.workspaceMemberships.subjectId, context.subjectId),
            ),
          )
          .for("update")
          .limit(1);
        expect(membership).toBeDefined();
        removalLocked();
        await finish;
        await db
          .delete(schema.newSessionDrafts)
          .where(
            and(
              eq(schema.newSessionDrafts.workspaceId, context.grant.workspaceId!),
              eq(schema.newSessionDrafts.subjectId, context.subjectId),
            ),
          );
        await db
          .delete(schema.workspaceMemberships)
          .where(eq(schema.workspaceMemberships.id, membership!.id));
      },
    );
    await locked;

    const staleSave = saveDraft(context, 1, { text: "must not survive removal" });
    let stateBeforeRelease: "blocked" | "settled";
    try {
      stateBeforeRelease = await Promise.race([
        staleSave.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ]);
    } finally {
      finishRemoval();
      await removal;
    }
    expect(stateBeforeRelease).toBe("blocked");
    await expect(staleSave).rejects.toBeInstanceOf(NewSessionDraftAccessError);

    const [count] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count
      from new_session_drafts
      where workspace_id = ${context.grant.workspaceId!}
        and subject_id = ${context.subjectId}`;
    expect(count?.count).toBe(0);
  });

  test("preserves the draft and rolls back initialization when the initializer fails", async () => {
    const context = await fixture();
    await saveDraft(context, 0);
    const session = await createUninitializedSession(context);

    await expect(initialize(context, session.id, 1, " ")).rejects.toThrow(
      "setSubjectRlsContext: a non-empty subjectId is required",
    );
    expect(await readDraft(context.grant.workspaceId!, context.subjectId)).toMatchObject({
      revision: 1,
      text: "Recover this private draft",
    });

    const [events] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count
      from session_events
      where workspace_id = ${context.grant.workspaceId!}
        and session_id = ${session.id}`;
    expect(events?.count).toBe(0);

    const transactionIsolation = await withWorkspaceSubjectRls(
      client.db,
      context.grant.workspaceId!,
      context.subjectId,
      (db) => db.execute<{ transaction_isolation: string }>(sql`show transaction_isolation`),
    );
    expect(transactionIsolation).toEqual([{ transaction_isolation: "read committed" }]);
  });
});
