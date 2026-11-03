import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { organizationAccessPresetPermissions, signDelegatedAccessToken } from "@opengeni/contracts";
import {
  createDb,
  createManagedOrganization,
  refreshIdJagConnectionCredential,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { createApp } from "../src/app";
import { resetMcpAutoConnectCaches } from "../src/mcp-auto-connect";

/* Auto-connect end to end through the real app and PostgreSQL.

   Inbound: Claude (a fake issuer here) signs an ID-JAG for a member and its
   client redeems it at /oauth/token for an organization MCP token, with no
   sign-in screen. Every refusal Claude's guide lists is checked.

   Outbound: Opengeni signs ID-JAGs for the organization's members, and an
   outside app (a fake here) that trusts the organization's issuer redeems
   them. */

const origin = "http://opengeni.test";
const claudeIssuer = "https://identity.anthropic.test/issuers/acme-claude";
const claudeClientId = "https://claude.test/oauth/mcp-client-metadata.json";
/** A client whose document says it authenticates with a key Opengeni never checks. */
const confidentialClientId = "https://confidential.test/oauth/client-metadata.json";
/** What that client's document says; it may change after it was registered. */
let confidentialAuthMethod = "private_key_jwt";
const encryptionKey = randomBytes(32).toString("base64");
const delegationSecret = "mcp-auto-connect-delegation-secret";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
let shared: SharedTestDatabase;
let client: DbClient;
let issuerKey: { privateKey: CryptoKey; publicJwk: JWK };
let otherKey: { privateKey: CryptoKey };

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("mcp-auto-connect");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
  const pair = await generateKeyPair("ES256");
  issuerKey = {
    privateKey: pair.privateKey,
    publicJwk: { ...(await exportJWK(pair.publicKey)), kid: "claude-key-1", alg: "ES256" },
  };
  otherKey = { privateKey: (await generateKeyPair("ES256")).privateKey };
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

beforeEach(() => resetMcpAutoConnectCaches());

type App = ReturnType<typeof createApp>;
let outsideApp: ((request: Request) => Promise<Response>) | null = null;

/** Claude's issuer and client, and (when set) an outside MCP app. */
const fakeInternet: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(request.url);
  if (request.url === `${claudeIssuer}/.well-known/openid-configuration`)
    return Response.json({ issuer: claudeIssuer, jwks_uri: `${claudeIssuer}/jwks` });
  if (request.url === `${claudeIssuer}/jwks`) return Response.json({ keys: [issuerKey.publicJwk] });
  if (request.url === claudeClientId)
    return Response.json({
      client_id: claudeClientId,
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      grant_types: ["authorization_code", JWT_BEARER],
      token_endpoint_auth_method: "none",
    });
  if (request.url === confidentialClientId)
    return Response.json({
      client_id: confidentialClientId,
      client_name: "Confidential",
      redirect_uris: ["https://confidential.test/callback"],
      grant_types: [JWT_BEARER],
      token_endpoint_auth_method: confidentialAuthMethod,
    });
  if (outsideApp && url.hostname.endsWith("app.test")) return await outsideApp(request);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

function appSettings() {
  return testSettings({
    databaseUrl: shared.adminUrl,
    productAccessMode: "managed",
    betterAuthSecret: "mcp-auto-connect-test-secret-32-bytes-long",
    publicBaseUrl: origin,
    mcpOauthEnabled: true,
    integrationsEnabled: true,
    environmentsEncryptionKey: encryptionKey,
    delegationSecret,
  });
}

function makeApp(): App {
  return createApp({
    settings: appSettings(),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
    mcpAutoConnectFetch: fakeInternet,
  } as never);
}

function sessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.includes("better-auth.session_token="));
  if (!cookie) throw new Error("Better Auth response did not set a session cookie");
  return cookie.split(";", 1)[0]!;
}

