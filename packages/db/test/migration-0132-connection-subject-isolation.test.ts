import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

let available = true;
let shared: SharedTestDatabase | null = null;
const migrationPath = new URL("../drizzle/0132_connection_subject_isolation.sql", import.meta.url)
  .pathname;
let migrationSql = "";

beforeAll(async () => {
  migrationSql = await readFile(migrationPath, "utf8");
  shared = await acquireSharedTestDatabase("migration-0132-connection-subject-isolation");
  if (!shared) {
    available = false;
    console.warn("[migration-0132] docker unavailable, skipping PostgreSQL assertions");
  }
}, 180_000);

afterAll(async () => {
  await shared?.release();
});

describe("0132 connection subject isolation migration", () => {
  test("is maintenance-classified and fences rolling app writers", () => {
    expect(migrationSql.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(migrationSql).toContain("pg_stat_activity");
    expect(migrationSql.match(/opengeni_app sessions to be stopped/g)).toHaveLength(2);
    expect(migrationSql).toContain("LOCK TABLE connections IN ACCESS EXCLUSIVE MODE");
    expect(migrationSql).toContain("LOCK TABLE capability_installations IN ACCESS EXCLUSIVE MODE");
  });

  test("backfills only exact personal Slack rows, scrubs their capability UUIDs, and enforces subject RLS", async () => {
    if (!available) return;
    const admin = shared!.admin;
    const [account] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('migration 0132 acct') returning id`;
    const [workspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'migration 0132 ws') returning id`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;

    const insertConnection = async (input: {
      subjectId?: string | null;
      providerDomain: string;
      kind: "oauth2" | "app_install";
      createdBySubjectId?: string | null;
      mcpUrl?: string;
    }): Promise<string> => {
      const [row] = await admin<{ id: string }[]>`
        insert into connections (
          account_id, workspace_id, subject_id, provider_domain, kind,
          credential_encrypted, metadata, created_by_subject_id
        ) values (
          ${account!.id}, ${workspace!.id}, ${input.subjectId ?? null},
          ${input.providerDomain}, ${input.kind}, 'fixture-encrypted',
          ${admin.json(input.mcpUrl ? { mcpUrl: input.mcpUrl } : {})},
          ${input.createdBySubjectId ?? null}
        ) returning id`;
      return row!.id;
    };

    const aliceId = await insertConnection({
      providerDomain: "slack.com",
      kind: "oauth2",
      createdBySubjectId: "subject-alice",
      mcpUrl: "https://mcp.slack.com/mcp",
    });
    const bobId = await insertConnection({
      providerDomain: "slack.com",
      kind: "oauth2",
      createdBySubjectId: "subject-bob",
      mcpUrl: "https://mcp.slack.com/mcp",
    });
    const ambiguousId = await insertConnection({
      providerDomain: "slack.com",
      kind: "oauth2",
      createdBySubjectId: null,
      mcpUrl: "https://mcp.slack.com/mcp",
    });
    const manualSlackId = await insertConnection({
      providerDomain: "slack.com",
      kind: "oauth2",
      createdBySubjectId: "subject-manual",
      mcpUrl: "https://slack.example.test/mcp",
    });
    const nonSlackId = await insertConnection({
      providerDomain: "linear.app",
      kind: "oauth2",
      createdBySubjectId: "subject-linear",
      mcpUrl: "https://mcp.slack.com/mcp",
    });
    const sharedBotId = await insertConnection({
      providerDomain: "slack.com",
      kind: "app_install",
      createdBySubjectId: "subject-alice",
      mcpUrl: "https://mcp.slack.com/mcp",
    });

    const insertInstallation = async (capabilityId: string, connectionId: string) => {
      await admin`
        insert into capability_installations (
          account_id, workspace_id, capability_id, kind, config, metadata
        ) values (
          ${account!.id}, ${workspace!.id}, ${capabilityId}, 'mcp',
          ${admin.json({
            connectionRef: {
              connectionId,
              providerDomain: "slack.com",
              kind: "oauth2",
            },
          })},
          '{}'::jsonb
        )`;
    };
    await insertInstallation("mcp:alice", aliceId);
    await insertInstallation("mcp:ambiguous", ambiguousId);
    await insertInstallation("mcp:shared", sharedBotId);

    await admin.begin(async (sql) => {
      await sql.unsafe(migrationSql);
    });

    const rows = await admin<
      Array<{ id: string; subjectId: string | null; kind: string; providerDomain: string }>
    >`
      select id, subject_id as "subjectId", kind, provider_domain as "providerDomain"
      from connections
      where workspace_id = ${workspace!.id}`;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(aliceId)?.subjectId).toBe("subject-alice");
    expect(byId.get(bobId)?.subjectId).toBe("subject-bob");
    expect(byId.get(ambiguousId)?.subjectId).toBeNull();
    expect(byId.get(manualSlackId)?.subjectId).toBeNull();
    expect(byId.get(nonSlackId)?.subjectId).toBeNull();
    expect(byId.get(sharedBotId)).toMatchObject({ subjectId: null, kind: "app_install" });

    const installations = await admin<
      Array<{ capabilityId: string; ref: Record<string, unknown> }>
    >`
      select capability_id as "capabilityId", config -> 'connectionRef' as ref
      from capability_installations
      where workspace_id = ${workspace!.id}`;
    const refs = new Map(
      installations.map((installation) => [installation.capabilityId, installation.ref]),
    );
    expect(refs.get("mcp:alice")).toEqual({
      providerDomain: "slack.com",
      kind: "oauth2",
      subjectScope: "subject",
    });
    expect(refs.get("mcp:ambiguous")).toMatchObject({ connectionId: ambiguousId });
    expect(refs.get("mcp:shared")).toMatchObject({ connectionId: sharedBotId });

    const app = postgres(shared!.appUrl, { max: 1 });
    try {
      const aliceVisible = await app.begin(async (sql) => {
        await sql`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
        await sql`select set_config('opengeni.subject_id', 'subject-alice', true)`;
        return await sql<{ id: string; subjectId: string | null }[]>`
          select id, subject_id as "subjectId"
          from connections
          where workspace_id = ${workspace!.id}
          order by id`;
      });
      expect(aliceVisible.some((row) => row.id === aliceId)).toBe(true);
      expect(aliceVisible.some((row) => row.id === bobId)).toBe(false);
      expect(aliceVisible.some((row) => row.id === sharedBotId)).toBe(true);
      expect(
        aliceVisible.every((row) => row.subjectId === null || row.subjectId === "subject-alice"),
      ).toBe(true);

      const bobVisible = await app.begin(async (sql) => {
        await sql`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
        await sql`select set_config('opengeni.subject_id', 'subject-bob', true)`;
        return await sql<{ id: string; subjectId: string | null }[]>`
          select id, subject_id as "subjectId"
          from connections
          where workspace_id = ${workspace!.id}
          order by id`;
      });
      expect(bobVisible.some((row) => row.id === bobId)).toBe(true);
      expect(bobVisible.some((row) => row.id === aliceId)).toBe(false);
      expect(bobVisible.some((row) => row.id === sharedBotId)).toBe(true);

      const forbiddenUpdate = await app.begin(async (sql) => {
        await sql`select set_config('opengeni.account_id', ${account!.id}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${workspace!.id}, true)`;
        await sql`select set_config('opengeni.subject_id', 'subject-alice', true)`;
        return await sql<{ id: string }[]>`
          update connections set last_error = 'forbidden fixture'
          where id = ${bobId}
          returning id`;
      });
      expect(forbiddenUpdate).toHaveLength(0);
    } finally {
      await app.end();
    }
  }, 180_000);
});
