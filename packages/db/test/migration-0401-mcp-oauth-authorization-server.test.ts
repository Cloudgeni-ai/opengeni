// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { createDb, rotateMcpOAuthRefreshToken, type DbClient } from "../src";
import { NON_RLS_RUNTIME_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migrationPath = new URL(
  "../drizzle/0401_mcp_oauth_authorization_server.sql",
  import.meta.url,
);
const source = await Bun.file(migrationPath).text();
const repositorySource = await Bun.file(new URL("../src/mcp-oauth.ts", import.meta.url)).text();
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(900_000);

let blank: BlankTestDatabase | null = null;
let admin: ReturnType<typeof postgres> | null = null;
let app: ReturnType<typeof postgres> | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0400-mcp-oauth");
  if (!blank) {
    if (requireRealDatabase) throw new Error("migration 0401 requires real PostgreSQL");
    return;
  }
  if (!blank.appPassword) throw new Error("migration 0401 app password is unavailable");
  admin = postgres(blank.databaseUrl, { max: 1, prepare: false });
  await admin.unsafe(`
    create schema opengeni_private;
    grant usage on schema opengeni_private to opengeni_app;
    create table managed_accounts (id uuid primary key);
    create table workspaces (
      id uuid primary key,
      account_id uuid not null references managed_accounts(id) on delete cascade,
      unique (id, account_id)
    );
  `);
  await admin.begin(async (transaction) => {
    await transaction.unsafe(source);
  });
  const appUrl = new URL(blank.databaseUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = blank.appPassword;
  app = postgres(appUrl.toString(), { max: 1, prepare: false });
  client = createDb(appUrl.toString());
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await app?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await blank?.release();
}, 180_000);

