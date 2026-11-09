import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION } from "@opengeni/capabilities";
import { OPENGENI_DESKTOP_APP_HEADER, type AccessContext } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  listConnectionsMetadata,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { startTestMcpServer } from "@opengeni/testing/mcp";
import { testSettings } from "@opengeni/testing/settings";
import type { Hono } from "hono";

import { createApp } from "../src/app";
import {
  OAUTH_BROWSER_BINDING_COOKIE,
  OAUTH_BROWSER_BINDING_SECURE_COOKIE,
} from "../src/integrations/oauth-browser-binding";

// CASA 3.2.2: an integration OAuth state is bound to the browser, or the
// signed-in person, that started it. These cases start from a real managed
// browser session, as the console does, and finish the consent either in that
// browser or in someone else's.

const STATE_SECRET = "oauth-browser-binding-state-secret";
const PUBLIC_BASE_URL = "https://app.example.test";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

const authSessionBySessionCookie = new Map<
  string,
  { authSessionId: string; userId: string; email: string }
>();

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: `oauth-browser-binding-${crypto.randomUUID()}`,
  sandboxBackend: "none",
  integrationsEnabled: true,
  integrationsStateSecret: STATE_SECRET,
  environmentsEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
  publicBaseUrl: PUBLIC_BASE_URL,
  integrationsOauthClientsJson: JSON.stringify({
    "https://login.microsoftonline.com/common/v2.0": {
      clientId: "microsoft-binding-client",
      clientSecret: "microsoft-binding-secret",
      tokenEndpointAuthMethod: "client_secret_post",
    },
  }),
});

function microsoftFixture() {
  const tokenRequests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href === MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.tokenUrl) {
      tokenRequests.push(url.href);
      return Response.json({
        access_token: `microsoft-access-${tokenRequests.length}`,
        refresh_token: "microsoft-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.authentication.scopes.join(" "),
      });
    }
    if (url.origin === "https://graph.microsoft.com" && url.pathname === "/v1.0/me") {
      return Response.json({
        id: "microsoft-principal-binding",
        mail: "mailbox.owner@example.com",
        userPrincipalName: "mailbox.owner@example.com",
        displayName: "Mailbox Owner",
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: fetchImpl, tokenRequests };
}

function buildApp(fetchImpl?: typeof globalThis.fetch): Hono {
  const noop = async () => undefined;
  return createApp({
    settings,
    db: client!.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      startSession: noop,
      signalSessionMessage: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    githubStateSecret: "test",
    objectStorage: null,
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
    managedAuth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          // The session cookie is the first one; a browser may hold others.
          const session = (headers.get("cookie") ?? "").split(";")[0]!.trim();
          const record = authSessionBySessionCookie.get(session);
          if (!record) return { headers: new Headers(), response: null };
          return {
            headers: new Headers(),
            response: {
              session: { id: record.authSessionId },
              user: { id: record.userId, email: record.email, name: "Managed human" },
            },
          };
        },
      },
    } as never,
    ...(fetchImpl
      ? { apiIntegrationOAuthFetch: fetchImpl, apiIntegrationSourceFetch: fetchImpl }
      : {}),
  } as unknown as ApiRouteDeps);
}

type ManagedHuman = { subjectId: string; cookie: string; personalWorkspaceId: string };

async function provisionManagedHuman(): Promise<ManagedHuman> {
  if (!client || !shared) throw new Error("test database unavailable");
  const userId = `oauth-binding-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  const authSessionId = `session-${crypto.randomUUID()}`;
  const cookie = `session=${authSessionId}`;
  await shared.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, 'Managed human', ${email}, true)`;
  await shared.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  await ensureManagedAccessForUserWithOrganizationMemberships(client.db, {
    userId,
    email,
    name: "Managed human",
    emailVerified: true,
  });
  const identity = await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  await shared.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${authSessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  authSessionBySessionCookie.set(cookie, { authSessionId, userId, email });
  const subjectId = `user:${userId}`;
  const response = await buildApp().request(`${PUBLIC_BASE_URL}/v1/access/me`, {
    headers: { cookie },
  });
  if (response.status !== 200) throw new Error(`managed provisioning failed: ${response.status}`);
  const access = (await response.json()) as AccessContext;
  const [membership] = await shared.admin<Array<{ personalWorkspaceId: string }>>`
    select personal_workspace_id as "personalWorkspaceId"
    from organization_memberships
    where account_id = ${access.defaultAccountId!} and subject_id = ${subjectId}
      and status = 'active'`;
  if (!membership) throw new Error("managed human has no active organization membership");
  return { subjectId, cookie, personalWorkspaceId: membership.personalWorkspaceId };
}

async function startOneDrive(
  app: Hono,
  human: ManagedHuman,
  extraHeaders: Record<string, string> = {},
  cookie = human.cookie,
) {
  const response = await app.request(
    `${PUBLIC_BASE_URL}/v1/workspaces/${human.personalWorkspaceId}/integrations/oauth/start`,
    {
      method: "POST",
      headers: { cookie, "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify({
        definitionId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
        ownership: "personal",
      }),
    },
  );
  const body = (await response.json()) as { authorizationUrl?: string };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return {
    state: new URL(body.authorizationUrl!).searchParams.get("state")!,
    setCookie: response.headers.get("set-cookie"),
  };
}

