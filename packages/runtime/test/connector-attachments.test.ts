import { describe, expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import { startTestMcpServer, testSettings } from "@opengeni/testing";
import {
  CONNECTOR_ATTACHMENT_MAX_BYTES,
  CONNECTOR_ATTACHMENT_RECEIPT_META_KEY,
  CONNECTOR_ATTACHMENT_TRANSFER_META_KEY,
} from "@opengeni/contracts";
import {
  CONNECTOR_ATTACHMENT_SANITIZED_RESULT_MAX_BYTES,
  PrefixedMcpServer,
  connectorAttachmentSandboxPath,
  configureRuntimeMetricsHooks,
  prepareAgentTools,
  projectConnectorAttachmentTransfers,
  type ConnectorActionPolicyHooks,
  type ConnectorAttachmentMaterializationRequest,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
  type RuntimeMetricsHooks,
} from "../src";
import { RoutingMutationOutcomeUnknownError } from "../src/sandbox";

const operationId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const privateUrl = "https://files.example.test/download?id=42&signature=private-value";
const attachment = {
  providerAttachmentId: {
    provider: "example",
    kind: "attachment" as const,
    value: "provider-file-42",
  },
  fileName: "payload.bin",
  mediaType: "application/octet-stream",
  byteSize: 6,
  contentSha256: "a".repeat(64),
  source: {
    url: privateUrl,
    expiresAt: "2030-01-02T03:04:05.000Z",
  },
};
const sandboxPath = connectorAttachmentSandboxPath(
  { serverId: "connector", connectionId },
  attachment,
);
const unmanagedConnectorActionPolicy: ConnectorActionPolicyHooks = {
  prepare: async () => ({ managed: false, decision: "unmanaged" }),
  begin: async () => ({ allowed: true, managed: false }),
  complete: async () => {},
};

function transferResult(overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text", text: "Attachment is ready." }],
    _meta: {
      providerTrace: "trace-1",
      [CONNECTOR_ATTACHMENT_TRANSFER_META_KEY]: {
        version: 1,
        attachments: [attachment],
      },
    },
    ...overrides,
  };
}

function matchingReceipt(request?: ConnectorAttachmentMaterializationRequest) {
  const exact = request?.attachments[0] ?? attachment;
  const exactSandboxPath = connectorAttachmentSandboxPath(
    {
      serverId: request?.serverId ?? "connector",
      connectionId: request?.connectionId ?? connectionId,
    },
    exact,
  );
  return {
    version: 1 as const,
    attachments: [
      {
        providerAttachmentId: exact.providerAttachmentId,
        fileName: exact.fileName,
        mediaType: exact.mediaType,
        byteSize: exact.byteSize,
        contentSha256: exact.contentSha256,
        sandboxPath: exactSandboxPath,
      },
    ],
  };
}

