import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  NangoClient,
  classifyNangoTool,
  credentialRequestTarget,
  effectiveNangoIntegrations,
  estimateNangoCostUsd,
  isNangoConnectionCredential,
  nangoAttemptTags,
  nangoDestinationAllowed,
  nangoIntegrationKeyFromProviderDomain,
  nangoProviderDomain,
  nangoProxyRequest,
  nangoTagsMatchAttempt,
  nangoToolsIntegrationKeyFromMcpUrl,
  nangoToolsMcpUrl,
  nativeNangoIntegrationByKey,
  nativeNangoIntegrationForMcpUrl,
  nativeNangoIntegrationForProviderDomain,
  parseNangoAuthWebhook,
  parseNangoIntegrationDefinition,
  planNangoOrphans,
  readIdentityField,
  selectNangoTools,
  verifyNangoWebhookSignature,
  type IntegrationBackendSetting,
  type NangoConnectionSummary,
} from "../src/nango";

function setting(overrides: Partial<IntegrationBackendSetting>): IntegrationBackendSetting {
  return {
    integrationKey: "gmail",
    backend: "nango",
    providerConfigKey: "google-mail",
    enabled: true,
    definition: null,
    revision: 1,
    changedAt: "2026-11-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("Nango identities", () => {
  test("provider domains are namespaced away from native domains", () => {
    expect(nangoProviderDomain("gmail")).toBe("nango:gmail");
    expect(nangoIntegrationKeyFromProviderDomain("nango:gmail")).toBe("gmail");
    expect(nangoIntegrationKeyFromProviderDomain("gmailmcp.googleapis.com")).toBeNull();
    expect(() => nangoProviderDomain("Bad Key")).toThrow();
    expect(nativeNangoIntegrationForProviderDomain("nango:gmail")?.nativeProviderDomain).toBe(
      "gmailmcp.googleapis.com",
    );
    expect(nativeNangoIntegrationForProviderDomain("gmailmcp.googleapis.com")?.integrationKey).toBe(
      "gmail",
    );
    expect(
      nativeNangoIntegrationForMcpUrl("https://drivemcp.googleapis.com/mcp/v1/")?.integrationKey,
    ).toBe("google-drive");
    expect(nangoToolsIntegrationKeyFromMcpUrl(nangoToolsMcpUrl("linkedin"))).toBe("linkedin");
    expect(nangoToolsIntegrationKeyFromMcpUrl("https://example.com/tools/linkedin")).toBeNull();
  });

  test("destinations bind exact origin and path prefix", () => {
    const gmail = nativeNangoIntegrationByKey("gmail")!;
    expect(
      nangoDestinationAllowed(
        gmail.destinations,
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      ),
    ).toBe(true);
    expect(
      nangoDestinationAllowed(
        gmail.destinations,
        "https://gmail.googleapis.com/gmail/v1/users/other/messages",
      ),
    ).toBe(false);
    expect(
      nangoDestinationAllowed(gmail.destinations, "https://evil.example/gmail/v1/users/me/"),
    ).toBe(false);
    expect(
      nangoDestinationAllowed(gmail.destinations, "http://gmail.googleapis.com/gmail/v1/users/me/"),
    ).toBe(false);
  });

  test("proxy rewrite keeps path and query and pins the provider origin", () => {
    const proxied = nangoProxyRequest(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=5",
      {
        baseUrl: "https://api.nango.dev/",
      },
    );
    expect(proxied.url.toString()).toBe(
      "https://api.nango.dev/proxy/calendar/v3/calendars/primary/events?maxResults=5",
    );
    expect(proxied.headers["base-url-override"]).toBe("https://www.googleapis.com");
    const direct = credentialRequestTarget("https://www.googleapis.com/drive/v3/files", {
      headers: { authorization: "Bearer direct" },
    });
    expect(direct.url.toString()).toBe("https://www.googleapis.com/drive/v3/files");
    const viaNango = credentialRequestTarget("https://www.googleapis.com/drive/v3/files", {
      headers: {
        authorization: "Bearer env",
        "connection-id": "c1",
        "provider-config-key": "google-drive",
      },
      proxy: {
        kind: "nango_proxy",
        baseUrl: "https://api.nango.dev",
        integrationKey: "google-drive",
        providerConfigKey: "google-drive",
        nangoConnectionId: "c1",
      },
    });
    expect(viaNango.url.toString()).toBe("https://api.nango.dev/proxy/drive/v3/files");
    expect(viaNango.headers["connection-id"]).toBe("c1");
    expect(viaNango.headers["base-url-override"]).toBe("https://www.googleapis.com");
  });

  test("credentials carry only Nango identifiers", () => {
    expect(
      isNangoConnectionCredential({
        type: "nango",
        nangoConnectionId: "abc",
        providerConfigKey: "google-mail",
        integrationKey: "gmail",
      }),
    ).toBe(true);
    expect(isNangoConnectionCredential({ type: "nango", nangoConnectionId: "abc" })).toBe(false);
    expect(isNangoConnectionCredential({ accessToken: "x" })).toBe(false);
  });
});

