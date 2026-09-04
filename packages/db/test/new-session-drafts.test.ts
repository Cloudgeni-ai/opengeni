import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  NewSessionDraftOptions,
  ReasoningEffort,
  ResourceRef,
  ToolRef,
} from "@opengeni/contracts";
import { stableJson } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { and, eq, sql } from "drizzle-orm";
import { bigint, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  bootstrapWorkspace,
  consumeNewSessionDraftInTransaction,
  createDb,
  createSession,
  getNewSessionDraftInTransaction,
  grantWorkspaceAccess,
  initializeSessionStartAtomically,
  NewSessionDraftAccessError,
  NewSessionDraftConflictError,
  newSessionDraftSelectedProjectChannelId,
  newSessionDraftToolsProvided,
  publicNewSessionDraftOptions,
  removeWorkspaceMember,
  saveNewSessionDraftInTransaction,
  seedNewSessionDraftInTransaction,
  withWorkspaceSubjectRls,
} from "../src/index";
import { parseBatchedBackfillMigration } from "../src/migrate";
import * as schema from "../src/schema";

const projectProvenanceBackfill = parseBatchedBackfillMigration(
  "0406_new_session_draft_project_provenance_backfill.sql",
  await Bun.file(
    new URL("../drizzle/0406_new_session_draft_project_provenance_backfill.sql", import.meta.url),
  ).text(),
);
if (!projectProvenanceBackfill) throw new Error("project provenance backfill is not governed");

