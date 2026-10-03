import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { organizationAccessPresetPermissions } from "@opengeni/contracts";
import { createDb, createManagedOrganization, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createApp } from "../src/app";

/* End to end through the real app and PostgreSQL: a person signs in, an agent
   signs in to the organization MCP server, the person chooses its access, and
   the agent runs real actions as that person, capped by that choice. */

const origin = "http://opengeni.test";
const redirectUri = "http://127.0.0.1:4567/callback";
let shared: SharedTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("organization-mcp-e2e");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

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

describe("organization MCP server end to end", () => {
  test("sign in, choose access, act as the person, change access, disconnect", async () => {
    const app = createApp({
      settings: testSettings({
        databaseUrl: shared.adminUrl,
        productAccessMode: "managed",
        betterAuthSecret: "organization-mcp-e2e-secret-32-bytes-long",
        publicBaseUrl: origin,
        mcpOauthEnabled: true,
        claudeSubscriptionEnabled: true,
        integrationsEnabled: true,
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      workflowClient: {} as never,
    });

    // A person signs up and signs in.
    const email = `org-mcp-${crypto.randomUUID()}@example.test`;
    const password = "password1234";
    await app.request("/v1/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Maja Berg", email, password }),
    });
    await shared.admin`update auth_users set email_verified = true where email = ${email}`;
    const signin = await app.request("/v1/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    });
    const cookie = sessionCookie(signin);
    const [authUser] = await shared.admin<
      { id: string }[]
    >`select id from auth_users where email = ${email}`;
    await createManagedOrganization(client.db, {
      subjectId: `user:${authUser!.id}`,
      subjectLabel: email,
      name: "Acme Robotics",
      operationId: crypto.randomUUID(),
    });
    const me = await app.request("/v1/access/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    const access = (await me.json()) as {
      subjectId: string;
      accountGrants: Array<{ accountId: string }>;
      workspaceGrants: Array<{ workspaceId: string }>;
    };
    const organizationId = access.accountGrants[0]!.accountId;
    const personalWorkspaceId = access.workspaceGrants[0]!.workspaceId;

    // The agent registers and starts sign-in for the organization server.
    const registered = await app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude Code",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL("/oauth/authorize", origin);
    for (const [key, value] of Object.entries({
      response_type: "code",
      scope: "mcp:access",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${origin}/v1/mcp`,
      state: "fixture-state",
    }))
      authorize.searchParams.set(key, value);
    // Signed out: sign in on the web app first, which returns to this exact request.
    const signedOut = await app.request(authorize.pathname + authorize.search);
    expect(signedOut.status).toBe(302);
    const signInUrl = new URL(signedOut.headers.get("location")!);
    expect(signInUrl.pathname).toBe("/connect-agent");
    expect(signInUrl.searchParams.get("authorize")).toBe(authorize.pathname + authorize.search);
    const started = await app.request(authorize.pathname + authorize.search, {
      headers: { cookie },
    });
    expect(started.status).toBe(302);
    const consentUrl = new URL(started.headers.get("location")!);
    expect(consentUrl.pathname).toBe("/connect-agent");
    const requestToken = consentUrl.searchParams.get("request")!;

    // The sign-in page reads the request; nobody else can.
    const details = await app.request(`/v1/mcp-connections/requests/${requestToken}`, {
      headers: { cookie },
    });
    expect(details.status).toBe(200);
    const consent = (await details.json()) as {
      client: { name: string; host: string };
      organizations: Array<{ id: string; workspaces: Array<{ id: string; personal: boolean }> }>;
    };
    expect(consent.client).toEqual({ name: "Claude Code", host: "127.0.0.1:4567" });
    expect(consent.organizations[0]!.id).toBe(organizationId);
    expect(consent.organizations[0]!.workspaces.some((each) => each.personal)).toBe(true);
    expect(
      (
        await app.request(`/v1/mcp-connections/requests/${requestToken}`, {
          method: "POST",
          headers: { ...browser(cookie), origin: "https://evil.example" },
          body: JSON.stringify({ decision: "deny" }),
        })
      ).status,
    ).toBe(403);

    // The person allows Read only in every workspace.
    const approved = await app.request(`/v1/mcp-connections/requests/${requestToken}`, {
      method: "POST",
      headers: browser(cookie),
      body: JSON.stringify({
        decision: "approve",
        organizationId,
        access: {
          preset: "read_only",
          permissions: ["account:read", "workspace:read", "sessions:read", "files:read"],
          workspaceScope: { kind: "all" },
        },
      }),
    });
    expect(approved.status).toBe(200);
    const redirect = new URL(((await approved.json()) as { redirectTo: string }).redirectTo);
    expect(redirect.searchParams.get("state")).toBe("fixture-state");
    const code = redirect.searchParams.get("code")!;

    const tokenResponse = await app.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: `${origin}/v1/mcp`,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const { access_token: token } = (await tokenResponse.json()) as { access_token: string };

    let id = 0;
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const response = await app.request("/v1/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result: { isError?: boolean; content: Array<{ text: string }> };
      };
      const text = body.result.content[0]!.text;
      return { isError: body.result.isError === true, text, value: safeJson(text) };
    };

    // The agent acts as the person: same subject, same Personal workspace.
    const whoami = await mcp("opengeni_action_call", { id: "getAccessContext" });
    expect(whoami.isError).toBe(false);
    expect(whoami.value).toMatchObject({ status: 200, body: { subjectId: access.subjectId } });
    const sessions = await mcp("opengeni_action_call", {
      id: "listSessionPage",
      pathParameters: { workspaceId: personalWorkspaceId },
    });
    expect(sessions.value).toMatchObject({ status: 200 });

    // Read only: nothing can change.
    const create = await mcp("opengeni_action_call", {
      id: "createSession",
      pathParameters: { workspaceId: personalWorkspaceId },
      body: { initialMessage: "hello" },
    });
    expect(create.isError).toBe(true);
    expect(create.text).toContain("read only");

    // The connection is listed for the person; the agent itself can't manage it.
    const listed = await app.request(`/v1/organizations/${organizationId}/mcp-connections`, {
      headers: { cookie },
    });
    const { connections } = (await listed.json()) as {
      connections: Array<{ id: string; clientName: string; connectedBy: { name: string } }>;
    };
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      clientName: "Claude Code",
      connectedBy: { name: "Maja Berg" },
    });
    const viaAgent = await mcp("opengeni_action_call", {
      id: "GET /v1/organizations/:organizationId/mcp-connections",
      pathParameters: { organizationId },
    });
    expect(viaAgent.isError || viaAgent.text.includes('"status":403')).toBe(true);

    // Full access: the agent can do what the person can, workspace and organization work alike.
    const widened = await app.request(
      `/v1/organizations/${organizationId}/mcp-connections/${connections[0]!.id}`,
      {
        method: "PATCH",
        headers: browser(cookie),
        body: JSON.stringify({
          access: {
            preset: "full",
            permissions: organizationAccessPresetPermissions("full"),
            workspaceScope: { kind: "all" },
          },
        }),
      },
    );
    expect(widened.status).toBe(200);
    // Personal workspace settings need a verified owner and a workspace:admin ceiling.
    const settings = await mcp("opengeni_action_call", {
      id: "updateWorkspaceSettings",
      pathParameters: { workspaceId: personalWorkspaceId },
      body: { agentHumanInputEnabled: true },
    });
    expect(settings.value).toMatchObject({ status: 200 });

    // Organization work too, as the person, without a browser: create a
    // workspace, read the organization and its members.
    const createdWorkspace = await mcp("opengeni_action_call", {
      id: "POST /v1/organizations/:organizationId/workspaces",
      pathParameters: { organizationId },
      body: { name: "Agent workspace", operationId: crypto.randomUUID() },
    });
    expect(createdWorkspace.isError).toBe(false);
    expect((createdWorkspace.value as { status: number }).status).toBeLessThan(300);
    const overview = await mcp("opengeni_action_call", {
      id: "GET /v1/organizations/:organizationId/overview",
      pathParameters: { organizationId },
    });
    expect(overview.value).toMatchObject({ status: 200 });
    expect(overview.text).toContain("Agent workspace");
    const members = await mcp("opengeni_action_call", {
      id: "GET /v1/organizations/:organizationId/members",
      pathParameters: { organizationId },
    });
    expect(members.value).toMatchObject({ status: 200 });
    expect(members.text).toContain(email);
    // Another organization reads as not found.
    const elsewhere = await mcp("opengeni_action_call", {
      id: "GET /v1/organizations/:organizationId/overview",
      pathParameters: { organizationId: crypto.randomUUID() },
    });
    expect(elsewhere.value).toMatchObject({ status: 404 });
    // Provider sign-in stays with the person in the browser.
    const providerSignIn = await mcp("opengeni_action_call", {
      id: "POST /v1/organizations/:organizationId/model-providers/claude_subscription/oauth/start",
      pathParameters: { organizationId },
      body: {},
    });
    expect(providerSignIn.value).toMatchObject({ status: 403 });
    expect(providerSignIn.text).toContain("in a browser");
    const integrationSignIn = await mcp("opengeni_action_call", {
      id: "POST /v1/workspaces/:workspaceId/connections/oauth/start",
      pathParameters: { workspaceId: personalWorkspaceId },
      body: {},
    });
    expect(integrationSignIn.value).toMatchObject({ status: 403 });
    expect(integrationSignIn.text).toContain("in a browser");

    // Narrowing to selected workspaces takes effect on the next call.
    const narrowed = await app.request(
      `/v1/organizations/${organizationId}/mcp-connections/${connections[0]!.id}`,
      {
        method: "PATCH",
        headers: browser(cookie),
        body: JSON.stringify({
          access: {
            preset: "custom",
            permissions: ["account:read", "workspace:read", "sessions:create"],
            workspaceScope: { kind: "selected", workspaceIds: [] },
          },
        }),
      },
    );
    expect(narrowed.status).toBe(200);
    const outside = await mcp("opengeni_action_call", {
      id: "listSessionPage",
      pathParameters: { workspaceId: personalWorkspaceId },
    });
    expect(outside.isError).toBe(true);
    // Custom without account:admin: reading the organization works, changing it doesn't.
    expect(
      (
        await mcp("opengeni_action_call", {
          id: "GET /v1/organizations/:organizationId/overview",
          pathParameters: { organizationId },
        })
      ).value,
    ).toMatchObject({ status: 200 });
    const notAdmin = await mcp("opengeni_action_call", {
      id: "POST /v1/organizations/:organizationId/workspaces",
      pathParameters: { organizationId },
      body: { name: "Not allowed", operationId: crypto.randomUUID() },
    });
    expect(notAdmin.value).toMatchObject({ status: 403 });
    expect(notAdmin.text).toContain("account:admin");

    // Disconnect: the token is refused right away.
    const disconnected = await app.request(
      `/v1/organizations/${organizationId}/mcp-connections/${connections[0]!.id}`,
      { method: "DELETE", headers: browser(cookie) },
    );
    expect(disconnected.status).toBe(204);
    const refused = await app.request("/v1/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
    });
    expect(refused.status).toBe(401);
  }, 120_000);
});

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