describe("backend setting", () => {
  test("nothing is offered unless configured, enabled and nango", () => {
    const settings = [
      setting({}),
      setting({ integrationKey: "google-drive", backend: "native", providerConfigKey: null }),
      setting({ integrationKey: "google-calendar", enabled: false }),
      setting({ integrationKey: "linkedin", providerConfigKey: "linkedin" }),
      setting({
        integrationKey: "x",
        providerConfigKey: "twitter-v2",
        definition: parseNangoIntegrationDefinition({
          displayName: "X",
          tools: { source: "nango" },
        }),
      }),
    ];
    expect(effectiveNangoIntegrations(settings, false).size).toBe(0);
    const effective = effectiveNangoIntegrations(settings, true);
    expect([...effective.keys()].sort()).toEqual(["gmail", "x"]);
    expect(effective.get("gmail")?.native?.integrationKey).toBe("gmail");
    expect(effective.get("x")?.native).toBeNull();
  });

  test("definitions parse leniently", () => {
    const definition = parseNangoIntegrationDefinition({
      displayName: " LinkedIn ",
      logoUrl: "http://insecure.example/logo.png",
      ownership: "personal",
      accountIdentity: { url: "https://api.linkedin.com/v2/userinfo", field: "email" },
      tools: { source: "nango", allow: ["post", 3, "bad name"], write: ["post"] },
      unknown: true,
    });
    expect(definition).toEqual({
      displayName: "LinkedIn",
      ownership: "personal",
      accountIdentity: { url: "https://api.linkedin.com/v2/userinfo", field: "email" },
      tools: { source: "nango", allow: ["post"], write: ["post"] },
    });
    expect(parseNangoIntegrationDefinition("nope")).toEqual({});
  });
});

describe("webhooks and attempts", () => {
  test("signature verifies with current or previous signing key", () => {
    const body = JSON.stringify({ type: "auth", operation: "creation" });
    const signature = createHmac("sha256", "old-key").update(body).digest("hex");
    expect(verifyNangoWebhookSignature(body, signature, ["new-key", "old-key"])).toBe(true);
    expect(verifyNangoWebhookSignature(body, signature, ["new-key"])).toBe(false);
    expect(verifyNangoWebhookSignature(`${body} `, signature, ["old-key"])).toBe(false);
    expect(verifyNangoWebhookSignature(body, "zz", ["old-key"])).toBe(false);
    expect(verifyNangoWebhookSignature(body, null, ["old-key"])).toBe(false);
  });

  test("auth webhook parsing", () => {
    expect(
      parseNangoAuthWebhook({
        type: "auth",
        operation: "refresh",
        connectionId: "c1",
        providerConfigKey: "google-mail",
        success: false,
        tags: { End_User_Id: "user:1", n: 3 },
      }),
    ).toEqual({
      type: "auth",
      operation: "refresh",
      connectionId: "c1",
      providerConfigKey: "google-mail",
      success: false,
      tags: { end_user_id: "user:1" },
    });
    expect(parseNangoAuthWebhook({ type: "sync" })).toBeNull();
  });

  test("attempt tags bind subject, workspace, attempt and integration", () => {
    const attempt = {
      accountId: "acc",
      workspaceId: "ws",
      subjectId: "user:1",
      attemptId: "a1",
      integrationKey: "gmail",
    };
    const tags = nangoAttemptTags({ ...attempt, email: "a@example.com" });
    expect(nangoTagsMatchAttempt(tags, attempt)).toBe(true);
    expect(nangoTagsMatchAttempt(tags, { ...attempt, attemptId: "a2" })).toBe(false);
    expect(nangoTagsMatchAttempt({ ...tags, opengeni_workspace_id: "other" }, attempt)).toBe(false);
    expect(nangoTagsMatchAttempt(null, attempt)).toBe(false);
  });
});

