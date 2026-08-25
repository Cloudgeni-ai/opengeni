import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
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
  test("is a rolling exact-candidate fence rather than a generic bypass", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.startsWith("-- deployment-mode: rolling\n")).toBe(true);
    expect(source).toContain("opengeni.automatic_session_title_v1_candidate");
    expect(source).toContain("IS DISTINCT FROM NEW.title");
    expect(source).toContain("NEW.title IS DISTINCT FROM 'New conversation'");
    expect(source).toContain("BEFORE UPDATE OF title, title_source");
    expect(source).toContain("ON sessions");
    expect(source).not.toContain("public.sessions");
    expect(source).toContain(
      "REVOKE ALL ON FUNCTION opengeni_private.enforce_automatic_session_title_policy_v1()",
    );
    expect(source).toContain("FROM PUBLIC");
    expect(source).not.toContain("BEFORE INSERT");
  });

  test("blocks an old automatic writer while admitting normalized and human writers", async () => {
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

    let oldWriterError: unknown;
    try {
      await database.admin`
        update sessions
        set title = ${"Password：hunter2 investigate the callback"},
            title_source = 'agent'
        where id = ${session.id}
      `;
    } catch (error) {
      oldWriterError = error;
    }
    expect(oldWriterError).toMatchObject({ code: "55000" });
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
