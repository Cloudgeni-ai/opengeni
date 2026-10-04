import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  normalizeOrganizationAccessPolicy,
  organizationAccessPresetPermissions,
  type OrganizationAccessPolicy,
} from "@opengeni/contracts";
import {
  consumeMcpOAuthAuthorizationRequest,
  createDb,
  createMcpOAuthAuthorizationRequest,
  exchangeMcpOAuthAuthorizationCode,
  listOrganizationMcpConnections,
  resolveLiveMcpOAuthGrant,
  resolveMcpOAuthAccessToken,
  revokeOrganizationMcpConnection,
  rotateMcpOAuthRefreshToken,
  setMcpOAuthRequestOrganizationAccess,
  updateOrganizationMcpConnectionAccess,
  type DbClient,
} from "../src";

const budget = 120_000;
const requireReal = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const available = requireReal || !!process.env.OPENGENI_TEST_PG_URL || !!Bun.which("docker");
const accountId = crypto.randomUUID();
const otherAccountId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const clientId = `ogmcp_client_${crypto.randomUUID()}`;
const subjectId = `user:${crypto.randomUUID()}`;
const resource = "https://api.example.test/v1/mcp";
const hash = () => crypto.randomUUID().replaceAll("-", "").padEnd(64, "0");
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

const readOnly: OrganizationAccessPolicy = {
  preset: "read_only",
  permissions: organizationAccessPresetPermissions("read_only"),
  workspaceScope: { kind: "all" },
};
const custom: OrganizationAccessPolicy = normalizeOrganizationAccessPolicy({
  preset: "custom",
  permissions: ["workspace:read", "sessions:read", "sessions:create"],
  workspaceScope: { kind: "selected", workspaceIds: [workspaceId] },
});

let shared: SharedTestDatabase | null = null;
let client: DbClient;

