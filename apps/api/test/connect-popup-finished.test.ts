import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  bootstrapWorkspace,
  createDb,
  createOrganizationApiKey,
  deleteWorkspace,
  ensureExternalIdentity,
  type DbClient,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import * as network from "@opengeni/network";
import { createApp } from "../src/app";
import {
  OFFICIAL_GMAIL_MCP_SCOPES,
  OFFICIAL_GMAIL_MCP_URL,
} from "../src/integrations/oauth-profiles";

let fixture: SharedTestDatabase | null = null;
let client: DbClient;
const workspaces: string[] = [];
beforeAll(async () => {
  fixture = await acquireSharedTestDatabase("connect-popup-finished");
  if (!fixture) throw new Error("PostgreSQL fixture required");
  client = createDb(fixture.appUrl);
}, 180_000);
afterAll(async () => {
  for (const workspaceId of workspaces) await deleteWorkspace(client.db, workspaceId);
  await client?.close();
  await fixture?.release();
});

test("a sign-in popup ends on the closing page, never on a copy of the host page", async () => {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: randomUUID(),
    accountName: "Popup finish",
    workspaceExternalSource: "test",
    workspaceExternalId: randomUUID(),
    workspaceName: "Fixture",
    subjectId: `user:${randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  workspaces.push(grant.workspaceId);
  const identity = await ensureExternalIdentity(client.db, {
    accountId: grant.accountId,
    externalId: "popup-user",
  });
  const key = randomBytes(24).toString("hex");
  await createOrganizationApiKey(client.db, {
    accountId: grant.accountId,
    name: "Fixture",
    prefix: "test",
    keyHash: createHash("sha256").update(key).digest("hex"),
    permissions: ["workspace:read", "connections:read", "connections:write"],
  });
  const app = createApp({
    db: client.db,
    bus: {} as never,
    workflowClient: {} as never,
    managedAuth: null,
    settings: testSettings({
      productAccessMode: "managed",
      integrationsEnabled: true,
      publicBaseUrl: "https://runtime.example.test",
      environmentsEncryptionKey: randomBytes(32).toString("base64"),
      integrationsStateSecret: "popup-finished-synthetic-state",
      integrationsOauthClientsJson: JSON.stringify({
        "https://accounts.google.com": {
          clientId: "fixture-client",
          clientSecret: "fixture-secret",
          tokenEndpointAuthMethod: "client_secret_post",
        },
      }),
    }),
  });
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "x-opengeni-external-actor": encodeURIComponent(
      JSON.stringify({ mode: "external", identity: { externalId: identity.externalId } }),
    ),
  };
  const base = `/v1/workspaces/${identity.personalWorkspaceId}/connect/attempts`;
  const hostPage = "https://host.example/chat?thread=1";
  const realPinnedFetch = network.pinnedFetch;
  const transport = spyOn(network, "pinnedFetch").mockImplementation(
    async (input, init, settings, options) => {
      if (options?.fetchImpl) return realPinnedFetch(input, init, settings, options);
      const url = String(input);
      if (url === "https://accounts.google.com/.well-known/openid-configuration")
        return Response.json({
          issuer: "https://accounts.google.com",
          authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          token_endpoint: "https://oauth2.googleapis.com/token",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        });
      if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile")
        return Response.json({ emailAddress: "mailbox@example.test" });
      if (url === "https://oauth2.googleapis.com/token")
        return Response.json({
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: OFFICIAL_GMAIL_MCP_SCOPES.join(" "),
        });
      throw new Error(`Unexpected synthetic OAuth destination: ${url}`);
    },
  );
  const begin = async (finishInPopup: boolean) => {
    const response = await app.request(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        providerId: "gmail",
        ownership: "personal",
        returnUrl: hostPage,
        ...(finishInPopup ? { finishInPopup: true } : {}),
        idempotencyKey: randomUUID(),
      }),
    });
    expect(response.status).toBe(200);
    const attempt = await response.json();
    const advanced = await app.request(`${base}/${attempt.id}/advance`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        expectedRevision: attempt.revision,
        idempotencyKey: randomUUID(),
        action: { type: "credentials", values: { mcpUrl: OFFICIAL_GMAIL_MCP_URL } },
      }),
    });
    expect(advanced.status).toBe(200);
    const ready = await advanced.json();
    expect(ready.state).toBe("requires_user_action");
    return {
      id: ready.id as string,
      state: new URL(ready.nextAction.url).searchParams.get("state")!,
    };
  };
  const callback = (state: string, code = true) =>
    app.request(
      `/v1/integrations/oauth/callback?${new URLSearchParams({ state, ...(code ? { code: "synthetic-code" } : {}) })}`,
    );
  const finished = "https://runtime.example.test/v1/integrations/connect/finished";
  try {
    // Connected or not, the popup lands on the closing page; the chat reads
    // the attempt for the outcome.
    const connected = await begin(true);
    const done = await callback(connected.state);
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(finished);
    expect(await (await app.request(`${base}/${connected.id}`, { headers })).json()).toMatchObject({
      state: "complete",
    });
    const declined = await begin(true);
    expect((await callback(declined.state, false)).headers.get("location")).toBe(finished);
    // Without the flag the exact host return is unchanged.
    const host = await begin(false);
    expect((await callback(host.state)).headers.get("location")).toBe(hostPage);
  } finally {
    transport.mockRestore();
  }

  // The page itself is public, static and closes its own window.
  const page = await app.request("/v1/integrations/connect/finished");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("cache-control")).toBe("no-store");
  const policy = page.headers.get("content-security-policy") ?? "";
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/u);
  const html = await page.text();
  expect(html).toContain("<script>window.close();</script>");
  expect(html).toContain("You can close this window");
}, 60_000);
