import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { normalizePermission, type Permission } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  consumeMcpOAuthAuthorizationRequest,
  createDb,
  createMcpOAuthAuthorizationRequest,
  exchangeMcpOAuthAuthorizationCode,
  getMcpOAuthAuthorizationRequest,
  rebindMcpOAuthAuthorizationRequest,
  registerMcpOAuthClient,
  resolveLiveMcpOAuthGrant,
  resolveMcpOAuthAccessToken,
  rotateMcpOAuthRefreshToken,
  type DbClient,
} from "../src";

const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const legacy: Permission[] = [
  "workspace:read",
  "variable-sets:read",
  "variable-sets:use",
  "environments:use",
  "secrets:use",
];
const canonical: Permission[] = ["workspace:read", "secrets:list", "secrets:use"];
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let scope: { accountId: string; workspaceId: string; subjectId: string };

const hash = () => createHash("sha256").update(crypto.randomUUID()).digest("hex");

beforeAll(async () => {
  if (!realDatabase) return;
  shared = await acquireSharedTestDatabase("canonical-oauth-permissions");
  if (!shared) throw new Error("Real PostgreSQL is required for OAuth permission retirement");
  client = createDb(shared.appUrl, { max: 2 });
  const subjectId = `oauth-canonical:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "oauth-canonical-test",
    accountExternalId: crypto.randomUUID(),
    workspaceExternalSource: "oauth-canonical-test",
    workspaceExternalId: crypto.randomUUID(),
    accountName: "Canonical OAuth",
    workspaceName: "Canonical OAuth",
    subjectId,
    workspacePermissions: canonical,
  });
  const grant = access.workspaceGrants[0]!;
  scope = { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function authorization() {
  const clientId = `ogmcp_client_${crypto.randomUUID()}`;
  const redirectUri = "https://client.example.test/callback";
  await registerMcpOAuthClient(client!.db, {
    clientId,
    redirectUris: [redirectUri],
    clientName: "Canonical permission test",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    registrationScopeHash: hash(),
  });
  const requestHash = hash();
  const resource = `https://api.example.test/v1/workspaces/${scope.workspaceId}/mcp`;
  const codeChallenge = "a".repeat(43);
  await createMcpOAuthAuthorizationRequest(client!.db, {
    ...scope,
    requestHash,
    clientId,
    redirectUri,
    resource,
    codeChallenge,
    permissions: legacy,
    toolIdentities: [],
    organizationAccess: null,
    state: null,
    expiresAt: new Date(Date.now() + 600_000),
  });
  const codeHash = hash();
  return { ...scope, requestHash, clientId, redirectUri, resource, codeChallenge, codeHash };
}

async function exchange(input: Awaited<ReturnType<typeof authorization>>) {
  const refreshTokenHash = hash();
  const accessTokenHash = hash();
  const access = await exchangeMcpOAuthAuthorizationCode(client!.db, {
    ...input,
    refreshTokenHash,
    accessTokenHash,
    accessExpiresAt: new Date(Date.now() + 900_000),
    refreshExpiresAt: new Date(Date.now() + 86_400_000),
  });
  if (!access) throw new Error("OAuth fixture failed to exchange its authorization code");
  return { access, refreshTokenHash, accessTokenHash };
}

describe.skipIf(!realDatabase)("canonical OAuth permission issuance", () => {
  test("new authorization, rebind and code issuance stop producing aliases without granting plaintext read", async () => {
    expect([...new Set(legacy.map(normalizePermission))]).toEqual(canonical);
    const input = await authorization();
    expect(
      (await getMcpOAuthAuthorizationRequest(client!.db, input.requestHash))?.permissions,
    ).toEqual(canonical);
    expect(
      await rebindMcpOAuthAuthorizationRequest(client!.db, {
        ...input,
        permissions: legacy,
        toolIdentities: [],
      }),
    ).toBe(true);
    expect(
      (await getMcpOAuthAuthorizationRequest(client!.db, input.requestHash))?.permissions,
    ).toEqual(canonical);
    // Emulate the still-unconsumed request written by the previous binary.
    await shared!.admin`update mcp_oauth_authorization_requests
      set permissions = ${shared!.admin.json(legacy)} where request_hash = ${input.requestHash}`;
    await consumeMcpOAuthAuthorizationRequest(client!.db, {
      ...input,
      codeExpiresAt: new Date(Date.now() + 300_000),
    });
    const [code] = await shared!.admin<{ permissions: Permission[] }[]>`
      select permissions from mcp_oauth_authorization_codes where code_hash = ${input.codeHash}`;
    expect(code?.permissions).toEqual(canonical);
    expect(code?.permissions).not.toContain("secrets:read");
  }, 180_000);

  test("a previous-binary code exchanges into canonical tokens with the same effective scope", async () => {
    const input = await authorization();
    await consumeMcpOAuthAuthorizationRequest(client!.db, {
      ...input,
      codeExpiresAt: new Date(Date.now() + 300_000),
    });
    await shared!.admin`update mcp_oauth_authorization_codes
      set permissions = ${shared!.admin.json(legacy)} where code_hash = ${input.codeHash}`;
    const { access, refreshTokenHash, accessTokenHash } = await exchange(input);
    expect(access.permissions).toEqual(canonical);
    const rows = await shared!.admin<{ permissions: Permission[] }[]>`
      select permissions from mcp_oauth_refresh_tokens where token_hash = ${refreshTokenHash}
      union all select permissions from mcp_oauth_access_tokens where token_hash = ${accessTokenHash}`;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.permissions).toEqual(canonical);
  }, 180_000);

  test("rotation drains aliases without rewriting old permission bytes, widening scope or losing live revocation", async () => {
    const input = await authorization();
    await consumeMcpOAuthAuthorizationRequest(client!.db, {
      ...input,
      codeExpiresAt: new Date(Date.now() + 300_000),
    });
    const prior = await exchange(input);
    // Synthetic historical rows: production records are never rewritten.
    await shared!.admin`update mcp_oauth_refresh_tokens
      set permissions = ${shared!.admin.json(legacy)} where token_hash = ${prior.refreshTokenHash}`;
    await shared!.admin`update mcp_oauth_access_tokens
      set permissions = ${shared!.admin.json(legacy)} where token_hash = ${prior.accessTokenHash}`;
    const oldAccess = await resolveMcpOAuthAccessToken(client!.db, prior.accessTokenHash);
    expect(oldAccess?.permissions).toEqual(legacy);
    expect((await resolveLiveMcpOAuthGrant(client!.db, oldAccess!))?.permissions).toEqual(
      canonical,
    );
    const accessTokenHash = hash();
    const nextRefreshTokenHash = hash();
    const next = await rotateMcpOAuthRefreshToken(client!.db, {
      ...input,
      refreshTokenHash: prior.refreshTokenHash,
      nextRefreshTokenHash,
      accessTokenHash,
      accessExpiresAt: new Date(Date.now() + 900_000),
      refreshExpiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(next?.permissions).toEqual(canonical);
    expect(next?.refreshFamilyId).toBe(prior.access.refreshFamilyId);
    expect(next?.refreshGeneration).toBe(2);
    const oldRows = await shared!.admin<{ permissions: Permission[] }[]>`
      select permissions from mcp_oauth_refresh_tokens where token_hash = ${prior.refreshTokenHash}
      union all select permissions from mcp_oauth_access_tokens where token_hash = ${prior.accessTokenHash}`;
    for (const row of oldRows) expect(row.permissions).toEqual(legacy);
    const newRows = await shared!.admin<{ permissions: Permission[] }[]>`
      select permissions from mcp_oauth_refresh_tokens where token_hash = ${nextRefreshTokenHash}
      union all select permissions from mcp_oauth_access_tokens where token_hash = ${accessTokenHash}`;
    for (const row of newRows) expect(row.permissions).toEqual(canonical);
    // A subsequent membership downgrade still narrows both old and new tokens.
    try {
      await shared!.admin`update workspace_memberships set permissions = '["workspace:read"]'::jsonb
        where workspace_id = ${scope.workspaceId} and subject_id = ${scope.subjectId}`;
      expect((await resolveLiveMcpOAuthGrant(client!.db, oldAccess!))?.permissions).toEqual([
        "workspace:read",
      ]);
      expect((await resolveLiveMcpOAuthGrant(client!.db, next!))?.permissions).toEqual([
        "workspace:read",
      ]);
      await shared!.admin`update workspace_memberships set permissions = '[]'::jsonb
        where workspace_id = ${scope.workspaceId} and subject_id = ${scope.subjectId}`;
      expect(await resolveLiveMcpOAuthGrant(client!.db, next!)).toBeNull();
    } finally {
      await shared!
        .admin`update workspace_memberships set permissions = ${shared!.admin.json(canonical)}
        where workspace_id = ${scope.workspaceId} and subject_id = ${scope.subjectId}`;
    }
    // Reuse still revokes the family; canonicalization is not a new grant.
    expect(
      await rotateMcpOAuthRefreshToken(client!.db, {
        ...input,
        refreshTokenHash: prior.refreshTokenHash,
        nextRefreshTokenHash: hash(),
        accessTokenHash: hash(),
        accessExpiresAt: new Date(Date.now() + 900_000),
        refreshExpiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).toBeNull();
    expect(await resolveMcpOAuthAccessToken(client!.db, accessTokenHash)).toBeNull();
  }, 180_000);
});
