import { describe, expect, test } from "bun:test";

import {
  LOCAL_MCP_BRIDGE_CONTRACT_VERSION,
  createLocalMcpBridgeFromAdapters,
  createOpenApiMcpServer,
  defineLocalMcpBridgeDescriptor,
  isLocalMcpBridgeServer,
  compileOpenApiRevision,
  directIntegrationTransport,
  type LocalMcpBridgeAdapter,
  type LocalMcpBridgeServer,
} from "../src";

describe("local MCP bridge kit", () => {
  test("marks immutable OpenAPI adapters, including Drive-shaped definitions, as bridges", () => {
    const revision = compileOpenApiRevision(
      {
        openapi: "3.1.0",
        info: { title: "Drive-shaped API", version: "1" },
        servers: [{ url: "https://www.googleapis.com/drive/v3/" }],
        paths: {
          "/files": {
            get: {
              operationId: "drive.files.list",
              responses: { "200": { description: "Files" } },
            },
          },
        },
      },
      { definitionId: "google-drive", provider: "google" },
    );
    const server = createOpenApiMcpServer({
      revision,
      authority: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        connectionRef: "connection-1",
      },
      credentialResolver: { resolve: async () => null },
      transport: directIntegrationTransport(async () => Response.json({ files: [] })),
    });

    expect(isLocalMcpBridgeServer(server)).toBe(true);
    if (!isLocalMcpBridgeServer(server)) throw new Error("expected local bridge");
    expect(server.bridge).toEqual({
      contractVersion: LOCAL_MCP_BRIDGE_CONTRACT_VERSION,
      assurance: "revision_descriptive",
      adapterId: "openapi",
      providerId: "google",
      catalogIdentity: `integration-definition:google-drive@${revision.id}`,
      transport: "in_process",
      authority: "connection",
      toolSurface: "immutable_revision",
      mutationReplay: "safe_reads_only",
      destinations: [{ origin: "https://www.googleapis.com", pathPrefix: "/" }],
    });
  });

  test("describes accepted HTTP revisions with many origins without adding a runtime gate", () => {
    const paths = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `/operation-${index}`,
        {
          get: {
            operationId: `operation-${index}`,
            servers: [{ url: `http://127.0.0.1:${4100 + index}/api/` }],
            responses: { "200": { description: "OK" } },
          },
        },
      ]),
    );
    const revision = compileOpenApiRevision(
      {
        openapi: "3.1.0",
        info: { title: "Local API", version: "1" },
        paths,
      },
      { definitionId: "local-many-origins" },
    );

    const server = createOpenApiMcpServer({
      revision,
      authority: { accountId: "account-1", workspaceId: "workspace-1" },
      transport: directIntegrationTransport(async () => Response.json({ ok: true })),
    });

    expect(isLocalMcpBridgeServer(server)).toBe(true);
    if (!isLocalMcpBridgeServer(server)) throw new Error("expected local bridge");
    expect(server.bridge.assurance).toBe("revision_descriptive");
    expect(server.bridge.destinations).toHaveLength(40);
    expect(server.bridge.destinations[0]).toEqual({
      origin: "http://127.0.0.1:4100",
      pathPrefix: "/",
    });
  });

  test("describes a conservative origin root when an operation escapes its server base path", async () => {
    const revision = compileOpenApiRevision(
      {
        openapi: "3.1.0",
        info: { title: "Normalized API", version: "1" },
        servers: [{ url: "https://api.example.com/v1/" }],
        paths: {
          "/../admin": {
            get: {
              operationId: "admin",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      },
      { definitionId: "normalized-api" },
    );
    let requestedUrl = "";
    const server = createOpenApiMcpServer({
      revision,
      authority: { accountId: "account-1", workspaceId: "workspace-1" },
      transport: directIntegrationTransport(async (request) => {
        requestedUrl = request.toString();
        return Response.json({ ok: true });
      }),
    });

    await server.callTool(revision.tools[0]!.id, {});
    expect(requestedUrl).toBe("https://api.example.com/admin");
    if (!isLocalMcpBridgeServer(server)) throw new Error("expected local bridge");
    expect(server.bridge.destinations).toEqual([
      { origin: "https://api.example.com", pathPrefix: "/" },
    ]);
  });

  test("does not advertise Connection authority without the credential resolver pair", () => {
    const revision = compileOpenApiRevision(
      {
        openapi: "3.1.0",
        info: { title: "Resolver-less API", version: "1" },
        servers: [{ url: "https://api.example.com/" }],
        paths: {
          "/items": {
            get: {
              operationId: "items",
              responses: { "200": { description: "OK" } },
            },
          },
        },
      },
      { definitionId: "resolver-less" },
    );
    const server = createOpenApiMcpServer({
      revision,
      authority: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        connectionRef: "connection-1",
      },
      transport: directIntegrationTransport(async () => Response.json({ ok: true })),
    });

    if (!isLocalMcpBridgeServer(server)) throw new Error("expected local bridge");
    expect(server.bridge.authority).toBe("none");
  });

  test("selects one adapter and rejects ambiguous provider matches", () => {
    const descriptor = defineLocalMcpBridgeDescriptor({
      adapterId: "example",
      providerId: "example",
      catalogIdentity: "mcp:https://api.example.com/mcp",
      authority: "connection",
      toolSurface: "static_reviewed",
      mutationReplay: "safe_reads_only",
      destinations: [{ origin: "https://api.example.com", pathPrefix: "/v1/" }],
    });
    expect(descriptor.assurance).toBe("static_strict");
    const server: LocalMcpBridgeServer = {
      name: "example",
      cacheToolsList: true,
      bridge: descriptor,
      connect: async () => undefined,
      close: async () => undefined,
      invalidateToolsCache: async () => undefined,
      listTools: async () => [],
      callTool: async () => [],
    };
    const adapter: LocalMcpBridgeAdapter<{ provider: string }, undefined> = {
      adapterId: "example",
      matches: (config) => config.provider === "example",
      create: () => server,
    };

    expect(
      createLocalMcpBridgeFromAdapters([adapter], { provider: "other" }, undefined),
    ).toBeNull();
    expect(createLocalMcpBridgeFromAdapters([adapter], { provider: "example" }, undefined)).toBe(
      server,
    );
    expect(() =>
      createLocalMcpBridgeFromAdapters(
        [adapter, { ...adapter, adapterId: "second" }],
        { provider: "example" },
        undefined,
      ),
    ).toThrow("Multiple local MCP bridge adapters matched");
  });

  test("fails closed on unsafe destination declarations", () => {
    expect(() =>
      defineLocalMcpBridgeDescriptor({
        adapterId: "unsafe",
        providerId: "unsafe",
        catalogIdentity: "unsafe",
        authority: "none",
        toolSurface: "static_reviewed",
        mutationReplay: "safe_reads_only",
        destinations: [{ origin: "http://api.example.com", pathPrefix: "/" }],
      }),
    ).toThrow("exact HTTPS origins");

    expect(() =>
      defineLocalMcpBridgeDescriptor({
        adapterId: "unsafe",
        providerId: "unsafe",
        catalogIdentity: "unsafe",
        authority: "none",
        toolSurface: "static_reviewed",
        mutationReplay: "safe_reads_only",
        destinations: [{ origin: "https://api.example.com", pathPrefix: "/v1/?token=secret" }],
      }),
    ).toThrow("absolute URL path");
  });
});