function browser(cookie: string): Record<string, string> {
  return { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json" };
}

async function person(app: App, name: string, verified = true) {
  const email = `auto-${crypto.randomUUID()}@example.test`;
  const password = "password1234";
  await app.request("/v1/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });
  await shared.admin`update auth_users set email_verified = ${verified} where email = ${email}`;
  const signin = await app.request("/v1/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });
  const [row] = await shared.admin<
    { id: string }[]
  >`select id from auth_users where email = ${email}`;
  return { email, cookie: sessionCookie(signin), subjectId: `user:${row!.id}` };
}

async function organizationFor(
  app: App,
  owner: { email: string; subjectId: string; cookie: string },
) {
  await createManagedOrganization(client.db, {
    subjectId: owner.subjectId,
    subjectLabel: owner.email,
    name: "Acme Robotics",
    operationId: crypto.randomUUID(),
  });
  const me = await app.request("/v1/access/me", { headers: { cookie: owner.cookie } });
  const access = (await me.json()) as {
    accountGrants: Array<{ accountId: string }>;
    workspaceGrants: Array<{ workspaceId: string }>;
  };
  return {
    organizationId: access.accountGrants[0]!.accountId,
    workspaceId: access.workspaceGrants[0]!.workspaceId,
  };
}

const readOnly = {
  preset: "read_only",
  permissions: organizationAccessPresetPermissions("read_only"),
  workspaceScope: { kind: "all" },
};

async function idJag(
  claims: Record<string, unknown>,
  options: { typ?: string; key?: CryptoKey; kid?: string; lifetime?: number } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const { aud, ...rest } = claims;
  return await new SignJWT({
    client_id: claudeClientId,
    scope: "mcp:access",
    jti: crypto.randomUUID(),
    ...rest,
  })
    .setProtectedHeader({
      alg: "ES256",
      typ: options.typ ?? "oauth-id-jag+jwt",
      kid: options.kid ?? "claude-key-1",
    })
    .setIssuer(claudeIssuer)
    .setAudience((aud as string | undefined) ?? [origin])
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + (options.lifetime ?? 60))
    .sign(options.key ?? issuerKey.privateKey);
}

async function redeem(app: App, assertion: string, extra: Record<string, string> = {}) {
  const response = await app.request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: JWT_BEARER,
      assertion,
      client_id: claudeClientId,
      scope: "mcp:access",
      resource: `${origin}/v1/mcp`,
      ...extra,
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function whoami(app: App, token: string) {
  const response = await app.request("/v1/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "opengeni_action_call", arguments: { id: "getAccessContext" } },
    }),
  });
  return response;
}