describe.skipIf(!available)("organization MCP connections real PostgreSQL", () => {
  beforeAll(async () => {
    shared = await acquireSharedTestDatabase("organization_mcp_connections");
    if (!shared) throw new Error("Real PostgreSQL required for organization MCP connections");
    client = createDb(shared.appUrl, { max: 4 });
    for (const id of [accountId, otherAccountId]) {
      await shared.admin`insert into managed_accounts (id, name) values (${id}, 'Connections fixture')`;
    }
    await shared.admin`insert into workspaces (id, account_id, name) values (${workspaceId}, ${accountId}, 'Design preview')`;
    await shared.admin`insert into mcp_oauth_clients (
      client_id, redirect_uris, client_name, grant_types, response_types, registration_scope_hash
    ) values (
      ${clientId}, ${shared.admin.json(["http://127.0.0.1:4567/callback"])}, 'Claude Code',
      ${shared.admin.json(["authorization_code", "refresh_token"])},
      ${shared.admin.json(["code"])}, ${"5".repeat(64)}
    )`;
  }, budget);

  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, budget);

  async function connect(access: OrganizationAccessPolicy) {
    const requestHash = hash();
    await createMcpOAuthAuthorizationRequest(client.db, {
      requestHash,
      clientId,
      accountId: otherAccountId,
      workspaceId: null,
      subjectId,
      resource,
      redirectUri: "http://127.0.0.1:4567/callback",
      codeChallenge: "c".repeat(43),
      state: null,
      permissions: [],
      toolIdentities: [],
      organizationAccess: readOnly,
      expiresAt: inDays(1),
    });
    expect(
      await setMcpOAuthRequestOrganizationAccess(client.db, {
        requestHash,
        subjectId: "user:someone-else",
        accountId,
        organizationAccess: access,
      }),
    ).toBe(false);
    expect(
      await setMcpOAuthRequestOrganizationAccess(client.db, {
        requestHash,
        subjectId,
        accountId,
        organizationAccess: access,
      }),
    ).toBe(true);
    const codeHash = hash();
    const consumed = await consumeMcpOAuthAuthorizationRequest(client.db, {
      requestHash,
      subjectId,
      codeHash,
      codeExpiresAt: inDays(1),
    });
    expect(consumed?.organizationAccess).toEqual(access);
    expect(consumed?.accountId).toBe(accountId);
    const accessTokenHash = hash();
    const refreshTokenHash = hash();
    const exchanged = await exchangeMcpOAuthAuthorizationCode(client.db, {
      codeHash,
      clientId,
      redirectUri: "http://127.0.0.1:4567/callback",
      resource,
      codeChallenge: "c".repeat(43),
      accessTokenHash,
      refreshTokenHash,
      accessExpiresAt: inDays(1),
      refreshExpiresAt: inDays(30),
    });
    return { exchanged: exchanged!, accessTokenHash, refreshTokenHash };
  }

  test(
    "an organization sign-in carries its access setting through code, token and refresh",
    async () => {
      const { exchanged, accessTokenHash, refreshTokenHash } = await connect(custom);
      expect(exchanged.workspaceId).toBeNull();
      expect(exchanged.organizationAccess).toEqual(custom);
      const resolved = await resolveMcpOAuthAccessToken(client.db, accessTokenHash);
      expect(resolved?.organizationAccess).toEqual(custom);
      // Organization connections never resolve as a single-workspace grant.
      expect(await resolveLiveMcpOAuthGrant(client.db, resolved!)).toBeNull();
      const rotatedAccess = hash();
      const rotated = await rotateMcpOAuthRefreshToken(client.db, {
        refreshTokenHash,
        clientId,
        resource,
        accessTokenHash: rotatedAccess,
        nextRefreshTokenHash: hash(),
        accessExpiresAt: inDays(1),
        refreshExpiresAt: inDays(30),
      });
      expect(rotated?.organizationAccess).toEqual(custom);
      const [listed] = await listOrganizationMcpConnections(client.db, {
        accountId,
        connectionId: exchanged.refreshFamilyId,
      });
      expect(listed).toMatchObject({
        id: exchanged.refreshFamilyId,
        subjectId,
        clientName: "Claude Code",
        redirectUris: ["http://127.0.0.1:4567/callback"],
        organizationAccess: custom,
      });
      expect(listed!.lastUsedAt).not.toBeNull();
      // The connection date survives refresh rotation.
      const [stored] = await shared!.admin`select count(distinct connected_at)::int as dates
        from mcp_oauth_refresh_tokens where family_id = ${exchanged.refreshFamilyId}`;
      expect(stored!.dates).toBe(1);
    },
    budget,
  );

  test(
    "changing access applies to live tokens; disconnecting refuses every token",
    async () => {
      const { exchanged, accessTokenHash } = await connect(readOnly);
      expect(
        await updateOrganizationMcpConnectionAccess(client.db, {
          accountId: otherAccountId,
          connectionId: exchanged.refreshFamilyId,
          organizationAccess: custom,
        }),
      ).toBe(false);
      expect(
        await updateOrganizationMcpConnectionAccess(client.db, {
          accountId,
          connectionId: exchanged.refreshFamilyId,
          organizationAccess: custom,
        }),
      ).toBe(true);
      expect(
        (await resolveMcpOAuthAccessToken(client.db, accessTokenHash))?.organizationAccess,
      ).toEqual(custom);
      expect(
        await listOrganizationMcpConnections(client.db, { accountId, subjectId: "user:nobody" }),
      ).toEqual([]);
      expect(
        await revokeOrganizationMcpConnection(client.db, {
          accountId: otherAccountId,
          connectionId: exchanged.refreshFamilyId,
        }),
      ).toBe(false);
      expect(
        await revokeOrganizationMcpConnection(client.db, {
          accountId,
          connectionId: exchanged.refreshFamilyId,
        }),
      ).toBe(true);
      expect(await resolveMcpOAuthAccessToken(client.db, accessTokenHash)).toBeNull();
      expect(
        await listOrganizationMcpConnections(client.db, {
          accountId,
          connectionId: exchanged.refreshFamilyId,
        }),
      ).toEqual([]);
    },
    budget,
  );

  test(
    "a grant holds exactly one target: a workspace or an organization access setting",
    async () => {
      for (const [target, access] of [
        [null, null],
        [workspaceId, readOnly],
      ] as const) {
        await expect(
          createMcpOAuthAuthorizationRequest(client.db, {
            requestHash: hash(),
            clientId,
            accountId,
            workspaceId: target,
            subjectId,
            resource,
            redirectUri: "http://127.0.0.1:4567/callback",
            codeChallenge: "c".repeat(43),
            state: null,
            permissions: [],
            toolIdentities: [],
            organizationAccess: access,
            expiresAt: inDays(1),
          }),
        ).rejects.toThrow();
      }
    },
    budget,
  );
});
