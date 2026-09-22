import { expect, test } from "bun:test";
import type { MCPServer } from "@openai/agents";
import { PrefixedMcpServer, prepareAgentTools } from "../src/index";
import { startTestMcpServer, testSettings } from "@opengeni/testing";

test("account routes expose labels with independent tool snapshots and dispatch", async () => {
  const calls: string[] = [];
  const create = (route: string, label: string) => {
    const inner = {
      cacheToolsList: false,
      name: "same-provider",
      connect: async () => {},
      close: async () => {},
      listTools: async () => [
        {
          name: "read",
          description: "Read inbox",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      callTool: async () => {
        calls.push(route);
        return [];
      },
    } as MCPServer;
    return new PrefixedMcpServer(
      inner,
      route,
      undefined,
      false,
      undefined,
      route,
      false,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      label,
    );
  };
  const personal = create("mail-personal", "Personal: Alice");
  const workspace = create("mail-workspace", "Workspace: Team");
  const [a] = await personal.listTools();
  const [b] = await workspace.listTools();
  expect(a?.description).toContain("Account: Personal: Alice.");
  expect(b?.description).toContain("Account: Workspace: Team.");
  expect(a?.description).toContain(
    "if the intended account for a write is unclear, ask before calling",
  );
  expect(a?.description).toContain("Read inbox");
  expect(a?.name).not.toBe(b?.name);
  expect(personal.name).not.toBe(workspace.name);
  expect(personal.cacheToolsList).toBe(false);
  await personal.callTool(a!.name, {});
  await workspace.callTool(b!.name, {});
  expect(calls).toEqual(["mail-personal", "mail-workspace"]);
});

test("same-endpoint accounts never share credential or schema caches", async () => {
  const authorizations: string[] = [];
  const mcp = startTestMcpServer({
    validateAuthorization: (authorization) => {
      authorizations.push(authorization ?? "missing");
      return authorization === "Bearer personal" || authorization === "Bearer workspace";
    },
    toolsForAuthorization: (authorization) =>
      authorization === "Bearer personal" ? ["personal_only"] : ["workspace_only"],
  });
  const ids = ["personal", "workspace"];
  try {
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: ids.map((id) => ({
          id,
          url: mcp.url,
          connectionRef: { connectionId: id, providerDomain: "127.0.0.1" },
        })),
      }),
      ids.map((id) => ({ kind: "mcp", id })),
      {
        workspaceId: crypto.randomUUID(),
        resolveCredential: async (request) => {
          expect(request.connectionRef.connectionId).toBe(request.serverId);
          return {
            status: "ok",
            connectionId: request.serverId,
            headers: { authorization: `Bearer ${request.serverId}` },
          };
        },
      },
    );
    try {
      const [personal, workspace] = await Promise.all(
        prepared.mcpServers.map((server) => server.listTools()),
      );
      expect(personal!.map((tool) => tool.name)).toContain("personal__personal_only");
      expect(personal!.map((tool) => tool.name)).not.toContain("personal__workspace_only");
      expect(workspace!.map((tool) => tool.name)).toContain("workspace__workspace_only");
      authorizations.length = 0;
      await prepared.mcpServers[0]!.callTool("personal__personal_only", {});
      expect(authorizations.length).toBeGreaterThan(0);
      expect(authorizations.every((value) => value === "Bearer personal")).toBe(true);
      authorizations.length = 0;
      await prepared.mcpServers[1]!.callTool("workspace__workspace_only", {});
      expect(authorizations.length).toBeGreaterThan(0);
      expect(authorizations.every((value) => value === "Bearer workspace")).toBe(true);
    } finally {
      await prepared.close();
    }
  } finally {
    mcp.close();
  }
});