describe("auto-connect, inbound: Claude connects members to the organization MCP server", () => {
  test("an admin trusts Claude's issuer; members connect with no sign-in, refusals say why", async () => {
    const app = makeApp();
    const owner = await person(app, "Maja Berg");
    const { organizationId } = await organizationFor(app, owner);
    const base = `/v1/organizations/${organizationId}/mcp-trusted-issuers`;

    // The authorization server advertises the grant and CIMD clients.
    const metadata = (await (
      await app.request("/.well-known/oauth-authorization-server/v1/mcp")
    ).json()) as Record<string, unknown>;
    expect(metadata.grant_types_supported).toContain(JWT_BEARER);
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.authorization_grant_profiles_supported).toEqual([
      "urn:ietf:params:oauth:grant-profile:id-jag",
    ]);

    // Before any trust, an ID-JAG from Claude is refused.
    const early = await redeem(app, await idJag({ sub: "claude-user-1", email: owner.email }));
    expect(early.status).toBe(400);
    expect(early.body.error).toBe("invalid_grant");

    const empty = await app.request(base, { headers: { cookie: owner.cookie } });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      trustedIssuers: [],
      mcpUrl: `${origin}/v1/mcp`,
      audience: origin,
    });

    // Check the issuer, then trust it with Read only access.
    const checked = await app.request(`${base}/check`, {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify({ issuer: claudeIssuer }),
    });
    expect(await checked.json()).toMatchObject({
      status: "ok",
      keyCount: 1,
      algorithms: ["ES256"],
      jwksUri: `${claudeIssuer}/jwks`,
    });
    const badCheck = await app.request(`${base}/check`, {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify({ issuer: "https://identity.anthropic.test/issuers/missing" }),
    });
    expect(await badCheck.json()).toMatchObject({ status: "failed" });
    const created = await app.request(base, {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify({
        name: "Claude",
        provider: "claude",
        issuer: claudeIssuer,
        access: readOnly,
      }),
    });
    expect(created.status).toBe(201);
    const trust = (await created.json()) as { id: string; connectedPeople: number };
    expect(trust.connectedPeople).toBe(0);
    const duplicate = await app.request(base, {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify({
        name: "Claude",
        provider: "claude",
        issuer: claudeIssuer,
        access: readOnly,
      }),
    });
    expect(duplicate.status).toBe(409);

    // A member's first use: connected, with no refresh token.
    const first = await redeem(
      app,
      await idJag({
        sub: "claude-user-1",
        email: owner.email.toUpperCase(),
        aud_tenant: organizationId,
      }),
    );
    expect(first).toMatchObject({ status: 200 });
    expect(first.body).toMatchObject({
      token_type: "Bearer",
      expires_in: 900,
      scope: "mcp:access",
    });
    expect(first.body.refresh_token).toBeUndefined();
    const token = first.body.access_token as string;
    const acting = await whoami(app, token);
    expect(acting.status).toBe(200);
    expect(await acting.text()).toContain(owner.subjectId);

    // A later ID-JAG for the same person and app is the same connection.
    const assertion = await idJag({ sub: "claude-user-1", email: owner.email });
    expect((await redeem(app, assertion)).status).toBe(200);
    // ...and each ID-JAG is redeemed once.
    const replay = await redeem(app, assertion);
    expect(replay).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

    const listed = (await (
      await app.request(`/v1/organizations/${organizationId}/mcp-connections`, {
        headers: { cookie: owner.cookie },
      })
    ).json()) as {
      connections: Array<{ id: string; clientName: string; autoConnect: unknown; policy: unknown }>;
    };
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0]).toMatchObject({
      clientName: "Claude",
      autoConnect: { trustedIssuerId: trust.id, issuerName: "Claude" },
      policy: { preset: "read_only" },
    });
    // Its access is the issuer's: the person can't change it there.
    const patched = await app.request(
      `/v1/organizations/${organizationId}/mcp-connections/${listed.connections[0]!.id}`,
      {
        method: "PATCH",
        headers: browser(owner.cookie),
        body: JSON.stringify({ access: { ...readOnly, preset: "full" } }),
      },
    );
    expect(patched.status).toBe(409);

    // Every refusal Claude's guide lists.
    const refusals: Array<[string, Promise<string>, Record<string, string>?]> = [
      ["wrong typ", idJag({ sub: "claude-user-1", email: owner.email }, { typ: "JWT" })],
      [
        "bad signature",
        idJag({ sub: "claude-user-1", email: owner.email }, { key: otherKey.privateKey }),
      ],
      [
        "wrong audience",
        idJag({ sub: "claude-user-1", email: owner.email, aud: "https://other.test" }),
      ],
      [
        "client mismatch",
        idJag({
          sub: "claude-user-1",
          email: owner.email,
          client_id: "https://evil.test/client.json",
        }),
      ],
      ["expired", idJag({ sub: "claude-user-1", email: owner.email }, { lifetime: -120 })],
      ["too long", idJag({ sub: "claude-user-1", email: owner.email }, { lifetime: 7200 })],
      ["no subject", idJag({ email: owner.email })],
      ["unknown person", idJag({ sub: "claude-user-2", email: "nobody@example.test" })],
      ["unverified", idJag({ sub: "claude-user-3", email: owner.email, email_verified: false })],
      // A subject connected before is matched by its email every time, never by itself.
      ["known subject, other email", idJag({ sub: "claude-user-1", email: "nobody@example.test" })],
      [
        "known subject, unverified",
        idJag({ sub: "claude-user-1", email: owner.email, email_verified: false }),
      ],
      ["known subject, no email", idJag({ sub: "claude-user-1" })],
      [
        "other tenant",
        idJag({ sub: "claude-user-1", email: owner.email, aud_tenant: crypto.randomUUID() }),
      ],
      [
        "wrong resource",
        idJag({ sub: "claude-user-1", email: owner.email }),
        { resource: `${origin}/v1/workspaces/${crypto.randomUUID()}/mcp` },
      ],
    ];
    for (const [label, pending, extra] of refusals) {
      const result = await redeem(app, await pending, extra);
      expect({ label, status: result.status }).toEqual({ label, status: 400 });
      expect(typeof result.body.error_description).toBe("string");
    }
    // A client that says it authenticates is refused, not let in without it.
    const confidential = await redeem(
      app,
      await idJag({ sub: "claude-user-1", email: owner.email, client_id: confidentialClientId }),
      { client_id: confidentialClientId },
    );
    expect(confidential).toMatchObject({ status: 401, body: { error: "invalid_client" } });

    // The admin sees who connected and why the others were refused.
    const [summary] = (
      (await (await app.request(base, { headers: { cookie: owner.cookie } })).json()) as {
        trustedIssuers: Array<{ connectedPeople: number; lastConnectedAt: string | null }>;
      }
    ).trustedIssuers;
    expect(summary).toMatchObject({ connectedPeople: 1 });
    expect(summary!.lastConnectedAt).not.toBeNull();
    const events = (
      (await (
        await app.request(`${base}/${trust.id}/events`, { headers: { cookie: owner.cookie } })
      ).json()) as { events: Array<{ outcome: string; reason: string | null; person: unknown }> }
    ).events;
    expect(events.filter((event) => event.outcome === "connected")).toHaveLength(1);
    const reasons = new Set(events.map((event) => event.reason));
    for (const reason of [
      "replayed",
      "wrong_type",
      "signature_invalid",
      "wrong_audience",
      "client_mismatch",
      "expired",
      "malformed",
      "no_matching_member",
      "email_unverified",
      "wrong_resource",
    ])
      expect({ reason, seen: reasons.has(reason) }).toEqual({ reason, seen: true });

    // A client registered as public whose document now says it authenticates
    // is refused from then on, not served from its saved registration.
    const asConfidential = async () =>
      await redeem(
        app,
        await idJag({ sub: "claude-user-1", email: owner.email, client_id: confidentialClientId }),
        { client_id: confidentialClientId },
      );
    confidentialAuthMethod = "none";
    resetMcpAutoConnectCaches();
    expect((await asConfidential()).status).toBe(200);
    confidentialAuthMethod = "private_key_jwt";
    resetMcpAutoConnectCaches(); // a day later
    expect(await asConfidential()).toMatchObject({
      status: 401,
      body: { error: "invalid_client" },
    });
    expect(await asConfidential()).toMatchObject({
      status: 401,
      body: { error: "invalid_client" },
    });
    resetMcpAutoConnectCaches(); // another API instance
    expect(await asConfidential()).toMatchObject({
      status: 401,
      body: { error: "invalid_client" },
    });

    // An identity provider may leave the email out: its subject is then found
    // through the member an earlier email match linked it to. Claude can't.
    const noEmail = async (sub: string) => (await redeem(app, await idJag({ sub }))).status;
    expect(await noEmail("claude-user-1")).toBe(400);
    await shared.admin`update organization_mcp_trusted_issuers set provider = 'okta'
      where id = ${trust.id}::uuid`;
    expect(await noEmail("claude-user-1")).toBe(200);
    expect(await noEmail("idp-user-never-seen")).toBe(400);
    // An email it does send is still checked, never the link in its place.
    expect(
      (await redeem(app, await idJag({ sub: "claude-user-1", email: "nobody@example.test" })))
        .status,
    ).toBe(400);
    await shared.admin`update organization_mcp_trusted_issuers set provider = 'claude'
      where id = ${trust.id}::uuid`;

    // Turning the issuer off disconnects everyone it connected.
    const disabled = await app.request(`${base}/${trust.id}`, {
      method: "PATCH",
      headers: browser(owner.cookie),
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(disabled.status).toBe(200);
    expect((await whoami(app, token)).status).toBe(401);
    expect(
      (await redeem(app, await idJag({ sub: "claude-user-1", email: owner.email }))).status,
    ).toBe(400);

    // Removing it removes it.
    const removed = await app.request(`${base}/${trust.id}`, {
      method: "DELETE",
      headers: browser(owner.cookie),
    });
    expect(removed.status).toBe(204);
  }, 120_000);

  test("only organization owners and admins manage trusted issuers", async () => {
    const app = makeApp();
    const owner = await person(app, "Owner");
    await organizationFor(app, owner);
    const outsider = await person(app, "Outsider");
    const { organizationId } = await organizationFor(app, outsider);
    const response = await app.request(`/v1/organizations/${organizationId}/mcp-trusted-issuers`, {
      method: "POST",
      headers: browser(owner.cookie),
      body: JSON.stringify({
        name: "Claude",
        provider: "claude",
        issuer: claudeIssuer,
        access: readOnly,
      }),
    });
    expect(response.status).toBe(403);
  }, 60_000);
});

