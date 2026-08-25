import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  addSessionSystemUpdate,
  appendSessionEvents,
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  updateSessionTitle,
  type DbClient,
} from "../src/index";

const migrationUrl = new URL(
  "../drizzle/0344_automatic_session_title_policy_fence.sql",
  import.meta.url,
);

let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("automatic-session-title-policy-fence");
  if (!shared) return;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

describe("migration 0344 automatic session title policy fence", () => {
  test("is a rolling legacy-safe fence with quarantine and INSERT safety", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("LOCK TABLE sessions IN SHARE ROW EXCLUSIVE MODE");
    expect(source).toContain("WHERE title_source IS DISTINCT FROM 'user'");
    expect(source).toContain("opengeni.automatic_session_title_v1_candidate");
    expect(source).toContain("candidate IS DISTINCT FROM NEW.title");
    expect(source).toContain("NEW.title IS DISTINCT FROM 'New conversation'");
    expect(source).toContain("TG_OP = 'INSERT'");
    expect(source).toContain("NEW.title := OLD.title");
    expect(source).toContain("NEW.title_source := OLD.title_source");
    expect(source).toContain("BEFORE INSERT OR UPDATE OF title, title_source");
    expect(source).toContain("ON sessions");
    expect(source).not.toContain("public.sessions");
    expect(source).not.toContain("RAISE EXCEPTION");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1()",
    );
    expect(source).toContain("FROM PUBLIC");
  });

  test("quarantines legacy automatic titles while preserving user-edited titles", async () => {
    const database = shared;
    if (!database) return;

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `title-cutover-account-${suffix}`,
      accountName: "Title cutover",
      workspaceExternalSource: "test",
      workspaceExternalId: `title-cutover-workspace-${suffix}`,
      workspaceName: "Title cutover",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const legacy = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "legacy automatic title",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const human = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "human title",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await database.admin`alter table sessions disable trigger sessions_automatic_title_policy_v1_fence`;
    try {
      await database.admin`
        update sessions
        set title = 'Password: swordfish', title_source = 'agent'
        where id = ${legacy.id}
      `;
      await database.admin`
        update sessions
        set title = 'Human incident review', title_source = 'user'
        where id = ${human.id}
      `;
    } finally {
      await database.admin`alter table sessions enable trigger sessions_automatic_title_policy_v1_fence`;
    }

    await database.admin.unsafe(await readFile(migrationUrl, "utf8"));
    expect(await getSession(client.db, grant.workspaceId!, legacy.id)).toMatchObject({
      title: "New conversation",
      titleSource: "agent",
    });
    expect(await getSession(client.db, grant.workspaceId!, human.id)).toMatchObject({
      title: "Human incident review",
      titleSource: "user",
    });
  }, 180_000);

  test("keeps the pre-policy scheduler writer safe and non-throwing during rollout", async () => {
    const database = shared;
    if (!database) return;

    const [functionAcl] = await database.admin<Array<{ publicExecute: boolean }>>`
      select
        exists (
          select 1
          from aclexplode(coalesce(procedure.proacl, acldefault('f', procedure.proowner))) acl
          where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicExecute"
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'opengeni_private'
        and procedure.proname = 'enforce_automatic_session_title_policy_v1'`;
    expect(functionAcl).toEqual({ publicExecute: false });

    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `title-fence-account-${suffix}`,
      accountName: "Title fence",
      workspaceExternalSource: "test",
      workspaceExternalId: `title-fence-workspace-${suffix}`,
      workspaceName: "Title fence",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "Password：hunter2 investigate the callback",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });

    const [legacyResult] = await database.admin<Array<{ title: string; titleSource: string }>>`
      update sessions
      set title = ${"Password：hunter2 investigate the callback"},
          title_source = 'agent'
      where id = ${session.id}
      returning title, title_source as "titleSource"
    `;
    expect(legacyResult).toEqual({ title: "New conversation", titleSource: "agent" });
    const legacyTitleEvents = await appendSessionEvents(
      client.db,
      grant.workspaceId!,
      session.id,
      [
        {
          type: "session.title_set",
          payload: { title: legacyResult!.title, source: "agent" },
        },
      ],
    );
    expect(legacyTitleEvents[0]?.payload).toEqual({
      title: "New conversation",
      source: "agent",
    });
    const scheduledTaskId = crypto.randomUUID();
    const scheduledTaskRunId = crypto.randomUUID();
    const delivered = await addSessionSystemUpdate(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      kind: "scheduled_occurrence",
      classification: "info",
      sourceId: scheduledTaskRunId,
      dedupeKey: `scheduled-task-run:${scheduledTaskRunId}`,
      summary: "Continue the rollout regression",
      payload: {
        type: "scheduled_occurrence",
        text: "Continue the rollout regression",
        scheduledTaskId,
        scheduledTaskRunId,
      },
      lineage: { scheduledTaskId, scheduledTaskRunId },
      scheduledTaskRunId,
    });
    expect(delivered).toMatchObject({
      added: true,
      reason: "added",
      update: { kind: "scheduled_occurrence", sourceId: scheduledTaskRunId },
    });
    expect(await getSession(client.db, grant.workspaceId!, session.id)).toMatchObject({
      title: "New conversation",
      titleSource: "agent",
    });

    expect(
      await updateSessionTitle(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        title: "OAuth callback failures",
        source: "agent",
      }),
    ).toEqual({ updated: true, title: "OAuth callback failures" });

    expect(
      await updateSessionTitle(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        title: "Stale scheduled fallback replacement",
        source: "agent",
        expectedCurrent: { title: "New conversation", source: "agent" },
      }),
    ).toEqual({ updated: false, title: "OAuth callback failures" });

    expect(
      await updateSessionTitle(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        title: "Debug token sk-proj-abc\u200B123456789XYZ",
        source: "agent",
      }),
    ).toEqual({ updated: false, title: "OAuth callback failures" });

    await database.admin`
      update sessions
      set title = 'Human incident review', title_source = 'user'
      where id = ${session.id}
    `;
    expect(
      await updateSessionTitle(client.db, {
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        title: "Agent retry title",
        source: "agent",
      }),
    ).toEqual({ updated: false, title: "Human incident review" });
  });
});