describe("tools and pricing", () => {
  test("classification and allowlist", () => {
    const definition = parseNangoIntegrationDefinition({
      tools: { source: "nango", allow: ["get-profile", "create-post"], read: ["get-profile"] },
    });
    expect(classifyNangoTool({ name: "get-profile" }, definition)).toBe("read");
    expect(classifyNangoTool({ name: "create-post" }, definition)).toBe("write");
    expect(classifyNangoTool({ name: "list", method: "GET" }, null)).toBe("read");
    expect(classifyNangoTool({ name: "list", method: "POST" }, null)).toBe("write");
    const selected = selectNangoTools(
      [
        { name: "get-profile", description: "", inputSchema: {} },
        { name: "create-post", description: "", inputSchema: {} },
        { name: "delete-post", description: "", inputSchema: {} },
      ],
      definition,
    );
    expect(selected.map((tool) => tool.name)).toEqual(["get-profile", "create-post"]);
  });

  test("cost estimate", () => {
    const cost = estimateNangoCostUsd({
      connectionSeconds: 30 * 24 * 3600,
      transferBytes: 2_000_000_000,
      computeSeconds: 3600,
    });
    expect(cost).toEqual({ connections: 0.29, transfer: 1, compute: 0.72, total: 2.01 });
  });

  test("identity field reads a dot path", () => {
    expect(
      readIdentityField({ user: { emailAddress: "a@example.com" } }, "user.emailAddress"),
    ).toBe("a@example.com");
    expect(readIdentityField({}, "user.emailAddress")).toBeNull();
  });
});

describe("NangoClient", () => {
  test("calls the documented endpoints with the secret key", async () => {
    const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] =
      [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string>,
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      if (url.endsWith("/connect/sessions"))
        return Response.json({
          data: { token: "tok", connect_link: "https://connect.nango.dev/x", expires_at: "z" },
        });
      if (url.includes("/connections?"))
        return Response.json({
          connections: [
            {
              connection_id: "c1",
              provider_config_key: "google-mail",
              provider: "google-mail",
              created: "2026-11-13T00:00:00Z",
              tags: { END_USER_ID: "user:1" },
              errors: [{ type: "auth" }],
            },
          ],
        });
      if (url.includes("/functions"))
        return Response.json({
          data: [
            {
              type: "tool",
              name: "create-post",
              description: "Create a post",
              input_json_schema: { type: "object" },
            },
            { type: "sync", name: "contacts" },
          ],
          pagination: { total: 2 },
        });
      if (url.includes("/tools/")) return Response.json({ id: "p1" });
      return new Response(null, { status: 404 });
    };
    const client = new NangoClient({
      secretKey: "sk-test",
      baseUrl: "https://nango.test",
      fetchImpl,
    });
    const session = await client.createConnectSession({
      tags: { a: "b" },
      allowedIntegrations: ["google-mail"],
    });
    expect(session).toEqual({
      token: "tok",
      connectLink: "https://connect.nango.dev/x",
      expiresAt: "z",
    });
    const connections = await client.listConnections({
      connectionId: "c1",
      tags: { end_user_id: "user:1" },
    });
    expect(connections[0]).toMatchObject({
      connectionId: "c1",
      authErrors: 1,
      tags: { end_user_id: "user:1" },
    });
    const tools = await client.listTools("linkedin");
    expect(tools.map((tool) => tool.name)).toEqual(["create-post"]);
    const result = await client.callTool({
      nangoConnectionId: "c1",
      providerConfigKey: "linkedin",
      name: "create-post",
      input: { text: "hi" },
    });
    expect(result.body).toEqual({ id: "p1" });
    await client.deleteConnection("c1", "google-mail");
    expect(calls.every((call) => call.headers.authorization === "Bearer sk-test")).toBe(true);
    expect(calls[1]!.url).toContain("tags%5Bend_user_id%5D=user%3A1");
    expect(calls[3]!.url).toBe("https://nango.test/connections/c1/tools/create-post/calls");
    expect(calls[3]!.body).toBe(JSON.stringify({ input: { text: "hi" } }));
    expect(calls[4]!.method).toBe("DELETE");
  });
});

