import { describe, expect, test } from "bun:test";
import { ToolAuthNeededPayload } from "../src/index";
import {
  BeginConnectRequest,
  ConnectAttempt,
  PreparedMcpSetup,
  preparedMcpHeaders,
} from "../src/connect";

const configuration = {
  name: "Example MCP",
  endpointUrl: "https://mcp.example.test/tools",
  headers: [
    { name: "X-Organization", value: "example" },
    { name: "Authorization", secret: "apiKey", prefix: "Bearer " },
  ],
  secretFields: [{ id: "apiKey", label: "API key" }],
};

const begin = {
  providerId: "mcp-headers",
  ownership: "personal" as const,
  returnUrl: "https://console.example.test/connections",
  idempotencyKey: "prepared-example",
  mcpSetup: configuration,
};

describe("prepared MCP setup contract", () => {
  test("retains prepared human setup without allowing conflicting identity or implicit scope", () => {
    const request = {
      kind: "mcp" as const,
      name: configuration.name,
      endpointUrl: configuration.endpointUrl,
      rationale: "Find the requested records.",
      ownership: "personal" as const,
      mcpSetup: configuration,
    };
    const event = {
      serverId: "opengeni",
      providerDomain: "mcp.example.test",
      reason: "missing_connection",
      setupRequest: request,
    };
    expect(ToolAuthNeededPayload.parse(event).setupRequest).toEqual(request);
    for (const change of [
      { ownership: undefined },
      { mcpSetup: undefined },
      { endpointUrl: "https://other.example.test/mcp" },
      { name: "A different server" },
      { mcpSetup: { ...configuration, values: { apiKey: "must-not-be-retained" } } },
    ])
      expect(
        ToolAuthNeededPayload.safeParse({
          ...event,
          setupRequest: { ...request, ...change },
        }).success,
      ).toBe(false);
  });

  test("retains the complete prepared config with explicit ownership", () => {
    const parsed = BeginConnectRequest.safeParse(begin);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject(begin);
    }
  });

  test("retains prepared config across the durable credential-input projection", () => {
    const parsed = ConnectAttempt.safeParse({
      id: "setup-example",
      workspaceId: "workspace-example",
      providerId: "mcp-headers",
      ownership: "personal",
      revision: 1,
      state: "credential_input",
      credentialsCommitted: false,
      integrationInstalled: false,
      completionRequirement: "integration",
      mcpSetup: configuration,
      nextAction: {
        type: "credentials",
        fields: [{ name: "apiKey", label: "API key", required: true, secret: true }],
      },
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toHaveProperty("mcpSetup", configuration);
  });

  test("keeps existing unprepared flows compatible", () => {
    const { mcpSetup: _unused, ...legacy } = begin;
    expect(BeginConnectRequest.parse(legacy)).toEqual(legacy);
  });

  test("applies exact agent-prepared mappings without changing secret bytes", () => {
    expect(preparedMcpHeaders(configuration, { apiKey: "synthetic key" })).toEqual({
      "X-Organization": "example",
      Authorization: "Bearer synthetic key",
    });
    expect(JSON.stringify(configuration)).not.toContain("synthetic key");
  });

  test("rejects missing, extra, or header-injecting values without echoing them", () => {
    for (const values of [
      {},
      { apiKey: "" },
      { apiKey: "secret", extra: "secret" },
      { apiKey: "secret\r\nInjected: value" },
    ]) {
      expect(() => preparedMcpHeaders(configuration, values)).toThrow(
        "Supply exactly the requested secret fields",
      );
    }
  });

  test("rejects ambiguous mappings, unused fields, and plaintext authentication config", () => {
    for (const change of [
      { headers: [...configuration.headers, { name: "authorization", secret: "apiKey" }] },
      { headers: [{ name: "Authorization", value: "raw-credential" }], secretFields: [] },
      { secretFields: [...configuration.secretFields, { id: "unused", label: "Unused" }] },
      { headers: [{ name: "Authorization", secret: "missing" }] },
      { headers: [{ name: "X-Header", value: "value", secret: "apiKey" }] },
    ])
      expect(PreparedMcpSetup.safeParse({ ...configuration, ...change }).success).toBe(false);
  });

  test("rejects credential-bearing or non-HTTPS endpoint proposals", () => {
    for (const endpointUrl of [
      "",
      "not a URL",
      "http://mcp.example.test",
      "https://key@mcp.example.test",
      "https://mcp.example.test?token=secret",
      "https://mcp.example.test#secret",
    ]) {
      expect(PreparedMcpSetup.safeParse({ ...configuration, endpointUrl }).success).toBe(false);
    }
  });

  test("does not attach MCP config to an unrelated or OAuth provider", () => {
    expect(BeginConnectRequest.safeParse({ ...begin, providerId: "mcp-oauth" }).success).toBe(
      false,
    );
    expect(BeginConnectRequest.safeParse({ ...begin, providerId: "fiken-token" }).success).toBe(
      false,
    );
  });
});
