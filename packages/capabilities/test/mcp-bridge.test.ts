import { describe, expect, test } from "bun:test";

import {
  createLocalMcpBridgeFromAdapters,
  defineLocalMcpBridgeDescriptor,
  type LocalMcpBridgeAdapter,
  type LocalMcpBridgeServer,
} from "../src";

describe("local MCP bridge kit", () => {
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

  test("keeps reviewed static descriptors on exact HTTPS destinations", () => {
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

    expect(() =>
      defineLocalMcpBridgeDescriptor({
        adapterId: "too-many",
        providerId: "too-many",
        catalogIdentity: "too-many",
        authority: "none",
        toolSurface: "static_reviewed",
        mutationReplay: "safe_reads_only",
        destinations: Array.from({ length: 33 }, (_, index) => ({
          origin: `https://api-${index}.example.com`,
          pathPrefix: "/",
        })),
      }),
    ).toThrow("1-32 provider destinations");
  });
});