describe("orphan reconciliation", () => {
  const now = Date.parse("2026-11-13T12:00:00.000Z");
  const tagged = (attemptId: string) => ({
    ...nangoAttemptTags({
      accountId: "org",
      workspaceId: "ws",
      subjectId: "user",
      attemptId,
      integrationKey: "gmail",
    }),
  });
  const remote = (
    connectionId: string,
    tags: Record<string, string>,
    createdAt: string | null,
    providerConfigKey = "google-mail",
  ): NangoConnectionSummary => ({
    connectionId,
    providerConfigKey,
    provider: "google-mail",
    createdAt,
    tags,
    authErrors: 0,
  });
  const connections = [
    remote("live", tagged("a1"), "2026-11-01T00:00:00.000Z"),
    remote("old-tagged", tagged("a2"), "2026-11-13T09:00:00.000Z"),
    remote("in-progress", tagged("a3"), "2026-11-13T11:30:00.000Z"),
    remote("no-age", tagged("a4"), null),
    remote("outside", {}, "2026-10-01T00:00:00.000Z"),
    remote("other-integration", {}, "2026-10-01T00:00:00.000Z", "linkedin"),
  ];

  test("deletes only old Opengeni-tagged orphans; untagged only when asked", () => {
    const plan = planNangoOrphans({
      remote: connections,
      liveNangoConnectionIds: new Set(["live"]),
      now,
    });
    expect(Object.fromEntries(plan.map((orphan) => [orphan.connectionId, orphan.action]))).toEqual({
      "old-tagged": "delete",
      "in-progress": "keep_recent",
      "no-age": "keep_unknown_age",
      outside: "keep_untagged",
      "other-integration": "keep_untagged",
    });
    const withUntagged = planNangoOrphans({
      remote: connections,
      liveNangoConnectionIds: new Set(["live"]),
      now,
      includeUntagged: true,
      // A shorter age than the connect-state lifetime is never used.
      minAgeMs: 1,
    });
    expect(withUntagged.find((orphan) => orphan.connectionId === "outside")?.action).toBe("delete");
    expect(withUntagged.find((orphan) => orphan.connectionId === "in-progress")?.action).toBe(
      "keep_recent",
    );
  });

  test("one integration: by tag, or by provider config key when untagged", () => {
    const plan = planNangoOrphans({
      remote: connections,
      liveNangoConnectionIds: new Set(),
      integration: { key: "gmail", providerConfigKeys: new Set(["google-mail"]) },
      now,
      includeUntagged: true,
    });
    expect(plan.map((orphan) => orphan.connectionId).sort()).toEqual([
      "in-progress",
      "live",
      "no-age",
      "old-tagged",
      "outside",
    ]);
  });
});

describe("NangoClient.getConnection", () => {
  test("reads one connection with the documented endpoint, without credentials", async () => {
    const requests: string[] = [];
    const client = new NangoClient({
      secretKey: "nango-secret-test",
      baseUrl: "https://nango.test",
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requests.push(url.pathname + url.search);
        if (url.pathname === "/connections/missing") return new Response("", { status: 404 });
        if (url.pathname === "/connections/stale")
          return Response.json({ error: { code: "refresh_exhausted" } }, { status: 424 });
        return Response.json({
          connection_id: "c-1",
          provider_config_key: "google-mail",
          provider: "google-mail",
          created_at: "2026-11-13T00:00:00.000Z",
          tags: { Opengeni_Attempt_Id: "a1" },
          errors: [{ type: "auth" }, { type: "sync" }],
          credentials: { access_token: "provider-token", raw: { scope: "a b" } },
        });
      }) as typeof fetch,
    });
    const connection = await client.getConnection("c-1", "google-mail");
    expect(connection).toEqual({
      connectionId: "c-1",
      providerConfigKey: "google-mail",
      provider: "google-mail",
      createdAt: "2026-11-13T00:00:00.000Z",
      tags: { opengeni_attempt_id: "a1" },
      authErrors: 1,
      scopes: ["a", "b"],
      refreshFailed: false,
    });
    expect(JSON.stringify(connection)).not.toContain("provider-token");
    expect(requests[0]).toBe(
      "/connections/c-1?provider_config_key=google-mail&refresh_token=false",
    );
    expect(await client.getConnection("missing", "google-mail")).toBeNull();
    // Nango refreshes on this read and answers 424 when that fails.
    expect(await client.getConnection("stale", "google-mail")).toMatchObject({
      refreshFailed: true,
      authErrors: 1,
      scopes: null,
    });
    expect(await client.connectionGrantedScopes("stale", "google-mail")).toBeNull();
  });
});