function bindingValue(setCookie: string | null): string {
  const match = new RegExp(`${OAUTH_BROWSER_BINDING_SECURE_COOKIE}=([^;]+)`).exec(setCookie ?? "");
  if (!match) throw new Error(`no binding cookie in ${setCookie}`);
  return match[1]!;
}

async function finish(app: Hono, state: string, cookie?: string) {
  const response = await app.request(
    `${PUBLIC_BASE_URL}/v1/integrations/provider-oauth/callback?${new URLSearchParams({
      code: "fixture-code",
      state,
    })}`,
    cookie ? { headers: { cookie } } : {},
  );
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!);
}

async function connectionCount(human: ManagedHuman): Promise<number> {
  return (await listConnectionsMetadata(client!.db, human.personalWorkspaceId, human.subjectId))
    .length;
}

/** A minimal MCP authorization server: metadata plus a token endpoint. */
function startAuthorizationServer() {
  const tokenRequests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/.well-known/oauth-protected-resource")
        return Response.json({
          resource: "urn:test:mcp",
          authorization_servers: [origin],
          scopes_supported: ["documents:read"],
        });
      if (url.pathname === "/.well-known/oauth-authorization-server")
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          client_id_metadata_document_supported: true,
        });
      if (url.pathname === "/token") {
        tokenRequests.push(await request.text());
        return Response.json({
          access_token: "mcp-access-token",
          refresh_token: "mcp-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "documents:read",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    tokenRequests,
    close: () => server.stop(true),
  };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-oauth-browser-binding");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("real database required");
    console.warn("[oauth-browser-binding] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

describe("integration OAuth is bound to the browser that started it", () => {
  test("a consent finished in another browser connects nothing; the starting browser still finishes", async () => {
    if (!shared) return;
    const human = await provisionManagedHuman();
    const provider = microsoftFixture();
    const app = buildApp(provider.fetch);
    const started = await startOneDrive(app, human);
    expect(started.setCookie).toContain(`${OAUTH_BROWSER_BINDING_SECURE_COOKIE}=`);
    expect(started.setCookie).toContain("HttpOnly");
    expect(started.setCookie).toContain("SameSite=Lax");
    // Host-only on https, so a sibling subdomain cannot plant a binding.
    expect(started.setCookie).toContain("Path=/;");
    expect(started.setCookie).toContain("Secure");
    const binding = bindingValue(started.setCookie);

    // The attacker's consent link, opened by someone with no Opengeni cookie.
    const victim = await finish(app, started.state);
    expect(victim.searchParams.get("integration_oauth")).toBe("error");
    expect(victim.searchParams.get("reason")).toBe("browser_mismatch");
    expect(victim.origin).toBe(PUBLIC_BASE_URL);
    // Another browser's own binding cookie is not this one.
    const other = await finish(
      app,
      started.state,
      `${OAUTH_BROWSER_BINDING_SECURE_COOKIE}=${"A".repeat(43)}`,
    );
    expect(other.searchParams.get("reason")).toBe("browser_mismatch");
    // The starter's value under the plain name, which any sibling subdomain
    // could set, is not the host-only binding.
    const tossed = await finish(app, started.state, `${OAUTH_BROWSER_BINDING_COOKIE}=${binding}`);
    expect(tossed.searchParams.get("reason")).toBe("browser_mismatch");
    expect(provider.tokenRequests).toHaveLength(0);
    expect(await connectionCount(human)).toBe(0);

    // The refused attempts consumed nothing: the starter's browser finishes.
    const owner = await finish(
      app,
      started.state,
      `${OAUTH_BROWSER_BINDING_SECURE_COOKIE}=${binding}`,
    );
    expect(owner.searchParams.get("integration_oauth")).toBe("success");
    expect(provider.tokenRequests).toHaveLength(1);
    expect(await connectionCount(human)).toBe(1);
  });

  test("one browser keeps one binding, so connections started side by side all finish", async () => {
    if (!shared) return;
    const human = await provisionManagedHuman();
    const app = buildApp(microsoftFixture().fetch);
    const first = await startOneDrive(app, human);
    const binding = bindingValue(first.setCookie);
    const second = await startOneDrive(
      app,
      human,
      {},
      `${human.cookie}; ${OAUTH_BROWSER_BINDING_SECURE_COOKIE}=${binding}`,
    );
    expect(bindingValue(second.setCookie)).toBe(binding);
    const finished = await finish(
      app,
      first.state,
      `${OAUTH_BROWSER_BINDING_SECURE_COOKIE}=${binding}`,
    );
    expect(finished.searchParams.get("integration_oauth")).toBe("success");
  });

  test("a desktop-app start finishes only where the same person is signed in", async () => {
    if (!shared) return;
    const human = await provisionManagedHuman();
    const someoneElse = await provisionManagedHuman();
    const provider = microsoftFixture();
    const app = buildApp(provider.fetch);
    // The desktop app's consent opens in the person's own browser, which never
    // saw this response; no cookie is set and the person must be signed in there.
    const started = await startOneDrive(app, human, { [OPENGENI_DESKTOP_APP_HEADER]: "macos" });
    expect(started.setCookie ?? "").not.toContain(OAUTH_BROWSER_BINDING_COOKIE);

    expect((await finish(app, started.state)).searchParams.get("reason")).toBe("browser_mismatch");
    expect((await finish(app, started.state, someoneElse.cookie)).searchParams.get("reason")).toBe(
      "browser_mismatch",
    );
    expect(provider.tokenRequests).toHaveLength(0);

    const owner = await finish(app, started.state, human.cookie);
    expect(owner.searchParams.get("integration_oauth")).toBe("success");
    expect(await connectionCount(human)).toBe(1);
  });

  test("MCP OAuth (the Gmail connector's flow) refuses another browser and finishes in the starter's", async () => {
    if (!shared) return;
    const human = await provisionManagedHuman();
    const as = startAuthorizationServer();
    const mcp = startTestMcpServer({
      requiredAuthorization: "Bearer mcp-access-token",
      unauthorizedAuthenticateHeader: `Bearer resource_metadata="${as.url}/.well-known/oauth-protected-resource", scope="documents:read"`,
    });
    try {
      const app = buildApp();
      const response = await app.request(
        `${PUBLIC_BASE_URL}/v1/workspaces/${human.personalWorkspaceId}/connections/oauth/start`,
        {
          method: "POST",
          headers: { cookie: human.cookie, "content-type": "application/json" },
          body: JSON.stringify({
            providerDomain: "mcp.example.com",
            mcpUrl: mcp.url,
            ownership: "personal",
            returnPath: "/integrations",
          }),
        },
      );
      const body = (await response.json()) as { state?: string };
      expect(response.status, JSON.stringify(body)).toBe(200);
      const binding = bindingValue(response.headers.get("set-cookie"));
      const callback = (cookie?: string) =>
        app.request(
          `${PUBLIC_BASE_URL}/v1/integrations/oauth/callback?${new URLSearchParams({
            code: "abc",
            state: body.state!,
          })}`,
          cookie ? { headers: { cookie } } : {},
        );

      const refused = await callback();
      expect(refused.status).toBe(302);
      const refusedLocation = new URL(refused.headers.get("location")!, PUBLIC_BASE_URL);
      expect(refusedLocation.searchParams.get("reason")).toBe("browser_mismatch");
      expect(refusedLocation.searchParams.get("stage")).toBe("state_verify");
      expect(as.tokenRequests).toHaveLength(0);
      expect(await connectionCount(human)).toBe(0);

      const accepted = await callback(`${OAUTH_BROWSER_BINDING_SECURE_COOKIE}=${binding}`);
      const acceptedLocation = new URL(accepted.headers.get("location")!, PUBLIC_BASE_URL);
      expect(acceptedLocation.searchParams.get("integration_oauth")).toBe("success");
      expect(as.tokenRequests).toHaveLength(1);
      expect(await connectionCount(human)).toBe(1);
    } finally {
      mcp.close();
      as.close();
    }
  });
});

describe("connect return URLs stay on this deployment for signed-in people", () => {
  async function begin(human: ManagedHuman, returnUrl: string) {
    return await buildApp(microsoftFixture().fetch).request(
      `${PUBLIC_BASE_URL}/v1/workspaces/${human.personalWorkspaceId}/connect/attempts`,
      {
        method: "POST",
        headers: { cookie: human.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          providerId: MICROSOFT_ONEDRIVE_INTEGRATION_DEFINITION.id,
          ownership: "personal",
          returnUrl,
          idempotencyKey: crypto.randomUUID(),
        }),
      },
    );
  }

  test("an outside returnUrl is refused before any attempt starts", async () => {
    if (!shared) return;
    const human = await provisionManagedHuman();
    for (const returnUrl of [
      "https://evil.example/landing",
      "https://app.example.test.evil.example/landing",
      "http://app.example.test/landing",
      "https://app.example.test@evil.example/landing",
      "https://app.example.test:8443/landing",
    ]) {
      const response = await begin(human, returnUrl);
      expect(response.status, returnUrl).toBe(400);
      expect(await response.text()).toMatch(/own origin|invalid return URL/);
    }
  });

  test("a returnUrl on the deployment's own origin begins the attempt", async () => {
    if (!shared) return;
    const human = await provisionManagedHuman();
    const response = await begin(human, `${PUBLIC_BASE_URL}/workspaces/x/capabilities?tab=1#a`);
    expect(response.status, await response.clone().text()).toBe(200);
  });
});
