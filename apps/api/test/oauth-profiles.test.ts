import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  createDb,
  createImportBatch,
  getGlobalCatalogOAuthProfile,
  upsertRegistryCapabilityCatalogItem,
  type DbClient,
} from "@opengeni/db";
import { readSignedState } from "@opengeni/github";
import {
  acquireSharedTestDatabase,
  startTestMcpServer,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { HTTPException } from "hono/http-exception";
import { createApp } from "../src/app";
import { buildAuthorizationUrl } from "../src/integrations/oauth-client";
import {
  DEFAULT_OAUTH_PROFILE,
  OFFICIAL_GMAIL_MCP_URL,
  OFFICIAL_SLACK_MCP_URL,
  assertAuthorizationServerNotReserved,
  assertAuthorizationServerPins,
  assertOwnershipAllowed,
  builtInOAuthProfileFor,
  defaultOwnershipFor,
  oauthProfileFromCatalog,
} from "../src/integrations/oauth-profiles";

const DELEGATION_SECRET = "oauth-profiles-delegation-secret";
const STATE_SECRET = "oauth-profiles-state-secret";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let settings: Settings;

const rawKey = randomBytes(32);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_oauth_profiles");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[oauth-profiles] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  settings = testSettings({
    productAccessMode: "managed",
    delegationSecret: DELEGATION_SECRET,
    environmentsEncryptionKey: rawKey.toString("base64"),
    integrationsEnabled: true,
    integrationsStateSecret: STATE_SECRET,
    publicBaseUrl: "https://api.opengeni.test",
  }) as Settings;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

describe("built-in OAuth profiles", () => {
  test("resolve hosted Slack by exact URL and by provider domain, Gmail by exact URL only", () => {
    expect(builtInOAuthProfileFor({ mcpUrl: OFFICIAL_SLACK_MCP_URL })?.key).toBe(
      "hosted-slack-mcp",
    );
    expect(
      builtInOAuthProfileFor({
        mcpUrl: "https://anything.example/mcp",
        providerDomain: "slack.com",
      })?.key,
    ).toBe("hosted-slack-mcp");
    expect(builtInOAuthProfileFor({ mcpUrl: OFFICIAL_GMAIL_MCP_URL })?.key).toBe("official-gmail");
    expect(
      builtInOAuthProfileFor({
        mcpUrl: "https://anything.example/mcp",
        providerDomain: "gmailmcp.googleapis.com",
      }),
    ).toBeNull();
    expect(builtInOAuthProfileFor({ mcpUrl: "https://mcp.linear.app/mcp" })).toBeNull();
  });

  test("personal-only profiles default an omitted ownership to personal and reject workspace", () => {
    const slack = builtInOAuthProfileFor({ mcpUrl: OFFICIAL_SLACK_MCP_URL })!;
    const gmail = builtInOAuthProfileFor({ mcpUrl: OFFICIAL_GMAIL_MCP_URL })!;
    expect(defaultOwnershipFor(slack)).toBe("personal");
    expect(defaultOwnershipFor(gmail)).toBe("personal");
    expect(defaultOwnershipFor(DEFAULT_OAUTH_PROFILE)).toBe("workspace");
    expect(() => assertOwnershipAllowed(slack, "personal")).not.toThrow();
    expect(() => assertOwnershipAllowed(slack, "workspace")).toThrow(
      "Slack's hosted MCP connection is personal only",
    );
    expect(() => assertOwnershipAllowed(gmail, "workspace")).toThrow(
      "Gmail connections are personal only",
    );
    expect(() => assertOwnershipAllowed(DEFAULT_OAUTH_PROFILE, "workspace")).not.toThrow();
    expect(() => assertOwnershipAllowed(DEFAULT_OAUTH_PROFILE, "personal")).not.toThrow();
  });

  test("a Google-identity authorization server is reserved for the Gmail profile", () => {
    const google = {
      issuer: "https://accounts.google.com",
      authorizationServer: "https://accounts.google.com",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
    };
    expect(() => assertAuthorizationServerNotReserved(google, DEFAULT_OAUTH_PROFILE)).toThrow(
      `Google OAuth is allowed only for ${OFFICIAL_GMAIL_MCP_URL}`,
    );
    expect(() =>
      assertAuthorizationServerNotReserved(
        google,
        builtInOAuthProfileFor({ mcpUrl: OFFICIAL_GMAIL_MCP_URL })!,
      ),
    ).not.toThrow();
    expect(() =>
      assertAuthorizationServerNotReserved(
        {
          ...google,
          issuer: "https://as.example",
          authorizationServer: "https://as.example",
        },
        DEFAULT_OAUTH_PROFILE,
      ),
    ).not.toThrow();
  });

  test("origin pins constrain issuer, authorization, and token endpoints independently", () => {
    const pins = {
      issuerOrigins: ["https://as.example"],
      authorizationEndpointOrigins: ["https://as.example"],
      tokenEndpointOrigins: ["https://token.example"],
      message: "authorization metadata escaped its pins",
    };
    const as = {
      issuer: "https://as.example",
      authorizationServer: "https://as.example",
      authorizationEndpoint: "https://as.example/authorize",
      tokenEndpoint: "https://token.example/token",
    };
    expect(() => assertAuthorizationServerPins(as, pins)).not.toThrow();
    for (const broken of [
      { ...as, issuer: "https://attacker.example" },
      { ...as, authorizationServer: "https://attacker.example" },
      { ...as, authorizationEndpoint: "https://attacker.example/authorize" },
      { ...as, tokenEndpoint: "https://attacker.example/token" },
    ]) {
      expect(() => assertAuthorizationServerPins(broken, pins)).toThrow(
        "authorization metadata escaped its pins",
      );
    }
  });
});

