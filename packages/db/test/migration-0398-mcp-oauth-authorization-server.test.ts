import { describe, expect, test } from "bun:test";

const migrationPath = new URL(
  "../drizzle/0398_mcp_oauth_authorization_server.sql",
  import.meta.url,
);
const source = await Bun.file(migrationPath).text();
const repositorySource = await Bun.file(new URL("../src/mcp-oauth.ts", import.meta.url)).text();

describe("migration 0398 MCP OAuth authorization server", () => {
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
    expect(source).toContain("opengeni.migration_application_roles");
    expect(source).toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE");
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