describe("auto-connect, outbound: Opengeni connects members to an outside MCP app", () => {
  test("an admin turns it on; the app trusts the organization's issuer; members connect", async () => {
    const app = makeApp();
    const owner = await person(app, "Maja Berg");
    const { organizationId, workspaceId } = await organizationFor(app, owner);
    const issuerUrl = `${origin}/v1/organizations/${organizationId}/identity`;
    let trusted = true;
    const redeemed: Array<Record<string, unknown>> = [];
    outsideApp = async (request) => {
      const url = new URL(request.url);
      if (url.href === "https://mcp.app.test/mcp")
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="https://mcp.app.test/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      if (url.href === "https://mcp.app.test/.well-known/oauth-protected-resource/mcp")
        return Response.json({
          resource: "https://mcp.app.test/mcp",
          authorization_servers: ["https://auth.app.test"],
          scopes_supported: ["read"],
        });
      if (url.href === "https://auth.app.test/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: "https://auth.app.test",
          authorization_endpoint: "https://auth.app.test/authorize",
          token_endpoint: "https://auth.app.test/token",
          grant_types_supported: ["authorization_code", JWT_BEARER],
          client_id_metadata_document_supported: true,
        });
      if (url.href === "https://auth.app.test/token") {
        const form = new URLSearchParams(await request.text());
        if (!trusted) return Response.json({ error: "invalid_grant" }, { status: 400 });
        // The app checks the ID-JAG against the organization's published keys.
        const discovery = (await (
          await app.request(`${new URL(issuerUrl).pathname}/.well-known/openid-configuration`)
        ).json()) as { issuer: string; jwks_uri: string };
        expect(discovery.issuer).toBe(issuerUrl);
        const keys = await (await app.request(new URL(discovery.jwks_uri).pathname)).json();
        const { payload, protectedHeader } = await jwtVerify(
          form.get("assertion")!,
          createLocalJWKSet(keys as never),
          { issuer: issuerUrl, audience: "https://auth.app.test", typ: "oauth-id-jag+jwt" },
        );
        expect(protectedHeader.alg).toBe("RS256");
        expect(form.get("grant_type")).toBe(JWT_BEARER);
        expect(payload.client_id).toBe(form.get("client_id"));
        redeemed.push(payload);
        return Response.json({
          access_token: `app-token-${redeemed.length}`,
          token_type: "Bearer",
          expires_in: 600,
        });
      }
      return new Response("not found", { status: 404 });
    };
    try {
      // Before anything is turned on there is no issuer.
      expect(
        (await app.request(`/v1/organizations/${organizationId}/identity/jwks.json`)).status,
      ).toBe(404);
      const check = await app.request(
        `/v1/organizations/${organizationId}/connectors/auto-connect/check`,
        {
          method: "POST",
          headers: browser(owner.cookie),
          body: JSON.stringify({ endpointUrl: "https://mcp.app.test/mcp" }),
        },
      );
      expect(await check.json()).toMatchObject({
        supported: true,
        authorizationServer: "https://auth.app.test",
        clientIdMetadataDocumentSupported: true,
        opengeniClientId: `${origin}/v1/integrations/oauth/client-metadata.json`,
      });
      const created = await app.request(`/v1/organizations/${organizationId}/connectors`, {
        method: "POST",
        headers: browser(owner.cookie),
        body: JSON.stringify({
          custom: { name: "App", endpointUrl: "https://mcp.app.test/mcp" },
          login: "auto_connect",
          availability: { allowedWorkspaceIds: [], allowPersonalWorkspaces: true },
        }),
      });
      expect(created.status).toBe(201);
      const connector = (await created.json()) as {
        id: string;
        login: string;
        autoConnect: { issuer: string; clientId: string; authorizationServer: string };
      };
      expect(connector.login).toBe("auto_connect");
      expect(connector.autoConnect).toMatchObject({
        issuer: issuerUrl,
        authorizationServer: "https://auth.app.test",
        clientId: `${origin}/v1/integrations/oauth/client-metadata.json`,
      });
      // The issuer is public now, at every discovery path apps use.
      for (const path of [
        `/v1/organizations/${organizationId}/identity/.well-known/openid-configuration`,
        `/v1/organizations/${organizationId}/identity/.well-known/oauth-authorization-server`,
        `/.well-known/oauth-authorization-server/v1/organizations/${organizationId}/identity`,
      ]) {
        const response = await app.request(path);
        expect({ path, status: response.status }).toEqual({ path, status: 200 });
        expect(((await response.json()) as { issuer: string }).issuer).toBe(issuerUrl);
      }

      // The admin's test, refused while the app doesn't trust the issuer yet...
      trusted = false;
      const refused = await app.request(
        `/v1/organizations/${organizationId}/connectors/${connector.id}/auto-connect/test`,
        { method: "POST", headers: browser(owner.cookie) },
      );
      expect(await refused.json()).toMatchObject({
        status: "refused",
        autoConnect: { lastError: { message: expect.any(String) } },
      });
      // ...then connected once it does.
      trusted = true;
      const tested = await app.request(
        `/v1/organizations/${organizationId}/connectors/${connector.id}/auto-connect/test`,
        { method: "POST", headers: browser(owner.cookie) },
      );
      const testedBody = (await tested.json()) as { generation: number };
      expect(testedBody).toMatchObject({
        status: "connected",
        autoConnect: { verifiedAt: expect.any(String), lastError: null },
      });
      // The returned generation is current: a change right after the test saves.
      const afterTest = await app.request(
        `/v1/organizations/${organizationId}/connectors/${connector.id}`,
        {
          method: "PATCH",
          headers: browser(owner.cookie),
          body: JSON.stringify({ expectedGeneration: testedBody.generation, status: "active" }),
        },
      );
      expect(afterTest.status).toBe(200);
      expect(redeemed.at(-1)).toMatchObject({
        sub: owner.subjectId,
        email: owner.email,
        resource: "https://mcp.app.test/mcp",
      });

      // A member's Connect: their own login, saved and turned on here.
      const connect = await app.request(
        `/v1/workspaces/${workspaceId}/organization-connectors/${connector.id}/connect`,
        { method: "POST", headers: browser(owner.cookie) },
      );
      expect(await connect.json()).toEqual({ status: "connected" });
      const [saved] = await shared.admin<{ status: string; kind: string; subject_id: string }[]>`
        select status, kind, subject_id from connections
        where workspace_id = ${workspaceId}::uuid and provider_domain = 'mcp.app.test'`;
      expect(saved).toMatchObject({
        status: "active",
        kind: "oauth2",
        subject_id: owner.subjectId,
      });
      // Connecting again keeps the one login.
      const again = await app.request(
        `/v1/workspaces/${workspaceId}/organization-connectors/${connector.id}/connect`,
        { method: "POST", headers: browser(owner.cookie) },
      );
      expect(await again.json()).toEqual({ status: "connected" });
      const count = await shared.admin<{ n: number }[]>`
        select count(*)::int as n from connections
        where workspace_id = ${workspaceId}::uuid and provider_domain = 'mcp.app.test'`;
      expect(count[0]!.n).toBe(1);

      // Only the person makes their own login: not a service acting in their name.
      const serviceToken = await signDelegatedAccessToken(delegationSecret, {
        accountId: organizationId,
        workspaceId,
        subjectId: owner.subjectId,
        permissions: ["connections:read", "connections:write"],
        principalKind: "service",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const byService = await app.request(
        `/v1/workspaces/${workspaceId}/organization-connectors/${connector.id}/connect`,
        { method: "POST", headers: { authorization: `Bearer ${serviceToken}` } },
      );
      expect(byService.status).toBe(422);

      // Renewal signs a new ID-JAG while the connector is there...
      const binding = {
        grant: "id_jag",
        connector_id: connector.id,
        token_endpoint: "https://auth.app.test/token",
        client_id: connector.autoConnect.clientId,
        audience: "https://auth.app.test",
        resource: "https://mcp.app.test/mcp",
      };
      const renewal = () =>
        refreshIdJagConnectionCredential(
          client.db,
          appSettings(),
          {
            accountId: organizationId,
            workspaceId,
            subjectId: owner.subjectId,
            credential: binding,
          },
          { resource: "https://mcp.app.test/mcp", scopes: [] },
          { testFetch: fakeInternet },
        );
      const renewed = await renewal();
      expect(renewed.credential).toMatchObject({ grant: "id_jag", connector_id: connector.id });
      // ...and never once it is removed.
      const removed = await app.request(
        `/v1/organizations/${organizationId}/connectors/${connector.id}`,
        { method: "DELETE", headers: browser(owner.cookie) },
      );
      expect(removed.status).toBe(204);
      const redeemedBefore = redeemed.length;
      await expect(renewal()).rejects.toMatchObject({ httpStatus: 401 });
      expect(redeemed.length).toBe(redeemedBefore);
    } finally {
      outsideApp = null;
    }
  }, 120_000);
});
