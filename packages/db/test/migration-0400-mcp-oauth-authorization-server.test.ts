// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { NON_RLS_RUNTIME_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migrationPath = new URL(
  "../drizzle/0400_mcp_oauth_authorization_server.sql",
  import.meta.url,
);
const source = await Bun.file(migrationPath).text();
const repositorySource = await Bun.file(new URL("../src/mcp-oauth.ts", import.meta.url)).text();
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

setDefaultTimeout(900_000);

let blank: BlankTestDatabase | null = null;
let admin: ReturnType<typeof postgres> | null = null;
let app: ReturnType<typeof postgres> | null = null;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0400-mcp-oauth");
  if (!blank) {
    if (requireRealDatabase) throw new Error("migration 0400 requires real PostgreSQL");
    return;
  }
  if (!blank.appPassword) throw new Error("migration 0400 app password is unavailable");
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
}, 900_000);

afterAll(async () => {
  await app?.end().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  await blank?.release();
}, 180_000);

describe("migration 0400 MCP OAuth authorization server", () => {
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

  test("consumes codes and refresh tokens once with exact client and resource binding", () => {
    expect(repositorySource).toMatch(
      /delete from mcp_oauth_authorization_codes[\s\S]*code_hash = \$\{input\.codeHash\}[\s\S]*client_id = \$\{input\.clientId\}[\s\S]*redirect_uri = \$\{input\.redirectUri\}[\s\S]*resource = \$\{input\.resource\}[\s\S]*code_challenge = \$\{input\.codeChallenge\}[\s\S]*expires_at > clock_timestamp\(\)/u,
    );
    expect(repositorySource).toMatch(
      /update mcp_oauth_refresh_tokens[\s\S]*set revoked_at = clock_timestamp\(\)[\s\S]*token_hash = \$\{input\.refreshTokenHash\}[\s\S]*client_id = \$\{input\.clientId\}[\s\S]*resource = \$\{input\.resource\}[\s\S]*revoked_at is null[\s\S]*expires_at > clock_timestamp\(\)/u,
    );
    expect(repositorySource).toContain("const generation = Number(row.generation) + 1");
    expect(repositorySource).toMatch(
      /if \(input\.refreshTokenHash\) \{[\s\S]*insert into mcp_oauth_refresh_tokens/u,
    );
  });
});