describe("migration 0401 MCP OAuth authorization server", () => {
  test("stores only token hashes and binds every grant to workspace/account/resource", () => {
    expect(source).toContain("-- deployment-mode: rolling");
    expect(source).toContain("CREATE TABLE mcp_oauth_clients");
    expect(source).toContain("CREATE TABLE mcp_oauth_authorization_codes");
    expect(source).toContain("CREATE TABLE mcp_oauth_refresh_tokens");
    expect(source).toContain("CREATE TABLE mcp_oauth_access_tokens");
    expect(source).not.toMatch(/access_token\s+text/iu);
    expect(source).not.toMatch(/refresh_token\s+text/iu);
    expect(source.match(/token_hash text PRIMARY KEY/g)).toHaveLength(2);
    expect(source.match(/REFERENCES workspaces\(id, account_id\)/g)).toHaveLength(4);
    expect(source).toContain("code_challenge text NOT NULL");
    expect(source).toContain("tool_identities jsonb NOT NULL");
  });

  test("keeps public access revoked and grants only configured application roles", () => {
    expect(source).toContain("REVOKE ALL ON mcp_oauth_clients");
    expect(source).toContain("REVOKE ALL ON FUNCTION opengeni_private.reap_mcp_oauth_state");
    expect(source).toContain("opengeni.migration_application_roles");
    expect(source).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE");
    expect(source).toContain(
      "GRANT EXECUTE ON FUNCTION opengeni_private.register_mcp_oauth_client",
    );
    for (const table of [
      "mcp_oauth_access_tokens",
      "mcp_oauth_authorization_codes",
      "mcp_oauth_authorization_requests",
      "mcp_oauth_clients",
      "mcp_oauth_refresh_tokens",
    ] as const) {
      expect(NON_RLS_RUNTIME_TABLES).toContain(table);
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
  });

  test("durably bounds registration and reaps expired OAuth state", () => {
    expect(source).toContain("registration_scope_hash text NOT NULL");
    expect(source).toContain("expires_at timestamptz NOT NULL DEFAULT (now() + interval '1 day')");
    expect(source).toContain("CREATE FUNCTION opengeni_private.reap_mcp_oauth_state");
    expect(source).toContain("FOR UPDATE SKIP LOCKED");
    expect(source).toContain("CREATE FUNCTION opengeni_private.register_mcp_oauth_client");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("global_count >= 600 OR scoped_count >= 20");
    expect(source).toContain("USING ERRCODE = 'P0004'");
    expect(repositorySource).toContain("clock_timestamp() + interval '31 days'");
  });

  test("enforces the registration quota and reaps expired clients as the application role", async () => {
    if (!app || !admin) return;
    const registrationScopeHash = "a".repeat(64);
    for (let index = 1; index <= 20; index += 1) {
      const [registered] = await app<{ client_id: string }[]>`
        select client_id
        from opengeni_private.register_mcp_oauth_client(
          ${`ogmcp_client_smoke_${index.toString().padStart(4, "0")}`},
          ${JSON.stringify(["http://127.0.0.1:4567/callback"])}::jsonb,
          'Migration smoke client',
          ${JSON.stringify(["authorization_code", "refresh_token"])}::jsonb,
          ${JSON.stringify(["code"])}::jsonb,
          ${registrationScopeHash}
        )`;
      expect(registered?.client_id).toBe(`ogmcp_client_smoke_${index.toString().padStart(4, "0")}`);
    }
    await expect(
      app`
        select client_id
        from opengeni_private.register_mcp_oauth_client(
          'ogmcp_client_smoke_0021',
          ${JSON.stringify(["http://127.0.0.1:4567/callback"])}::jsonb,
          'Migration smoke client',
          ${JSON.stringify(["authorization_code", "refresh_token"])}::jsonb,
          ${JSON.stringify(["code"])}::jsonb,
          ${registrationScopeHash}
        )`,
    ).rejects.toMatchObject({ code: "P0004" });

    await admin`
      insert into mcp_oauth_clients (
        client_id, redirect_uris, client_name, grant_types, response_types,
        registration_scope_hash, created_at, expires_at
      ) values (
        'ogmcp_client_expired_0001',
        ${JSON.stringify(["http://127.0.0.1:4567/callback"])}::jsonb,
        'Expired migration client',
        ${JSON.stringify(["authorization_code"])}::jsonb,
        ${JSON.stringify(["code"])}::jsonb,
        ${"b".repeat(64)},
        clock_timestamp() - interval '2 days',
        clock_timestamp() - interval '1 day'
      )`;
    const [reaped] = await app<{ removed: number }[]>`
      select opengeni_private.reap_mcp_oauth_state(128) as removed`;
    expect(Number(reaped?.removed)).toBeGreaterThanOrEqual(1);
    const [remaining] = await admin<{ count: number }[]>`
      select count(*)::integer as count
      from mcp_oauth_clients
      where client_id = 'ogmcp_client_expired_0001'`;
    expect(Number(remaining?.count)).toBe(0);
  });

  test("consumes codes and rotates refresh tokens with exact client and resource binding", () => {
    expect(repositorySource).toMatch(
      /delete from mcp_oauth_authorization_codes[\s\S]*code_hash = \$\{input\.codeHash\}[\s\S]*client_id = \$\{input\.clientId\}[\s\S]*redirect_uri = \$\{input\.redirectUri\}[\s\S]*resource = \$\{input\.resource\}[\s\S]*code_challenge = \$\{input\.codeChallenge\}[\s\S]*expires_at > clock_timestamp\(\)/u,
    );
    expect(repositorySource).toContain("mcp-oauth-refresh-family:");
    expect(repositorySource).toContain("for update");
    expect(repositorySource).toContain("revokeMcpOAuthRefreshFamily(tx, row.family_id)");
    expect(repositorySource).toContain("where refresh_family_id = ${familyId}");
    expect(repositorySource).toContain("toISOString()}::timestamptz");
    expect(repositorySource).toContain("const generation = Number(row.generation) + 1");
    expect(repositorySource).toMatch(
      /if \(input\.refreshTokenHash\) \{[\s\S]*insert into mcp_oauth_refresh_tokens/u,
    );
  });

  test("revokes the whole rotated family when an older refresh token is replayed", async () => {
    if (!admin || !client) return;
    const accountId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const familyId = crypto.randomUUID();
    const clientId = `ogmcp_replay_${crypto.randomUUID()}`;
    const oldTokenHash = "1".repeat(64);
    const nextTokenHash = "2".repeat(64);
    const accessTokenHash = "3".repeat(64);
    const resource = `https://api.example.test/mcp/workspaces/${workspaceId}`;
    await admin`insert into managed_accounts (id) values (${accountId})`;
    await admin`insert into workspaces (id, account_id) values (${workspaceId}, ${accountId})`;
    await admin`insert into mcp_oauth_clients (
      client_id, redirect_uris, client_name, grant_types, response_types, registration_scope_hash
    ) values (
      ${clientId}, ${JSON.stringify(["http://127.0.0.1/callback"])}::jsonb, 'Replay test',
      ${JSON.stringify(["authorization_code", "refresh_token"])}::jsonb,
      ${JSON.stringify(["code"])}::jsonb, ${"4".repeat(64)}
    )`;
    await admin`insert into mcp_oauth_refresh_tokens (
      token_hash, family_id, generation, client_id, account_id, workspace_id,
      subject_id, resource, permissions, tool_identities, expires_at
    ) values (
      ${oldTokenHash}, ${familyId}, 1, ${clientId}, ${accountId}, ${workspaceId},
      'subject:refresh-replay', ${resource}, '[]'::jsonb, '[]'::jsonb,
      clock_timestamp() + interval '1 day'
    )`;

    const rotated = await rotateMcpOAuthRefreshToken(client.db, {
      refreshTokenHash: oldTokenHash,
      clientId,
      resource,
      accessTokenHash,
      nextRefreshTokenHash: nextTokenHash,
      accessExpiresAt: new Date(Date.now() + 15 * 60_000),
      refreshExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
    expect(rotated?.refreshGeneration).toBe(2);

    expect(
      await rotateMcpOAuthRefreshToken(client.db, {
        refreshTokenHash: oldTokenHash,
        clientId,
        resource,
        accessTokenHash: "5".repeat(64),
        nextRefreshTokenHash: "6".repeat(64),
        accessExpiresAt: new Date(Date.now() + 15 * 60_000),
        refreshExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      }),
    ).toBeNull();

    const [liveRefresh] = await admin<{ count: number }[]>`
      select count(*)::integer as count from mcp_oauth_refresh_tokens
      where family_id = ${familyId} and revoked_at is null`;
    const [liveAccess] = await admin<{ count: number }[]>`
      select count(*)::integer as count from mcp_oauth_access_tokens
      where refresh_family_id = ${familyId} and revoked_at is null`;
    expect(liveRefresh?.count).toBe(0);
    expect(liveAccess?.count).toBe(0);
  });
});
