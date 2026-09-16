import { expect, test } from "bun:test";
import { prepareAgentTools } from "../src";
import { startTestMcpServer, testSettings } from "@opengeni/testing";

test("native connection revocation at the physical MCP fence sends no provider request", async () => {
  const mcp = startTestMcpServer();
  const connectionId = crypto.randomUUID();
  let checks = 0;
  let resolutions = 0;
  const authNeeded: unknown[] = [];
  try {
    const prepared = await prepareAgentTools(
      testSettings({
        mcpServers: [
          {
            id: "native-fence",
            name: "Native connection fence",
            url: mcp.url,
            connectionRef: { connectionId, providerDomain: new URL(mcp.url).hostname },
            cacheToolsList: false,
          },
        ],
      }),
      [{ kind: "mcp", id: "native-fence" }],
      {
        workspaceId: crypto.randomUUID(),
        resolveCredential: async () => {
          resolutions++;
          return {
            status: "ok",
            connectionId,
            headers: { authorization: "Bearer synthetic" },
            authorizeProviderRequest: async () => {
              checks++;
              return false;
            },
          };
        },
        onAuthNeeded: (payload) => authNeeded.push(payload),
      },
    );
    try {
      expect(prepared.mcpServers).toHaveLength(0);
      expect(checks).toBeGreaterThanOrEqual(1);
      expect(resolutions).toBe(1);
      expect(mcp.requests).toHaveLength(0);
      expect(authNeeded).toContainEqual(
        expect.objectContaining({
          serverId: "native-fence",
          reason: "personal_authority_unavailable",
        }),
      );
    } finally {
      await prepared.close();
    }
  } finally {
    mcp.close();
  }
});
