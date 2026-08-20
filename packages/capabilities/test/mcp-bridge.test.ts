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
      transport: directIntegrationTransport(async () => Response.json({ files: [] })),
    });

    expect(isLocalMcpBridgeServer(server)).toBe(true);
    if (!isLocalMcpBridgeServer(server)) throw new Error("expected local bridge");
    expect(server.bridge).toEqual({
      contractVersion: LOCAL_MCP_BRIDGE_CONTRACT_VERSION,
      adapterId: "openapi",
      providerId: "google",
      catalogIdentity: `integration-definition:google-drive@${revision.id}`,
      transport: "in_process",
      authority: "connection",
      toolSurface: "immutable_revision",
      mutationReplay: "safe_reads_only",
      destinations: [{ origin: "https://www.googleapis.com", pathPrefix: "/drive/v3/" }],
    });
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
