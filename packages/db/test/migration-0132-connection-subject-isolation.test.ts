import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  OPENGENI_PERSONAL_SLACK_MCP_URL,
  selectCanonicalPersonalSlackConnection,
} from "@opengeni/contracts";
import postgres from "postgres";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  buildConnectionTokenResolver,
  createDb,
  encryptEnvironmentValue,
  listConnectionsMetadata,
  loadConnectionCredentialForBroker,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
const migrationPath = new URL("../drizzle/0132_connection_subject_isolation.sql", import.meta.url)
  .pathname;
let migrationSql = "";
const rawKey = randomBytes(32);
const settings = testSettings({
  environmentsEncryptionKey: rawKey.toString("base64"),
}) as Settings;
const encryptionKey = environmentsEncryptionKeyBytes(settings)!;
const accessTokenKey = ["access", "token"].join("_");

function encryptedSlackCredential(label: string): string {
  return encryptEnvironmentValue(
    encryptionKey,
    JSON.stringify({
      [accessTokenKey]: label,
      token_type: "Bearer",
      mcp_url: OPENGENI_PERSONAL_SLACK_MCP_URL,
    }),
  );
}

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
      id?: string;
      subjectId?: string | null;
      providerDomain: string;
      kind: "oauth2" | "app_install";
      status?: "active" | "needs_reauth" | "error" | "revoked";
      credentialEncrypted?: string;
      createdBySubjectId?: string | null;
      mcpUrl?: string;
      createdAt?: Date;
      updatedAt?: Date;
      targetWorkspaceId?: string;
    }): Promise<string> => {
      const id = input.id ?? randomUUID();
      const createdAt = input.createdAt ?? new Date();
      const updatedAt = input.updatedAt ?? createdAt;
      const [row] = await admin<{ id: string }[]>`
        insert into connections (
          id, account_id, workspace_id, subject_id, provider_domain, kind, status,
          credential_encrypted, metadata, created_by_subject_id, created_at, updated_at
        ) values (
          ${id}, ${account!.id}, ${input.targetWorkspaceId ?? workspace!.id},
          ${input.subjectId ?? null}, ${input.providerDomain}, ${input.kind},
          ${input.status ?? "active"}, ${input.credentialEncrypted ?? "fixture-encrypted"},
          ${admin.json(input.mcpUrl ? { mcpUrl: input.mcpUrl } : {})},
          ${input.createdBySubjectId ?? null}, ${createdAt}, ${updatedAt}
        ) returning id`;
      return row!.id;
    };

    const migrationStampedAt = new Date("2026-07-31T12:00:00.000Z");
    const tiedCreatedAt = new Date("2026-07-30T12:00:00.000Z");
    const aliceId = await insertConnection({
      id: "22222222-2222-4222-8222-222222222222",
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: encryptedSlackCredential("alice-lower-uuid"),
      createdBySubjectId: "subject-alice",
      mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL,
      createdAt: tiedCreatedAt,
      updatedAt: migrationStampedAt,
    });
    const aliceCanonicalId = await insertConnection({
      id: "33333333-3333-4333-8333-333333333333",
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: encryptedSlackCredential("alice-canonical"),
      createdBySubjectId: "subject-alice",
      mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL,
      createdAt: tiedCreatedAt,
      updatedAt: migrationStampedAt,
    });
    const aliceOlderId = await insertConnection({
      id: "ffffffff-ffff-4fff-bfff-fffffffffff0",
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: encryptedSlackCredential("alice-older"),
      createdBySubjectId: "subject-alice",
      mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL,
      createdAt: new Date("2026-07-29T12:00:00.000Z"),
      updatedAt: migrationStampedAt,
    });
    const aliceRevokedId = await insertConnection({
      id: "ffffffff-ffff-4fff-bfff-ffffffffffff",
      providerDomain: "slack.com",
      kind: "oauth2",
      status: "revoked",
      credentialEncrypted: encryptedSlackCredential("alice-revoked"),
      createdBySubjectId: "subject-alice",
      mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL,
      createdAt: new Date("2026-07-31T13:00:00.000Z"),
      updatedAt: migrationStampedAt,
    });
    const bobId = await insertConnection({
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: encryptedSlackCredential("bob"),
      createdBySubjectId: "subject-bob",
      mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL,
      createdAt: tiedCreatedAt,
      updatedAt: migrationStampedAt,
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
    const [otherWorkspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'migration 0132 other ws') returning id`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${otherWorkspace!.id}, ${account!.id})`;
    const crossWorkspaceId = await insertConnection({
      id: "eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee",
      targetWorkspaceId: otherWorkspace!.id,
      providerDomain: "slack.com",
      kind: "oauth2",
      credentialEncrypted: encryptedSlackCredential("alice-other-workspace"),
      createdBySubjectId: "subject-alice",
      mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL,
      createdAt: new Date("2026-08-01T13:00:00.000Z"),
      updatedAt: migrationStampedAt,
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
    expect(byId.get(aliceCanonicalId)?.subjectId).toBe("subject-alice");
    expect(byId.get(aliceOlderId)?.subjectId).toBe("subject-alice");
    expect(byId.get(aliceRevokedId)?.subjectId).toBe("subject-alice");
    expect(byId.get(bobId)?.subjectId).toBe("subject-bob");
    expect(byId.get(ambiguousId)?.subjectId).toBeNull();
    expect(byId.get(manualSlackId)?.subjectId).toBeNull();
    expect(byId.get(nonSlackId)?.subjectId).toBeNull();
    expect(byId.get(sharedBotId)).toMatchObject({ subjectId: null, kind: "app_install" });

    const [equalMigrationTimestamps] = await admin<
      Array<{ distinctUpdatedAt: number; rowCount: number }>
    >`
      select count(distinct updated_at)::int as "distinctUpdatedAt", count(*)::int as "rowCount"
      from connections
      where id in (${aliceId}, ${aliceCanonicalId}, ${aliceOlderId}, ${aliceRevokedId})`;
    expect(equalMigrationTimestamps).toEqual({ distinctUpdatedAt: 1, rowCount: 4 });

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

    const runtimeDb = createDb(shared!.appUrl);
    try {
      const visible = await listConnectionsMetadata(runtimeDb.db, workspace!.id, "subject-alice");
      const uiReconnectSelection = selectCanonicalPersonalSlackConnection(
        visible.filter(
          (connection) =>
            connection.subjectId === "subject-alice" &&
            connection.providerDomain === "slack.com" &&
            connection.kind === "oauth2" &&
            connection.metadata.mcpUrl === OPENGENI_PERSONAL_SLACK_MCP_URL,
        ),
      );
      expect(uiReconnectSelection?.id).toBe(aliceCanonicalId);

      const resolver = buildConnectionTokenResolver(runtimeDb.db, settings);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const broker = await loadConnectionCredentialForBroker(runtimeDb.db, settings, {
          workspaceId: workspace!.id,
          providerDomain: "slack.com",
          kind: "oauth2",
          subjectId: "subject-alice",
          allowSubjectOwned: true,
        });
        expect(broker?.id).toBe(uiReconnectSelection?.id);
        expect(broker?.status).toBe("active");
        expect(broker?.credential[accessTokenKey]).toBe("alice-canonical");

        const runtime = await resolver({
          workspaceId: workspace!.id,
          subjectId: "subject-alice",
          serverId: "personal-slack",
          connectionRef: {
            providerDomain: "slack.com",
            kind: "oauth2",
            subjectScope: "subject",
          },
          destinationUrl: OPENGENI_PERSONAL_SLACK_MCP_URL,
        });
        expect(runtime.status).toBe("ok");
        if (runtime.status !== "ok") throw new Error("Personal Slack credential did not resolve");
        expect(runtime.connectionId).toBe(aliceCanonicalId);
        expect(Object.values(runtime.headers)).toContain("Bearer alice-canonical");
      }

      const bobBroker = await loadConnectionCredentialForBroker(runtimeDb.db, settings, {
        workspaceId: workspace!.id,
        providerDomain: "slack.com",
        kind: "oauth2",
        subjectId: "subject-bob",
        allowSubjectOwned: true,
      });
      expect(bobBroker?.id).toBe(bobId);
      expect(bobBroker?.credential[accessTokenKey]).toBe("bob");

      const crossWorkspaceBroker = await loadConnectionCredentialForBroker(runtimeDb.db, settings, {
        workspaceId: otherWorkspace!.id,
        providerDomain: "slack.com",
        kind: "oauth2",
        subjectId: "subject-alice",
        allowSubjectOwned: true,
      });
      expect(crossWorkspaceBroker?.id).toBe(crossWorkspaceId);
      expect(
        await loadConnectionCredentialForBroker(runtimeDb.db, settings, {
          workspaceId: workspace!.id,
          providerDomain: "slack.com",
          kind: "oauth2",
          subjectId: "subject-absent",
          allowSubjectOwned: true,
        }),
      ).toBeNull();
    } finally {
      await runtimeDb.close();
    }
  }, 180_000);
});
