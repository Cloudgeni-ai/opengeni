// Migration 0737: Site audiences. Sites published before it are staged on a
// database migrated without it, then 0737 is applied alone. Every existing
// Site must stay visible to the workspace, and gets an owner only when one
// can be established from organization members: the person whose chat turn
// published its first version, else the member who published it directly.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createDb, createSession, ensureManagedAccessForUser, type DbClient } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import {
  stageVaultPolicyColumns,
  stageConnectionAccountIntentColumns,
} from "./vault-policy-column-fixture";

setDefaultTimeout(180_000);

const realDb = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const MIGRATION = "0737_site_audience.sql";

let database: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  if (!realDb) return;
  database = await acquireOwnerMigratedTestDatabase("site-audience-migration");
  if (!database) throw new Error("Real PostgreSQL is required");
  const heldBack = (await readdir(join(import.meta.dir, "../drizzle")))
    .filter((file) => file.endsWith(".sql") && file >= MIGRATION)
    .sort();
  const staging = postgres(database.ownerUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    await staging`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of heldBack)
      await staging`insert into schema_migrations(name) values (${name})`;
    await migrate(database.ownerUrl);
    await stageVaultPolicyColumns(database.ownerUrl);
    await stageConnectionAccountIntentColumns(database.ownerUrl);
    await provisionRoles(database.adminUrl, {
      appPassword: database.appPassword,
    });
  } finally {
    await staging.end();
  }
  const url = new URL(database.ownerUrl);
  url.username = "opengeni_app";
  url.password = database.appPassword;
  client = createDb(url.toString(), { max: 2 });
});

afterAll(async () => {
  await client?.close();
  await database?.release();
});

test.skipIf(!realDb)(
  "0737 keeps existing Sites workspace-visible and backfills their owners",
  async () => {
    const admin = database!.admin;
    const userId = `site-audience-${crypto.randomUUID()}`;
    const access = await ensureManagedAccessForUser(client!.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Site audience",
    });
    const accountId = access.workspaceGrants[0]!.accountId;
    const member = `user:${userId}`;
    const outsider = `user:${crypto.randomUUID()}`;
    const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}::uuid, 'Site audience shared') returning id::text as id`;
    const workspaceId = workspace!.id;
    await admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values (${accountId}::uuid, ${workspaceId}::uuid, ${member}, 'owner')`;
    await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}::uuid, ${accountId}::uuid)`;
    const chat = await createSession(client!.db, {
      accountId,
      workspaceId,
      initialMessage: "Build a page",
      model: "test-model",
      resources: [],
      metadata: {},
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: member },
      createdByContext: {},
    });
    // A Site published by an agent in the member's chat, one the member
    // published directly, one a key published, and one whose turn names
    // someone outside the organization.
    const sites = {
      fromChat: crypto.randomUUID(),
      direct: crypto.randomUUID(),
      keyed: crypto.randomUUID(),
      outsider: crypto.randomUUID(),
    };
    const turnFor = {
      member: crypto.randomUUID(),
      outsider: crypto.randomUUID(),
    };
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      // The member's own turn carries them as the initiating human; the
      // outsider's names them as the initiator.
      for (const [id, kind, initiator, human, position] of [
        [turnFor.member, "service", "worker:continuation", member, 1],
        [turnFor.outsider, "subject", outsider, null, 2],
      ] as const)
        await tx`insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id, status, position, prompt, model, reasoning_effort, sandbox_backend, initiator_kind, initiator_subject_id, initiating_human_subject_id)
        values (${id}, ${accountId}, ${workspaceId}, ${chat.id}, ${crypto.randomUUID()}, ${`wf-${id}`}, 'completed', ${position}, 'Build a page', 'test-model', 'medium', 'none', ${kind}, ${initiator}, ${human})`;
      const stage = async (
        siteId: string,
        createdBy: string,
        source: { sessionId: string; turnId: string } | null,
      ) => {
        const versionId = crypto.randomUUID();
        await tx`insert into workspace_artifacts (id, account_id, workspace_id, slug, title, current_version_id, created_by_subject_id)
        values (${siteId}, ${accountId}, ${workspaceId}, ${`site-${siteId.slice(0, 8)}`}, 'Site', ${versionId}, ${createdBy})`;
        await tx`insert into workspace_artifact_versions (id, account_id, workspace_id, artifact_id, revision, content_key, content_sha256, size_bytes, operation_key, source_session_id, source_turn_id, source_attempt_id, source_execution_generation, created_by_subject_id)
        values (${versionId}, ${accountId}, ${workspaceId}, ${siteId}, 1, ${`blob-${siteId}`}, ${"a".repeat(64)}, 10, ${`op-${siteId}`},
          ${source?.sessionId ?? null}, ${source?.turnId ?? null}, ${source ? crypto.randomUUID() : null}, ${source ? 1 : null}, ${createdBy})`;
      };
      await stage(sites.fromChat, "worker:first-party-mcp", {
        sessionId: chat.id,
        turnId: turnFor.member,
      });
      await stage(sites.direct, member, null);
      await stage(sites.keyed, "api_key:fixture", null);
      await stage(sites.outsider, outsider, {
        sessionId: chat.id,
        turnId: turnFor.outsider,
      });
    });

    const forcedRls = async (sql: postgres.Sql = admin) =>
      await sql<{ relname: string; forced: boolean }[]>`
    select relname, relforcerowsecurity as forced from pg_class
    where relname in ('workspace_artifacts', 'workspace_artifact_versions', 'session_turns', 'organization_memberships')
      and relnamespace = 'public'::regnamespace order by relname`;
    const forcedBefore = await forcedRls();
    expect(forcedBefore).toHaveLength(4);
    const applying = postgres(database!.ownerUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await applying`delete from schema_migrations where name = ${MIGRATION}`;
    } finally {
      await applying.end();
    }
    await migrate(database!.ownerUrl);
    await provisionRoles(database!.adminUrl, {
      appPassword: database!.appPassword,
    });

    const after = postgres(database!.adminUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      const rows = await after<{ id: string; visibility: string; owner: string | null }[]>`
    select id::text as id, visibility, owner_subject_id as owner
    from workspace_artifacts where workspace_id = ${workspaceId}::uuid`;
      const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
      expect(rows.every((row) => row.visibility === "workspace_shared")).toBe(true);
      expect(byId[sites.fromChat]?.owner).toBe(member);
      expect(byId[sites.direct]?.owner).toBe(member);
      expect(byId[sites.keyed]?.owner).toBeNull();
      expect(byId[sites.outsider]?.owner).toBeNull();

      // FORCE row security is exactly as it was on every table the backfill lifted.
      expect(await forcedRls(after)).toEqual(forcedBefore);

      // An Only me Site needs an owner.
      // postgres.js queries run on `then`; resolve it here rather than in expect.
      const refused =
        await after`update workspace_artifacts set visibility = 'user_private' where id = ${sites.keyed}::uuid`.then(
          () => null,
          (error: Error) => error.message,
        );
      expect(refused).toContain("workspace_artifacts_visibility_check");
    } finally {
      await after.end();
    }
  },
);
