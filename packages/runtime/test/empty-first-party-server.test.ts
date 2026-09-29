import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { withoutEmptyFirstPartyMcpServer } from "../src/index";

const settings = testSettings({
  mcpServers: [
    {
      id: "opengeni",
      url: "https://api.example.test/v1/workspaces/{workspaceId}/mcp",
      cacheToolsList: false,
    },
    {
      id: "files",
      url: "https://api.example.test/v1/workspaces/{workspaceId}/files/mcp",
      cacheToolsList: false,
    },
    { id: "product", url: "https://product.example.test/mcp", cacheToolsList: false },
  ],
});
const refs = [
  { kind: "mcp" as const, id: "opengeni" },
  { kind: "mcp" as const, id: "files" },
  { kind: "mcp" as const, id: "product", eager: true },
];

describe("withoutEmptyFirstPartyMcpServer", () => {
  test("an explicit empty remote selection skips only the first-party opengeni server", () => {
    expect(withoutEmptyFirstPartyMcpServer(settings, refs, []).map((ref) => ref.id)).toEqual([
      "files",
      "product",
    ]);
  });

  test("a default or non-empty selection keeps it", () => {
    expect(withoutEmptyFirstPartyMcpServer(settings, refs, undefined)).toBe(refs);
    expect(withoutEmptyFirstPartyMcpServer(settings, refs, ["goal_set"])).toBe(refs);
  });
});