describe("catalog OAuth profiles", () => {
  test("a valid catalog profile narrows ownership, binding, pins, scopes, and authorize params", () => {
    const profile = oauthProfileFromCatalog("https://mcp.pinned.example/mcp", {
      clientSource: "dcr",
      exactMcpUrl: "https://mcp.pinned.example/mcp",
      pinnedIssuerOrigins: ["https://auth.pinned.example"],
      pinnedEndpointOrigins: ["https://auth.pinned.example"],
      sendResourceParameter: false,
      allowedOwnership: ["personal"],
      requestedScopes: ["files:read"],
      extraAuthorizeParams: { audience: "pinned" },
    });
    expect(profile).not.toBeNull();
    expect(profile!.key).toBe("catalog:https://mcp.pinned.example/mcp");
    expect(profile!.clientSource).toBe("dcr");
    expect(profile!.exactMcpBinding).toBe(true);
    expect(profile!.requireExactMcpUrl?.url).toBe("https://mcp.pinned.example/mcp");
    expect(profile!.sendResourceParameter).toBe(false);
    expect(profile!.requestedScopes).toEqual(["files:read"]);
    expect(profile!.extraAuthorizeParams).toEqual({ audience: "pinned" });
    expect(defaultOwnershipFor(profile!)).toBe("personal");
    expect(() => assertOwnershipAllowed(profile!, "workspace")).toThrow(
      "allows only personal connections",
    );
    expect(() =>
      assertAuthorizationServerPins(
        {
          issuer: "https://attacker.example",
          authorizationServer: "https://auth.pinned.example",
          authorizationEndpoint: "https://auth.pinned.example/authorize",
          tokenEndpoint: "https://auth.pinned.example/token",
        },
        profile!.authorizationServer!,
      ),
    ).toThrow("did not remain bound to the reviewed provider origins");
  });

  test("an empty profile keeps the default behavior and malformed profiles are ignored", () => {
    const empty = oauthProfileFromCatalog("https://mcp.example/mcp", {});
    expect(empty).not.toBeNull();
    expect(empty!.allowedOwnership).toEqual(DEFAULT_OAUTH_PROFILE.allowedOwnership);
    expect(empty!.exactMcpBinding).toBe(false);
    expect(empty!.sendResourceParameter).toBe(true);
    expect(empty!.authorizationServer).toBeUndefined();

    expect(oauthProfileFromCatalog("https://mcp.example/mcp", null)).toBeNull();
    expect(oauthProfileFromCatalog("https://mcp.example/mcp", "profile")).toBeNull();
    expect(oauthProfileFromCatalog("https://mcp.example/mcp", { unknownKey: true })).toBeNull();
    expect(oauthProfileFromCatalog("https://mcp.example/mcp", { allowedOwnership: [] })).toBeNull();
    expect(
      oauthProfileFromCatalog("https://mcp.example/mcp", { allowedOwnership: ["group"] }),
    ).toBeNull();
    expect(
      oauthProfileFromCatalog("https://mcp.example/mcp", { pinnedIssuerOrigins: ["nonsense"] }),
    ).toBeNull();
  });

  test("a catalog profile cannot loosen a built-in fence because built-ins resolve first", () => {
    // Resolution order is built-in || catalog || default; the catalog layer is
    // consulted only when no built-in matched, so data cannot re-open Slack or
    // Gmail. This pins that order.
    expect(builtInOAuthProfileFor({ mcpUrl: OFFICIAL_SLACK_MCP_URL })).not.toBeNull();
    expect(builtInOAuthProfileFor({ mcpUrl: OFFICIAL_GMAIL_MCP_URL })).not.toBeNull();
    const wouldLoosen = oauthProfileFromCatalog(OFFICIAL_SLACK_MCP_URL, {
      allowedOwnership: ["workspace", "personal"],
    });
    expect(wouldLoosen).not.toBeNull();
    // The schema has no field for deployment clients or reserved servers, so a
    // catalog profile cannot claim Slack's settings credentials or Google's
    // authorization server even if it matched.
    expect("requireDeploymentClient" in wouldLoosen!).toBe(false);
  });

  test("buildAuthorizationUrl appends profile-declared extra parameters", () => {
    const url = new URL(
      buildAuthorizationUrl({
        endpoint: "https://auth.pinned.example/authorize",
        settings: testSettings({ environment: "test" }) as Settings,
        clientId: "client",
        redirectUri: "https://api.opengeni.test/v1/integrations/oauth/callback",
        state: "signed-state",
        resource: "https://mcp.pinned.example/mcp",
        verifier: "test-pkce-verifier",
        scopes: ["files:read"],
        resourceParameterSupported: true,
        extraParams: { audience: "pinned", tenant: "acme" },
      }),
    );
    expect(url.searchParams.get("audience")).toBe("pinned");
    expect(url.searchParams.get("tenant")).toBe("acme");
    expect(url.searchParams.get("resource")).toBe("https://mcp.pinned.example/mcp");
    // Extra params never displace the security parameters.
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("signed-state");
  });

  test("ownership asserts raise typed HTTP 422s", () => {
    try {
      assertOwnershipAllowed(
        builtInOAuthProfileFor({ mcpUrl: OFFICIAL_SLACK_MCP_URL })!,
        "workspace",
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPException);
      expect((error as HTTPException).status).toBe(422);
    }
  });
});