function transferServer(result: unknown): MCPServer {
  return {
    name: "connector-inner",
    cacheToolsList: false,
    async connect() {},
    async close() {},
    async listTools() {
      return [
        {
          name: "download_attachment",
          description: "Download one attachment.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ];
    },
    async callTool() {
      return (result as { content?: unknown }).content ?? [];
    },
    async callToolResult() {
      return result;
    },
    async invalidateToolsCache() {},
  };
}

describe("connector attachment MCP projection", () => {
  test("keeps the private URL only in the materializer callback", async () => {
    let callbackRequest: ConnectorAttachmentMaterializationRequest | undefined;
    const projected = await projectConnectorAttachmentTransfers(transferResult(), {
      serverId: "connector",
      toolName: "download_attachment",
      operationId,
      connectionId,
      expectedProvider: "example",
      authorizeAndMaterialize: async (attachments) => {
        callbackRequest = {
          serverId: "connector",
          toolName: "download_attachment",
          operationId,
          connectionId,
          attachments,
        };
        return matchingReceipt(callbackRequest);
      },
    });

    expect(callbackRequest?.attachments[0]?.source.url).toBe(privateUrl);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(privateUrl);
    expect(serialized).not.toContain("signature=private-value");
    expect(serialized).not.toContain(CONNECTOR_ATTACHMENT_TRANSFER_META_KEY);
    expect(serialized).not.toContain("Attachment is ready");
    expect(serialized).not.toContain("trace-1");
    expect(serialized).toContain(CONNECTOR_ATTACHMENT_RECEIPT_META_KEY);
    expect(serialized).toContain(sandboxPath);
    expect((projected as { content: Array<{ text: string }> }).content[0]?.text).toContain(
      `- ${JSON.stringify(sandboxPath)}`,
    );
  });

  test("represents a maximum-size attachment only as bounded metadata", async () => {
    const largeAttachment = {
      ...attachment,
      byteSize: CONNECTOR_ATTACHMENT_MAX_BYTES,
      fileName: "large.bin",
    };
    const projected = await projectConnectorAttachmentTransfers(
      transferResult({
        _meta: {
          [CONNECTOR_ATTACHMENT_TRANSFER_META_KEY]: {
            version: 1,
            attachments: [largeAttachment],
          },
        },
      }),
      {
        serverId: "connector",
        toolName: "download_attachment",
        operationId,
        connectionId,
        expectedProvider: "example",
        authorizeAndMaterialize: async (attachments) =>
          matchingReceipt({
            serverId: "connector",
            toolName: "download_attachment",
            operationId,
            connectionId,
            attachments,
          }),
      },
    );
    const bytes = new TextEncoder().encode(JSON.stringify(projected)).byteLength;
    expect(bytes).toBeLessThan(CONNECTOR_ATTACHMENT_SANITIZED_RESULT_MAX_BYTES);
    expect(JSON.stringify(projected)).not.toContain(privateUrl);
  });

  test("binds a remote brokered transfer to the exact resolved tool-call connection", async () => {
    const remote = startTestMcpServer({
      requiredHeaders: { authorization: "Bearer hidden" },
      toolResultText: "Attachment is ready.",
      toolResultMeta: transferResult()._meta,
    });
    const materialized: ConnectorAttachmentMaterializationRequest[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "connector",
            name: "Connector",
            url: remote.url,
            connectionRef: {
              connectionId,
              provider: "example",
              providerDomain: "example.test",
              kind: "oauth2",
              subjectScope: "workspace",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "connector" }],
      {
        accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceId: "33333333-3333-4333-8333-333333333333",
        sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        executionGeneration: 1,
        resolveCredential: async (): Promise<ResolveConnectionCredentialResult> => ({
          status: "ok",
          connectionId,
          headers: { authorization: "Bearer hidden" },
        }),
        materializeConnectorAttachments: async (request) => {
          materialized.push(request);
          return matchingReceipt(request);
        },
        connectorActionPolicy: unmanagedConnectorActionPolicy,
      },
    );
    try {
      const result = await prepared.attemptToolEnvironment!.call({
        operationId,
        catalogDigest: prepared.attemptToolCatalog!.digest,
        identity: { serverId: "connector", toolName: "search_documents" },
        arguments: { query: "attachment" },
        caller: { kind: "codemode", subjectId: "agent:test" },
      });
      expect(materialized).toHaveLength(1);
      expect(materialized[0]).toMatchObject({
        serverId: "connector",
        toolName: "search_documents",
        operationId,
        connectionId,
      });
      expect(result).not.toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain(CONNECTOR_ATTACHMENT_RECEIPT_META_KEY);
      expect(JSON.stringify(result)).not.toContain(privateUrl);
    } finally {
      await prepared.close();
      remote.close();
    }
  });

  test.each([
    ["image bytes", [{ type: "image", data: "opaque-base64", mimeType: "image/png" }]],
    ["audio bytes", [{ type: "audio", data: "opaque-base64", mimeType: "audio/mpeg" }]],
    [
      "embedded blob bytes",
      [{ type: "resource", resource: { uri: "file:///payload", blob: "opaque-base64" } }],
    ],
  ])("rejects %s beside an out-of-band transfer", async (_label, content) => {
    await expect(
      projectConnectorAttachmentTransfers(transferResult({ content }), {
        serverId: "connector",
        toolName: "download_attachment",
        operationId,
        connectionId,
        authorizeAndMaterialize: async () => matchingReceipt(),
      }),
    ).rejects.toThrow("rejected");
  });

  test("rejects a private source URL duplicated into model-visible text", async () => {
    await expect(
      projectConnectorAttachmentTransfers(
        transferResult({ content: [{ type: "text", text: `Download ${privateUrl}` }] }),
        {
          serverId: "connector",
          toolName: "download_attachment",
          operationId,
          connectionId,
          authorizeAndMaterialize: async () => matchingReceipt(),
        },
      ),
    ).rejects.toThrow("rejected");
  });

  test.each(["sig", "auth"])(
    "rejects short %s source credentials copied into public metadata before materialization",
    async (credentialName) => {
      const credential = "abc";
      let materializerCalled = false;
      await expect(
        projectConnectorAttachmentTransfers(
          transferResult({
            _meta: {
              [CONNECTOR_ATTACHMENT_TRANSFER_META_KEY]: {
                version: 1,
                attachments: [
                  {
                    ...attachment,
                    fileName: `file-${credential}.bin`,
                    source: {
                      ...attachment.source,
                      url: `https://files.example.test/download?${credentialName}=${credential}`,
                    },
                  },
                ],
              },
            },
          }),
          {
            serverId: "connector",
            toolName: "download_attachment",
            operationId,
            connectionId,
            authorizeAndMaterialize: async () => {
              materializerCalled = true;
              return matchingReceipt();
            },
          },
        ),
      ).rejects.toThrow("rejected");
      expect(materializerCalled).toBe(false);
    },
  );

  test.each([
    ["a private signed URL", privateUrl],
    [
      "a safe-looking but non-authoritative digest",
      ".opengeni/connector-attachments/example/ffffffffffffffffffffffffffffffff/payload.bin",
    ],
  ])("rejects materializer receipt path containing %s", async (_label, maliciousPath) => {
    let materializerCalled = false;
    await expect(
      projectConnectorAttachmentTransfers(transferResult(), {
        serverId: "connector",
        toolName: "download_attachment",
        operationId,
        connectionId,
        authorizeAndMaterialize: async () => {
          materializerCalled = true;
          const receipt = matchingReceipt();
          receipt.attachments[0]!.sandboxPath = maliciousPath;
          return receipt;
        },
      }),
    ).rejects.toThrow("rejected");
    expect(materializerCalled).toBe(true);
  });

  test("preserves routed mutation outcome-unknown through the private projection", async () => {
    const uncertain = new RoutingMutationOutcomeUnknownError(
      "importWorkspaceFiles",
      "synthetic uncertain connector attachment batch",
    );
    await expect(
      projectConnectorAttachmentTransfers(transferResult(), {
        serverId: "connector",
        toolName: "download_attachment",
        operationId,
        connectionId,
        authorizeAndMaterialize: async () => {
          throw uncertain;
        },
      }),
    ).rejects.toBe(uncertain);
  });

  test("best-effort MCP isolation does not flatten routed mutation outcome-unknown", async () => {
    const observations: Array<Parameters<NonNullable<RuntimeMetricsHooks["onMcpToolCall"]>>[0]> =
      [];
    configureRuntimeMetricsHooks({
      onMcpToolCall: (input) => observations.push(input),
    });
    const uncertain = new RoutingMutationOutcomeUnknownError(
      "importWorkspaceFiles",
      "synthetic uncertain connector attachment batch",
    );
    const wrapped = new PrefixedMcpServer(
      {
        name: "connector-inner",
        cacheToolsList: false,
        async connect() {},
        async close() {},
        async listTools() {
          return [];
        },
        async callTool() {
          throw uncertain;
        },
        async invalidateToolsCache() {},
      } as MCPServer,
      "connector",
      undefined,
      true,
    );
    try {
      await expect(
        wrapped.callTool(`${wrapped.prefix}download_attachment`, {}, undefined),
      ).rejects.toBe(uncertain);
      expect(observations.map(({ outcome }) => outcome)).toEqual(["outcome_uncertain"]);
    } finally {
      configureRuntimeMetricsHooks(null);
    }
  });

  test("rejects structured content beside an out-of-band transfer", async () => {
    await expect(
      projectConnectorAttachmentTransfers(
        transferResult({ structuredContent: { bytes: "opaque-base64" } }),
        {
          serverId: "connector",
          toolName: "download_attachment",
          operationId,
          connectionId,
          authorizeAndMaterialize: async () => matchingReceipt(),
        },
      ),
    ).rejects.toThrow("rejected");
  });

  test("revalidates exact workspace and subject authority after the provider call", async () => {
    const resolverCalls: ResolveConnectionCredentialInput[] = [];
    const materialized: ConnectorAttachmentMaterializationRequest[] = [];
    let providerAuthorizations = 0;
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "connector",
            name: "Connector",
            url: "https://mcp.example.test/rpc",
            connectionRef: {
              connectionId,
              provider: "example",
              providerDomain: "example.test",
              kind: "oauth2",
              subjectScope: "subject",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "connector" }],
      {
        accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceId: "33333333-3333-4333-8333-333333333333",
        sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        turnId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        attemptId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        executionGeneration: 1,
        credentialSubjectId: "subject-a",
        localMcpServers: [
          {
            id: "connector",
            server: transferServer(transferResult()),
            resolvedConnectionId: connectionId,
          },
        ],
        resolveCredential: async (input): Promise<ResolveConnectionCredentialResult> => {
          resolverCalls.push(input);
          return {
            status: "ok",
            connectionId,
            headers: { authorization: "Bearer hidden" },
            authorizeProviderRequest: async () => {
              providerAuthorizations += 1;
              return true;
            },
          };
        },
        materializeConnectorAttachments: async (request) => {
          if (!request.authorizeProviderRequest) {
            throw new Error("missing provider authorization hook");
          }
          for (let index = 0; index < request.attachments.length; index += 1) {
            if (!(await request.authorizeProviderRequest())) {
              throw new Error("provider request denied");
            }
          }
          materialized.push(request);
          return matchingReceipt(request);
        },
        connectorActionPolicy: unmanagedConnectorActionPolicy,
      },
    );
    try {
      const modelResult = await prepared.mcpServers[0]!.callToolResult!(
        "connector__download_attachment",
        {},
      );
      const codemodeResult = await prepared.attemptToolEnvironment!.call({
        operationId,
        catalogDigest: prepared.attemptToolCatalog!.digest,
        identity: { serverId: "connector", toolName: "download_attachment" },
        arguments: {},
        caller: { kind: "codemode", subjectId: "agent:test" },
      });
      expect(materialized).toHaveLength(2);
      expect(materialized[0]).toMatchObject({ connectionId, serverId: "connector" });
      expect(materialized[0]!.operationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(materialized[1]).toMatchObject({ connectionId, operationId, serverId: "connector" });
      expect(resolverCalls).toHaveLength(2);
      expect(providerAuthorizations).toBe(2);
      for (const call of resolverCalls) {
        expect(call).toMatchObject({
          workspaceId: "33333333-3333-4333-8333-333333333333",
          subjectId: "subject-a",
          serverId: "connector",
          toolName: "download_attachment",
          connectionRef: expect.any(Object),
          destinationUrl: "https://mcp.example.test/rpc",
          forceRefresh: false,
        });
      }
      expect(JSON.stringify(modelResult)).not.toContain(privateUrl);
      expect(JSON.stringify(codemodeResult)).not.toContain(privateUrl);
    } finally {
      await prepared.close();
    }
  });

  test.each([
    [
      "revoked authority",
      { status: "auth_needed", reason: "revoked", providerDomain: "example.test" } as const,
      1,
    ],
    [
      "different connection identity",
      {
        status: "ok",
        connectionId: "44444444-4444-4444-8444-444444444444",
        headers: {},
      } as const,
      0,
    ],
  ])("fails closed for %s", async (_label, resolution, expectedAuthEvents) => {
    let materializerCalls = 0;
    const authEvents: unknown[] = [];
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "connector",
            name: "Connector",
            url: "https://mcp.example.test/rpc",
            connectionRef: {
              connectionId,
              provider: "example",
              providerDomain: "example.test",
              subjectScope: "workspace",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "connector" }],
      {
        workspaceId: "33333333-3333-4333-8333-333333333333",
        localMcpServers: [
          {
            id: "connector",
            server: transferServer(transferResult()),
            resolvedConnectionId: connectionId,
          },
        ],
        resolveCredential: async (): Promise<ResolveConnectionCredentialResult> => resolution,
        onAuthNeeded: (event) => authEvents.push(event),
        materializeConnectorAttachments: async (request) => {
          materializerCalls += 1;
          return matchingReceipt(request);
        },
      },
    );
    try {
      const result = await (prepared.mcpServers[0] as PrefixedMcpServer).executeCatalogTool(
        "download_attachment",
        {},
        { opengeniOperationId: operationId },
      );
      expect(materializerCalls).toBe(0);
      expect(authEvents).toHaveLength(expectedAuthEvents);
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).not.toContain(privateUrl);
    } finally {
      await prepared.close();
    }
  });

  test("preserves host provenance when attachment revalidation needs authorization", async () => {
    let materializerCalls = 0;
    const authEvents: unknown[] = [];
    const authorizationUrl = "https://host.example.test/connections/authorize";
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "connector",
            name: "Connector",
            url: "https://mcp.example.test/rpc",
            connectionRef: {
              connectionId,
              authoritySource: "host",
              provider: "example",
              providerDomain: "example.test",
              subjectScope: "workspace",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "connector" }],
      {
        workspaceId: "33333333-3333-4333-8333-333333333333",
        localMcpServers: [
          {
            id: "connector",
            server: transferServer(transferResult()),
            resolvedConnectionId: connectionId,
          },
        ],
        resolveCredential: async (): Promise<ResolveConnectionCredentialResult> => ({
          status: "auth_needed",
          reason: "revoked",
          providerDomain: "example.test",
          connectionId,
          authorizationUrl,
        }),
        onAuthNeeded: (event) => authEvents.push(event),
        materializeConnectorAttachments: async (request) => {
          materializerCalls += 1;
          return matchingReceipt(request);
        },
      },
    );
    try {
      const result = await (prepared.mcpServers[0] as PrefixedMcpServer).executeCatalogTool(
        "download_attachment",
        {},
        { opengeniOperationId: operationId },
      );
      expect(materializerCalls).toBe(0);
      expect(result).toMatchObject({ isError: true });
      expect(authEvents).toEqual([
        {
          serverId: "connector",
          toolName: "download_attachment",
          providerDomain: "example.test",
          provider: "example",
          reason: "revoked",
          connectionId,
          authoritySource: "host",
          authorizationUrl,
        },
      ]);
    } finally {
      await prepared.close();
    }
  });

  test("requires an explicit provider binding on the authorized connection", async () => {
    let materializerCalls = 0;
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "connector",
            name: "Connector",
            url: "https://mcp.example.test/rpc",
            connectionRef: {
              connectionId,
              providerDomain: "example.test",
              kind: "oauth2",
              subjectScope: "workspace",
            },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "connector" }],
      {
        workspaceId: "33333333-3333-4333-8333-333333333333",
        localMcpServers: [
          {
            id: "connector",
            server: transferServer(transferResult()),
            resolvedConnectionId: connectionId,
          },
        ],
        resolveCredential: async (): Promise<ResolveConnectionCredentialResult> => ({
          status: "ok",
          connectionId,
          headers: {},
        }),
        materializeConnectorAttachments: async (request) => {
          materializerCalls += 1;
          return matchingReceipt(request);
        },
      },
    );
    try {
      const result = await (prepared.mcpServers[0] as PrefixedMcpServer).executeCatalogTool(
        "download_attachment",
        {},
        { opengeniOperationId: operationId },
      );
      expect(materializerCalls).toBe(0);
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).not.toContain(privateUrl);
    } finally {
      await prepared.close();
    }
  });
});
