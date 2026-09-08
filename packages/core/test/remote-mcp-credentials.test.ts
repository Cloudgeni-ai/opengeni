import { describe, expect, test } from "bun:test";
import type { McpCredentialsRequest, McpGatewayCredentialsRequest } from "@opengeni/contracts";
import type { pinnedFetch } from "@opengeni/network";
import { createRemoteMcpCredentialsPort } from "../src/remote-mcp-credentials";

const accountId = "11111111-1111-4111-8111-111111111111";
const request = (): McpCredentialsRequest => ({
  accountId,
  workspaceId: "workspace",
  sessionId: "session",
  rootSessionId: "root",
  turnId: "turn",
  attemptId: "attempt",
  executionGeneration: 1,
  initiator: { kind: "subject", subjectId: "host:user" },
  initiatorContext: {},
  surface: "model",
  destinationUrl: "https://tools.example.com/mcp",
  serverId: "tools",
  forceRefresh: false,
  connectionRef: {
    authoritySource: "host",
    providerDomain: "tools.example.com",
    connectionId: "binding",
  },
});
const settings = {
  environment: "test",
  integrationsAllowPrivateNetworkTargets: false,
  hostMcpCredentialResolversJson: JSON.stringify([
    { accountId, url: "https://host.example.com/credentials", bearerToken: "synthetic-secret" },
  ]),
};
function transport(modify?: (body: Record<string, any>) => void) {
  let calls = 0;
  const fetch: typeof pinnedFetch = async (_url, init) => {
    calls++;
    const envelope = JSON.parse(String(init?.body));
    const body = {
      version: 1,
      requestId: envelope.requestId,
      destinationUrl: envelope.request.destinationUrl,
      resolution: {
        status: "ok",
        accountId,
        workspaceId: "workspace",
        sessionId: "session",
        providerDomain: "tools.example.com",
        connectionId: "binding",
        headers: { Authorization: "Bearer synthetic-token" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    modify?.(body);
    return Response.json(body);
  };
  return { fetch, calls: () => calls };
}

describe("remote MCP credentials", () => {
  test("gateway transport requires non-turn request correlation and rejects a turn response", async () => {
    const gateway: McpGatewayCredentialsRequest = {
      accountId,
      workspaceId: "workspace",
      requestId: crypto.randomUUID(),
      surface: "workspace_gateway",
      authority: { kind: "external_user", subjectId: "external-owner", permissions: [] },
      destinationUrl: "https://tools.example.com/mcp",
      serverId: "tools",
      forceRefresh: false,
      connectionRef: request().connectionRef,
    };
    for (const mode of ["valid", "wrong_request", "turn"] as const) {
      const fetch: typeof pinnedFetch = async (_url, init) => {
        const envelope = JSON.parse(String(init?.body));
        expect(envelope.request).not.toHaveProperty("sessionId");
        expect(envelope.request.authority).toEqual(gateway.authority);
        return Response.json({
          version: 1,
          requestId: envelope.requestId,
          destinationUrl: gateway.destinationUrl,
          resolution: {
            status: "ok",
            accountId,
            workspaceId: "workspace",
            ...(mode === "turn"
              ? { sessionId: "session" }
              : {
                  requestId: mode === "valid" ? gateway.requestId : crypto.randomUUID(),
                }),
            providerDomain: "tools.example.com",
            connectionId: "binding",
            headers: { Authorization: "Bearer synthetic" },
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
      };
      const port = createRemoteMcpCredentialsPort(settings, fetch);
      expect((await port.mcpGatewayCredentials!(gateway)).status).toBe(
        mode === "valid" ? "ok" : "auth_needed",
      );
    }
  });

  test("timed-out transports still consume the physical request budget until settlement", async () => {
    const entries = JSON.parse(settings.hostMcpCredentialResolversJson);
    entries[0].timeoutMs = 100;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port = createRemoteMcpCredentialsPort(
      {
        ...settings,
        hostMcpCredentialResolversJson: JSON.stringify(entries),
      },
      async () => {
        calls++;
        await gate;
        return new Response(null, { status: 503 });
      },
    );
    try {
      await Promise.all(
        Array.from({ length: 128 }, (_, i) =>
          port.mcpCredentials!({
            ...request(),
            turnId: `turn-${i}`,
          }),
        ),
      );
      expect(calls).toBe(128);
      expect((await port.mcpCredentials!({ ...request(), turnId: "overflow" })).status).toBe(
        "auth_needed",
      );
      expect(calls).toBe(128);
    } finally {
      release();
    }
  });
  test("bounds a resolver that never responds", async () => {
    const entries = JSON.parse(settings.hostMcpCredentialResolversJson);
    entries[0].timeoutMs = 100;
    const port = createRemoteMcpCredentialsPort(
      {
        ...settings,
        hostMcpCredentialResolversJson: JSON.stringify(entries),
      },
      async () => await new Promise<Response>(() => {}),
    );
    const result = await port.mcpCredentials!(request());
    expect(result.status).toBe("auth_needed");
    expect("headers" in result).toBe(false);
  });

  test("snapshots authority before a delayed response", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = transport();
    const port = createRemoteMcpCredentialsPort(settings, async (...args) => {
      await gate;
      return await fake.fetch(...args);
    });
    const input = request();
    const pending = port.mcpCredentials!(input);
    input.accountId = "mutated-account";
    input.connectionRef.providerDomain = "mutated.example.com";
    release();
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(result.accountId).toBe(accountId);
    expect(result.providerDomain).toBe("tools.example.com");
  });

  test("is optional and does not install a resolver by default", () => {
    expect(
      createRemoteMcpCredentialsPort({ ...settings, hostMcpCredentialResolversJson: undefined }),
    ).toEqual({});
  });
  test("rejects malformed and duplicate configuration without revealing credentials", () => {
    expect(() =>
      createRemoteMcpCredentialsPort({
        ...settings,
        hostMcpCredentialResolversJson: "synthetic-secret",
      }),
    ).toThrow("Invalid host MCP credential resolver configuration");
    const entries = JSON.parse(settings.hostMcpCredentialResolversJson);
    expect(() =>
      createRemoteMcpCredentialsPort({
        ...settings,
        hostMcpCredentialResolversJson: JSON.stringify([...entries, ...entries]),
      }),
    ).toThrow("Invalid host MCP credential resolver configuration");
  });
  test("coalesces exact concurrent requests but never caches successful credentials", async () => {
    const fake = transport();
    const port = createRemoteMcpCredentialsPort(settings, fake.fetch);
    const results = await Promise.all([
      port.mcpCredentials!(request()),
      port.mcpCredentials!(request()),
    ]);
    expect(results.map((result) => result.status)).toEqual(["ok", "ok"]);
    expect(fake.calls()).toBe(1);
    await port.mcpCredentials!(request());
    expect(fake.calls()).toBe(2);
  });
  test("never sends another organization's or native connection request", async () => {
    const fake = transport();
    const port = createRemoteMcpCredentialsPort(settings, fake.fetch);
    expect(
      (await port.mcpCredentials!({ ...request(), accountId: "another-account" })).status,
    ).toBe("auth_needed");
    const native = request();
    delete native.connectionRef.authoritySource;
    expect((await port.mcpCredentials!(native)).status).toBe("auth_needed");
    expect(fake.calls()).toBe(0);
  });
  test.each(["requestId", "destinationUrl", "accountId", "expired", "oversized"])(
    "rejects %s response",
    async (mode) => {
      const fake = transport((body) => {
        if (mode === "requestId") body.requestId = crypto.randomUUID();
        if (mode === "destinationUrl") body.destinationUrl = "https://other.example.com";
        if (mode === "accountId") body.resolution.accountId = "other";
        if (mode === "expired") body.resolution.expiresAt = new Date(0).toISOString();
        if (mode === "oversized") body.resolution.headers.Authorization = "x".repeat(70_000);
      });
      const result = await createRemoteMcpCredentialsPort(settings, fake.fetch).mcpCredentials!(
        request(),
      );
      expect(result.status).toBe("auth_needed");
      expect("headers" in result).toBe(false);
    },
  );
});
