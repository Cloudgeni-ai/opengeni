import { expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { DEFAULT_FIRST_PARTY_MCP_TOOLS, type AccessGrant } from "@opengeni/contracts";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

const id = "11111111-1111-4111-8111-111111111111";

test("goal_resume tells the agent that a question alone does not resume a paused goal", () => {
  const server = buildOpenGeniMcpServer(
    {
      settings: testSettings({ databaseUrl: "postgres://unused:unused@127.0.0.1:1/unused" }),
      db: {},
      bus: new MemoryEventBus(),
      workflowClient: {},
      objectStorage: null,
      githubStateSecret: "test",
      documentIndexer: {},
      getDocumentServices: () => ({}),
    } as unknown as ApiRouteDeps,
    {
      accountId: id,
      workspaceId: id,
      subjectId: "worker:test",
      principalKind: "agent_attempt",
      permissions: ["workspace:admin"],
      metadata: {
        sessionId: id,
        turnId: id,
        attemptId: id,
        executionGeneration: 1,
        firstPartyMcpTools: [...DEFAULT_FIRST_PARTY_MCP_TOOLS],
      },
    } as AccessGrant,
  );
  const registered = (
    server as unknown as { _registeredTools: Record<string, { description?: string }> }
  )._registeredTools;
  const description = registered.goal_resume?.description ?? "";
  expect(description).toContain("when the user asks you to continue");
  expect(description).toContain("A user's question alone is not a reason to resume");
  expect(description).toContain("Already active is a successful no-op");
});
