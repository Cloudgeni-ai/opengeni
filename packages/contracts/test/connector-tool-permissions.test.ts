import { describe, expect, test } from "bun:test";
import { UpdateConnectorToolPermissionsRequest } from "../src/connector-tool-permissions";
import {
  SessionMcpToolPermissionsQuery,
  UpdateSessionMcpToolPermissionsRequest,
} from "../src/session-mcp-tool-permissions";

test("an explicit permission update can name the full catalog allowance", () => {
  const request = {
    connectionId: "connection",
    target: "tools",
    permission: "ask",
    toolNames: Array.from({ length: 4096 }, (_, index) => `tool_${index}`),
  };
  expect(UpdateConnectorToolPermissionsRequest.safeParse(request).success).toBe(true);
  expect(
    UpdateConnectorToolPermissionsRequest.safeParse({
      ...request,
      toolNames: [...request.toolNames, "extra"],
    }).success,
  ).toBe(false);
});

test("connector defaults require an explicit target and cannot be named as tool overrides", () => {
  const common = { connectionId: "connection", permission: "allow" };
  expect(
    UpdateConnectorToolPermissionsRequest.safeParse({ ...common, target: "default" }).success,
  ).toBe(true);
  expect(
    UpdateConnectorToolPermissionsRequest.safeParse({
      ...common,
      target: "tools",
      toolNames: ["read_item"],
    }).success,
  ).toBe(true);
  for (const selection of [
    { toolNames: ["*"] },
    { target: "tools", toolNames: [" * "] },
    { target: "tools", toolNames: ["\t*\n"] },
    { target: "tools", toolNames: [" read_item "] },
    { target: "tools", toolNames: ["*"] },
    { target: "tools", toolNames: ["read_item", "*"] },
    { target: "default", toolNames: ["read_item"] },
    { target: "default", toolNames: ["*"] },
  ]) {
    expect(
      UpdateConnectorToolPermissionsRequest.safeParse({ ...common, ...selection }).success,
    ).toBe(false);
  }
});

describe("session MCP tool permission contracts", () => {
  const server = { serverId: "cloudgeni-capability", url: "https://host.example.test/mcp" };
  test("accept exact tool and default targets", () => {
    expect(
      UpdateSessionMcpToolPermissionsRequest.safeParse({
        ...server,
        target: "tools",
        toolNames: ["a"],
        permission: "block",
      }).success,
    ).toBe(true);
    expect(
      UpdateSessionMcpToolPermissionsRequest.safeParse({
        ...server,
        target: "default",
        permission: null,
      }).success,
    ).toBe(true);
  });
  test("reject wildcards, padded names, bad ids, non-http urls and unknown keys", () => {
    for (const body of [
      { ...server, target: "tools", toolNames: ["*"], permission: "allow" },
      { ...server, target: "tools", toolNames: [" a"], permission: "allow" },
      { ...server, serverId: "bad id", target: "default", permission: "allow" },
      { ...server, url: "file:///etc/passwd", target: "default", permission: "allow" },
      { ...server, target: "default", permission: "allow", connectionId: "x" },
    ]) {
      expect(UpdateSessionMcpToolPermissionsRequest.safeParse(body).success).toBe(false);
    }
    expect(SessionMcpToolPermissionsQuery.safeParse({ ...server, extra: 1 }).success).toBe(false);
  });
});