// Exact pre-0404 table shape. Using a separate Drizzle table object proves an
// old binary neither selects nor writes the additive provenance columns.
const legacyNewSessionDrafts = pgTable("new_session_drafts", {
  id: uuid("id").primaryKey(),
  accountId: uuid("account_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  subjectId: text("subject_id").notNull(),
  revision: bigint("revision", { mode: "number" }).notNull(),
  text: text("text").notNull(),
  resources: jsonb("resources").$type<unknown[]>().notNull(),
  tools: jsonb("tools").$type<unknown[]>().notNull(),
  model: text("model").notNull(),
  reasoningEffort: text("reasoning_effort").notNull(),
  latencyMode: text("latency_mode").notNull(),
  sessionOptions: jsonb("session_options").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

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
    latencyMode: "standard" | "priority" | "fast";
    selectedProjectChannelId: string | null;
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
    latencyMode: overrides.latencyMode ?? ("standard" as const),
    ...(Object.hasOwn(overrides, "selectedProjectChannelId")
      ? { selectedProjectChannelId: overrides.selectedProjectChannelId }
      : {}),
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
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
}

async function initialize(
  context: Awaited<ReturnType<typeof fixture>>,
  sessionId: string,
  expectedRevision: number,
  subjectId = context.subjectId,
  acceptedSelection?: {
    channelId: string | null;
    targetSandboxId: string | null;
    workingDir: string | null;
  },
) {
  return await initializeSessionStartAtomically(client.db, {
    accountId: context.grant.accountId,
    workspaceId: context.grant.workspaceId!,
    sessionId,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
    consumeNewSessionDraft: {
      subjectId,
      expectedRevision,
      ...(acceptedSelection ? { acceptedSelection } : {}),
    },
  });
}

describe("actor-private new-session drafts (real PostgreSQL + FORCE RLS)", () => {
  test("0406 backfills the short-lived JSON provenance and strips it from old exact-create options", async () => {
    const context = await fixture();
    const projectId = crypto.randomUUID();
    const compute = {
      sandboxBackend: "selfhosted",
      targetSandboxId: crypto.randomUUID(),
      workingDir: "/workspace/legacy-project",
    };
    const saved = await saveDraft(context, 0);

    await shared.admin`alter table new_session_drafts disable trigger new_session_drafts_project_provenance_v1_fence`;
    try {
      await shared.admin`
        update new_session_drafts
        set
          session_options = ${shared.admin.json({
            ...compute,
            toolsProvided: false,
            selectionHistory: { projects: [] },
            selectedProjectChannelId: projectId,
          })},
          selected_project_channel_id = null,
          selected_project_compute_snapshot = null
        where id = ${saved.id}`;
    } finally {
      await shared.admin`alter table new_session_drafts enable trigger new_session_drafts_project_provenance_v1_fence`;
    }

    await shared.admin.begin(async (tx) => {
      await tx.unsafe(projectProvenanceBackfill.statement);
    });

    const migrated = await readDraft(context.grant.workspaceId!, context.subjectId);
    expect(migrated).toMatchObject({
      selectedProjectChannelId: projectId,
      selectedProjectComputeSnapshot: compute,
      sessionOptions: {
        ...compute,
        toolsProvided: false,
        selectionHistory: { projects: [] },
      },
    });
    expect(Object.hasOwn(migrated!.sessionOptions, "selectedProjectChannelId")).toBe(false);
    expect(newSessionDraftSelectedProjectChannelId(migrated!)).toBe(projectId);
  });

  test("stores legacy, Default, and named-project provenance distinctly", async () => {
    const context = await fixture();
    const legacy = await saveDraft(context, 0);
    expect(newSessionDraftSelectedProjectChannelId(legacy)).toBeUndefined();
    expect(Object.hasOwn(legacy.sessionOptions, "selectedProjectChannelId")).toBe(false);
    expect(legacy).toMatchObject({
      selectedProjectChannelId: null,
      selectedProjectComputeSnapshot: null,
    });

    const explicitDefault = await saveDraft(context, 1, { selectedProjectChannelId: null });
    expect(newSessionDraftSelectedProjectChannelId(explicitDefault)).toBeNull();
    expect(explicitDefault).toMatchObject({
      selectedProjectChannelId: null,
      selectedProjectComputeSnapshot: {},
    });
    expect(Object.hasOwn(explicitDefault.sessionOptions, "selectedProjectChannelId")).toBe(false);

    const projectId = crypto.randomUUID();
    const namedProject = await saveDraft(context, 2, { selectedProjectChannelId: projectId });
    expect(newSessionDraftSelectedProjectChannelId(namedProject)).toBe(projectId);
    expect(namedProject).toMatchObject({
      selectedProjectChannelId: projectId,
      selectedProjectComputeSnapshot: {},
    });
    expect(Object.hasOwn(namedProject.sessionOptions, "selectedProjectChannelId")).toBe(false);
  });

  test("legacy text-only omission preserves compatible provenance and explicit values remain exact", async () => {
    const context = await fixture();
    const projectId = crypto.randomUUID();
    const compute = {
      sandboxBackend: "selfhosted" as const,
      targetSandboxId: crypto.randomUUID(),
      workingDir: "/workspace/project-a",
    };
    const namedProject = await saveDraft(context, 0, {
      text: "named-project draft",
      selectedProjectChannelId: projectId,
      options: compute,
    });

    const legacySave = await saveDraft(context, namedProject.revision, {
      text: "older client edit without provenance",
      options: compute,
    });
    expect(legacySave.revision).toBe(namedProject.revision + 1);
    expect(newSessionDraftSelectedProjectChannelId(legacySave)).toBe(projectId);
    expect(legacySave).toMatchObject({
      selectedProjectChannelId: projectId,
      selectedProjectComputeSnapshot: compute,
    });
    expect(Object.hasOwn(legacySave.sessionOptions, "selectedProjectChannelId")).toBe(false);

    const explicitDefault = await saveDraft(context, legacySave.revision, {
      text: "new client explicitly selected Default",
      selectedProjectChannelId: null,
      options: compute,
    });
    expect(explicitDefault.revision).toBe(legacySave.revision + 1);
    expect(newSessionDraftSelectedProjectChannelId(explicitDefault)).toBeNull();
    expect(explicitDefault).toMatchObject({
      selectedProjectChannelId: null,
      selectedProjectComputeSnapshot: compute,
    });

    const explicitNamed = await saveDraft(context, explicitDefault.revision, {
      text: "new client explicitly restored the named project",
      selectedProjectChannelId: projectId,
      options: compute,
    });
    expect(newSessionDraftSelectedProjectChannelId(explicitNamed)).toBe(projectId);
    expect(explicitNamed).toMatchObject({
      selectedProjectChannelId: projectId,
      selectedProjectComputeSnapshot: compute,
    });
  });

  test("pre-0404 Drizzle writes permanently clear provenance on markerless compute ABA", async () => {
    const context = await fixture();
    const projectId = crypto.randomUUID();
    const compute = {
      sandboxBackend: "selfhosted" as const,
      targetSandboxId: crypto.randomUUID(),
      workingDir: "/workspace/project-a",
    };
    await saveDraft(context, 0, {
      selectedProjectChannelId: projectId,
      options: compute,
    });

    const legacyRead = await withWorkspaceSubjectRls(
      client.db,
      context.grant.workspaceId!,
      context.subjectId,
      (db) =>
        db
          .select()
          .from(legacyNewSessionDrafts)
          .where(eq(legacyNewSessionDrafts.workspaceId, context.grant.workspaceId!))
          .limit(1),
    );
    expect(legacyRead).toHaveLength(1);
    expect(Object.hasOwn(legacyRead[0]!, "selectedProjectChannelId")).toBe(false);
    expect(Object.hasOwn(legacyRead[0]!, "selectedProjectComputeSnapshot")).toBe(false);

    const [legacyTextOnly] = await withWorkspaceSubjectRls(
      client.db,
      context.grant.workspaceId!,
      context.subjectId,
      (db) =>
        db
          .update(legacyNewSessionDrafts)
          .set({
            text: "old binary text/tools-only edit",
            tools: [{ kind: "mcp", id: "docs" }],
            sessionOptions: {
              ...compute,
              toolsProvided: true,
              selectionHistory: { projects: [] },
            },
            updatedAt: new Date(),
          })
          .where(eq(legacyNewSessionDrafts.id, legacyRead[0]!.id))
          .returning(),
    );
    expect(Object.hasOwn(legacyTextOnly!, "selectedProjectChannelId")).toBe(false);
    const afterTextOnly = await readDraft(context.grant.workspaceId!, context.subjectId);
    expect(newSessionDraftSelectedProjectChannelId(afterTextOnly!)).toBe(projectId);
    expect(afterTextOnly).toMatchObject({
      selectedProjectChannelId: projectId,
      selectedProjectComputeSnapshot: compute,
    });
    const oldExactTextOnlyOptions = { ...afterTextOnly!.sessionOptions };
    delete oldExactTextOnlyOptions.toolsProvided;
    delete oldExactTextOnlyOptions.selectionHistory;
    expect(stableJson(oldExactTextOnlyOptions)).toBe(stableJson(compute));

    const changedCompute = {
      sandboxBackend: "selfhosted",
      targetSandboxId: crypto.randomUUID(),
      workingDir: "/workspace/project-b",
    };
    await withWorkspaceSubjectRls(client.db, context.grant.workspaceId!, context.subjectId, (db) =>
      db
        .update(legacyNewSessionDrafts)
        .set({
          sessionOptions: {
            ...changedCompute,
            toolsProvided: false,
            selectionHistory: { projects: [] },
          },
          updatedAt: new Date(),
        })
        .where(eq(legacyNewSessionDrafts.id, legacyRead[0]!.id)),
    );
    const afterOldComputeChange = await readDraft(context.grant.workspaceId!, context.subjectId);
    expect(Object.hasOwn(afterOldComputeChange!.sessionOptions, "selectedProjectChannelId")).toBe(
      false,
    );
    expect(afterOldComputeChange).toMatchObject({
      selectedProjectChannelId: null,
      selectedProjectComputeSnapshot: null,
    });
    expect(newSessionDraftSelectedProjectChannelId(afterOldComputeChange!)).toBeUndefined();
    const oldExactCreateOptions = { ...afterOldComputeChange!.sessionOptions };
    delete oldExactCreateOptions.toolsProvided;
    delete oldExactCreateOptions.selectionHistory;
    expect(stableJson(oldExactCreateOptions)).toBe(stableJson(changedCompute));

    await withWorkspaceSubjectRls(client.db, context.grant.workspaceId!, context.subjectId, (db) =>
      db
        .update(legacyNewSessionDrafts)
        .set({
          sessionOptions: {
            ...compute,
            toolsProvided: false,
            selectionHistory: { projects: [] },
          },
          updatedAt: new Date(),
        })
        .where(eq(legacyNewSessionDrafts.id, legacyRead[0]!.id)),
    );
    const afterLegacyAba = await readDraft(context.grant.workspaceId!, context.subjectId);
    expect(afterLegacyAba).toMatchObject({
      sessionOptions: {
        ...compute,
        toolsProvided: false,
        selectionHistory: { projects: [] },
      },
      selectedProjectChannelId: null,
      selectedProjectComputeSnapshot: null,
    });
    expect(newSessionDraftSelectedProjectChannelId(afterLegacyAba!)).toBeUndefined();
  });

  test("legacy omission clears named-project provenance when machine placement changes", async () => {
    const context = await fixture();
    const projectId = crypto.randomUUID();
    const firstMachine = crypto.randomUUID();
    const namedProject = await saveDraft(context, 0, {
      selectedProjectChannelId: projectId,
      options: {
        sandboxBackend: "selfhosted",
        targetSandboxId: firstMachine,
        workingDir: "/workspace/project-a",
      },
    });

    const changedMachine = await saveDraft(context, namedProject.revision, {
      text: "older client changed the project-dependent compute",
      options: {
        sandboxBackend: "selfhosted",
        targetSandboxId: crypto.randomUUID(),
        workingDir: "/workspace/project-b",
      },
    });

    expect(newSessionDraftSelectedProjectChannelId(changedMachine)).toBeUndefined();
    expect(Object.hasOwn(changedMachine.sessionOptions, "selectedProjectChannelId")).toBe(false);
    expect(changedMachine).toMatchObject({
      selectedProjectChannelId: null,
      selectedProjectComputeSnapshot: null,
    });
  });

  test("stale provenance-omitting compute edits still fail OCC without changing the row", async () => {
    const context = await fixture();
    const projectId = crypto.randomUUID();
    const compute = {
      sandboxBackend: "selfhosted" as const,
      targetSandboxId: crypto.randomUUID(),
      workingDir: "/workspace/project-a",
    };
    const first = await saveDraft(context, 0, {
      selectedProjectChannelId: projectId,
      options: compute,
    });
    const current = await saveDraft(context, first.revision, {
      text: "current text-only edit",
      options: compute,
    });

    await expect(
      saveDraft(context, first.revision, {
        text: "stale compute edit",
        options: {
          sandboxBackend: "selfhosted",
          targetSandboxId: crypto.randomUUID(),
          workingDir: "/workspace/other",
        },
      }),
    ).rejects.toMatchObject({
      name: "NewSessionDraftConflictError",
      currentRevision: current.revision,
    });
    expect(await readDraft(context.grant.workspaceId!, context.subjectId)).toMatchObject({
      revision: current.revision,
      text: "current text-only edit",
      sessionOptions: compute,
      selectedProjectChannelId: projectId,
      selectedProjectComputeSnapshot: compute,
    });
  });

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

  test("rejects same-revision create content that is not the exact saved draft", async () => {
    const context = await fixture();
    const saved = await saveDraft(context, 0, {
      text: "exact outside composer",
      model: "scripted-model",
      reasoningEffort: "high",
      latencyMode: "priority",
    });

    await expect(
      withWorkspaceSubjectRls(client.db, context.grant.workspaceId!, context.subjectId, (db) =>
        db.transaction((tx) =>
          seedNewSessionDraftInTransaction(tx, {
            workspaceId: context.grant.workspaceId!,
            subjectId: context.subjectId,
            expectedRevision: saved.revision,
            expectedSnapshot: {
              text: saved.text,
              resources: [],
              tools: [],
              toolsProvided: false,
              model: "different-model",
              reasoningEffort: "high",
              latencyMode: "priority",
              options: {},
            },
          }),
        ),
      ),
    ).rejects.toMatchObject({
      name: "NewSessionDraftConflictError",
      currentRevision: saved.revision,
    });
    expect(await readDraft(context.grant.workspaceId!, context.subjectId)).toMatchObject({
      revision: saved.revision,
      text: "exact outside composer",
      model: "scripted-model",
      reasoningEffort: "high",
      latencyMode: "priority",
    });
  });

  test("turns only an exact accepted revision into a safe seed after durable initialization", async () => {
    const exact = await fixture();
    const channelId = crypto.randomUUID();
    const targetSandboxId = crypto.randomUUID();
    const workingDir = "/workspace/opengeni";
    const variableSetIds = [crypto.randomUUID(), crypto.randomUUID()];
    await saveDraft(exact, 0, {
      text: "private prompt",
      selectedProjectChannelId: channelId,
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
        targetSandboxId,
        workingDir,
        variableSetIds,
        variableSetId: variableSetIds[1],
        rigId: crypto.randomUUID(),
        goal: { text: "do not retain", successCriteria: "never" },
        firstPartyMcpPermissions: ["sessions:create"],
      },
    });
    const exactSession = await createUninitializedSession(exact);
    const initialized = await initialize(exact, exactSession.id, 1, exact.subjectId, {
      channelId,
      targetSandboxId,
      workingDir,
    });
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
      targetSandboxId,
      workingDir,
      variableSetIds,
      variableSetId: variableSetIds[1],
      rigId: expect.any(String),
      toolsProvided: true,
      selectionHistory: {
        projects: [
          {
            channelId,
            targetSandboxId,
            machines: [{ sandboxId: targetSandboxId, workingDir }],
          },
        ],
      },
    });
    expect(seeded).toMatchObject({
      selectedProjectChannelId: channelId,
      selectedProjectComputeSnapshot: {
        sandboxBackend: "selfhosted",
        targetSandboxId,
        workingDir,
      },
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

  test("a realtime create remembers selection without consuming editable draft state", async () => {
    const context = await fixture();
    const channelId = crypto.randomUUID();
    const targetSandboxId = crypto.randomUUID();
    const workingDir = "/workspace/realtime";
    await saveDraft(context, 0, {
      text: "keep for a later text session",
      selectedProjectChannelId: channelId,
    });
    const session = await createUninitializedSession(context);

    await initializeSessionStartAtomically(client.db, {
      accountId: context.grant.accountId,
      workspaceId: context.grant.workspaceId!,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      rememberNewSessionSelection: {
        subjectId: context.subjectId,
        acceptedSelection: { channelId, targetSandboxId, workingDir },
      },
      deferInitialTurn: true,
    });

    expect(await readDraft(context.grant.workspaceId!, context.subjectId)).toMatchObject({
      revision: 1,
      text: "keep for a later text session",
      selectedProjectChannelId: channelId,
      selectedProjectComputeSnapshot: {},
      sessionOptions: {
        selectionHistory: {
          projects: [
            {
              channelId,
              targetSandboxId,
              machines: [{ sandboxId: targetSandboxId, workingDir }],
            },
          ],
        },
      },
    });
  });

  test("a stale realtime selection-history update preserves a newer draft and provenance", async () => {
    const context = await fixture();
    const projectA = crypto.randomUUID();
    const projectB = crypto.randomUUID();
    const sandboxA = crypto.randomUUID();
    const sandboxB = crypto.randomUUID();
    const variableSetIds = [crypto.randomUUID(), crypto.randomUUID()];
    await saveDraft(context, 0, {
      text: "Project A draft",
      selectedProjectChannelId: projectA,
      options: { targetSandboxId: sandboxA, workingDir: "/workspace/project-a" },
    });
    const staleRealtimeSession = await createUninitializedSession(context);

    const projectBResources: ResourceRef[] = [
      {
        kind: "repository",
        uri: "https://github.com/acme/project-b.git",
        ref: "main",
        mountPath: "repos/project-b",
      },
    ];
    const projectBTools: ToolRef[] = [{ kind: "mcp", id: "project-b-docs" }];
    const projectBOptions: NewSessionDraftOptions = {
      sandboxBackend: "selfhosted",
      targetSandboxId: sandboxB,
      workingDir: "/workspace/project-b",
      variableSetIds,
      variableSetId: variableSetIds[1],
      rigId: crypto.randomUUID(),
    };
    const projectBDraft = await saveDraft(context, 1, {
      text: "Project B draft from the newer tab",
      resources: projectBResources,
      tools: projectBTools,
      toolsProvided: true,
      model: "project-b-model",
      reasoningEffort: "high",
      latencyMode: "priority",
      selectedProjectChannelId: projectB,
      options: projectBOptions,
    });

    await initializeSessionStartAtomically(client.db, {
      accountId: context.grant.accountId,
      workspaceId: context.grant.workspaceId!,
      sessionId: staleRealtimeSession.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      rememberNewSessionSelection: {
        subjectId: context.subjectId,
        acceptedSelection: {
          channelId: projectA,
          targetSandboxId: sandboxA,
          workingDir: "/workspace/project-a",
        },
      },
      deferInitialTurn: true,
    });

    const afterStaleRealtime = await readDraft(context.grant.workspaceId!, context.subjectId);
    expect(afterStaleRealtime).toMatchObject({
      revision: projectBDraft.revision,
      text: projectBDraft.text,
      resources: projectBResources,
      tools: projectBTools,
      model: projectBDraft.model,
      reasoningEffort: projectBDraft.reasoningEffort,
      latencyMode: projectBDraft.latencyMode,
      updatedAt: projectBDraft.updatedAt,
    });
    expect(publicNewSessionDraftOptions(afterStaleRealtime!)).toEqual(projectBOptions);
    expect(newSessionDraftToolsProvided(afterStaleRealtime!)).toBe(true);
    expect(newSessionDraftSelectedProjectChannelId(afterStaleRealtime!)).toBe(projectB);
    expect(afterStaleRealtime?.sessionOptions).toEqual({
      ...projectBOptions,
      toolsProvided: true,
      selectionHistory: {
        projects: [
          {
            channelId: projectA,
            targetSandboxId: sandboxA,
            machines: [{ sandboxId: sandboxA, workingDir: "/workspace/project-a" }],
          },
        ],
      },
    });
    expect(afterStaleRealtime).toMatchObject({
      selectedProjectChannelId: projectB,
      selectedProjectComputeSnapshot: {
        sandboxBackend: "selfhosted",
        targetSandboxId: sandboxB,
        workingDir: "/workspace/project-b",
      },
    });
  });

  test("realtime selection history preserves Default and legacy-missing provenance", async () => {
    for (const provenance of [
      { label: "Default", present: true, value: null },
      { label: "legacy missing", present: false, value: undefined },
    ] as const) {
      const context = await fixture();
      const projectA = crypto.randomUUID();
      const saved = await saveDraft(context, 0, {
        text: `${provenance.label} draft`,
        ...(provenance.present ? { selectedProjectChannelId: provenance.value } : {}),
      });
      const session = await createUninitializedSession(context);

      await initializeSessionStartAtomically(client.db, {
        accountId: context.grant.accountId,
        workspaceId: context.grant.workspaceId!,
        sessionId: session.id,
        reasoningEffortFallback: "low",
        createdEventPayload: {},
        rememberNewSessionSelection: {
          subjectId: context.subjectId,
          acceptedSelection: { channelId: projectA, targetSandboxId: null, workingDir: null },
        },
        deferInitialTurn: true,
      });

      const remembered = await readDraft(context.grant.workspaceId!, context.subjectId);
      expect(remembered).toMatchObject({ revision: saved.revision, text: saved.text });
      expect(Object.hasOwn(remembered!.sessionOptions, "selectedProjectChannelId")).toBe(false);
      expect(newSessionDraftSelectedProjectChannelId(remembered!)).toBe(provenance.value);
      expect(remembered).toMatchObject({
        selectedProjectChannelId: provenance.value ?? null,
        selectedProjectComputeSnapshot: provenance.present ? {} : null,
      });
      expect(remembered?.sessionOptions).toMatchObject({
        selectionHistory: {
          projects: [{ channelId: projectA, targetSandboxId: null, machines: [] }],
        },
      });
    }
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

    const removerSubjectId = `user:remover-${crypto.randomUUID()}`;
    await grantWorkspaceAccess(client.db, {
      accountId: context.grant.accountId,
      workspaceId: context.grant.workspaceId!,
      subjectId: removerSubjectId,
      permissions: ["workspace:admin"],
    });
    expect(
      await removeWorkspaceMember(client.db, {
        accountId: context.grant.accountId,
        workspaceId: context.grant.workspaceId!,
        actorSubjectId: removerSubjectId,
        targetSubjectId: context.subjectId,
      }),
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
    await saveDraft(context, 0, {
      selectedProjectChannelId: crypto.randomUUID(),
      options: {
        sandboxBackend: "selfhosted",
        targetSandboxId: crypto.randomUUID(),
        workingDir: "/workspace/project-a",
      },
    });
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

    const staleSave = saveDraft(context, 1, {
      text: "must not survive removal",
      options: {
        sandboxBackend: "selfhosted",
        targetSandboxId: crypto.randomUUID(),
        workingDir: "/workspace/project-b",
      },
    });
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