describe("catalog-profile-driven OAuth start", () => {
  function app() {
    return createApp({
      settings,
      db: client.db,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    } as never);
  }

  async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
    const [account] = await shared!.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('acct') returning id`;
    const [workspace] = await shared!.admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
    await shared!
      .admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
    await shared!.admin`
      insert into workspace_memberships (
        account_id, workspace_id, subject_id, subject_label, role, permissions
      ) values (
        ${account!.id}, ${workspace!.id}, 'subject-a', 'subject-a', 'member',
        ${shared!.admin.json(["connections:read", "connections:write"])}
      )`;
    return { accountId: account!.id, workspaceId: workspace!.id };
  }

  async function bearer(
    workspace: { accountId: string; workspaceId: string },
    permissions: Permission[],
  ): Promise<string> {
    const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      subjectId: "subject-a",
      permissions,
      principalKind: "human_session",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    return `Bearer ${token}`;
  }

  function startFakeAuthorizationServer() {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const origin = `http://127.0.0.1:${server.port}`;
        if (url.pathname === "/.well-known/oauth-protected-resource") {
          return Response.json({
            resource: "urn:test:pinned-mcp",
            authorization_servers: [origin],
            scopes_supported: ["files:read", "files:write"],
          });
        }
        if (
          url.pathname === "/.well-known/oauth-authorization-server" ||
          url.pathname === "/.well-known/openid-configuration"
        ) {
          return Response.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
            client_id_metadata_document_supported: true,
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
  }

  async function insertCatalogProfileRow(
    mcpUrl: string,
    oauthProfile: Record<string, unknown>,
  ): Promise<void> {
    const batch = await createImportBatch(client.db, {
      source: "integrations.sh",
      snapshotDate: new Date("2026-08-17T00:00:00.000Z"),
      attributionNote: "test fixture",
    });
    await upsertRegistryCapabilityCatalogItem(client.db, {
      id: `mcp:integrations-sh:pinned-${batch.id.slice(0, 8)}`,
      providerDomain: new URL(mcpUrl).hostname,
      name: "Pinned Provider",
      mcpUrl,
      transport: "streamable-http",
      authKind: "oauth2",
      credentialFacts: [],
      tier: "verified",
      provenance: "official",
      importBatchId: batch.id,
      metadata: { oauthProfile },
    });
  }

  test("a pinned-client provider is addable as catalog data with no API change", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const as = startFakeAuthorizationServer();
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer pinned-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource", scope="files:read"`,
    });
    try {
      await insertCatalogProfileRow(mcp.url, {
        allowedOwnership: ["personal"],
        pinnedIssuerOrigins: [as.url],
        requestedScopes: ["files:read"],
        extraAuthorizeParams: { audience: "pinned" },
      });

      const headers = {
        authorization: await bearer(workspace, ["connections:write"]),
        "content-type": "application/json",
      };
      const start = (body: Record<string, unknown>) =>
        app().request(`/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`, {
          method: "POST",
          headers,
          body: JSON.stringify({ mcpUrl: mcp.url, returnPath: "/integrations", ...body }),
        });

      // Explicit workspace ownership is rejected by the catalog profile.
      const rejected = await start({ ownership: "workspace" });
      expect(rejected.status).toBe(422);
      expect(await rejected.text()).toContain("allows only personal connections");

      // Omitted ownership defaults to personal; scopes and authorize params
      // come from the profile, not the caller.
      const accepted = await start({ requestedScopes: ["files:write"] });
      expect(accepted.status).toBe(200);
      const body = (await accepted.json()) as { state: string; authorizationUrl: string };
      const authUrl = new URL(body.authorizationUrl);
      expect(authUrl.searchParams.get("scope")).toBe("files:read");
      expect(authUrl.searchParams.get("audience")).toBe("pinned");
      const state = readSignedState(body.state, STATE_SECRET) as Record<string, unknown> | null;
      expect(state?.ownership).toBe("personal");
      expect(state?.requestedScopes).toEqual(["files:read"]);
      expect(state?.authorizeScopes).toEqual(["files:read"]);
    } finally {
      as.close();
      mcp.close();
    }
  });

  test("a catalog profile's origin pins reject an authorization server outside them", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const as = startFakeAuthorizationServer();
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer pinned-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource", scope="files:read"`,
    });
    try {
      await insertCatalogProfileRow(mcp.url, {
        pinnedIssuerOrigins: ["https://auth.pinned.example"],
      });
      const response = await app().request(
        `/v1/workspaces/${workspace.workspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers: {
            authorization: await bearer(workspace, ["connections:write"]),
            "content-type": "application/json",
          },
          body: JSON.stringify({ mcpUrl: mcp.url, returnPath: "/integrations" }),
        },
      );
      expect(response.status).toBe(422);
      expect(await response.text()).toContain(
        "did not remain bound to the reviewed provider origins",
      );
    } finally {
      as.close();
      mcp.close();
    }
  });

  test("getGlobalCatalogOAuthProfile returns only a global row's object profile", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const mcpUrl = "https://profile-lookup.example/mcp";
    await insertCatalogProfileRow(mcpUrl, { allowedOwnership: ["personal"] });
    expect(await getGlobalCatalogOAuthProfile(client.db, workspace.workspaceId, mcpUrl)).toEqual({
      allowedOwnership: ["personal"],
    });
    expect(
      await getGlobalCatalogOAuthProfile(
        client.db,
        workspace.workspaceId,
        "https://no-such-row.example/mcp",
      ),
    ).toBeNull();
  });
});
