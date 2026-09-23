import { describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { DEFAULT_FIRST_PARTY_MCP_TOOLS, type AccessGrant } from "@opengeni/contracts";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

const id = "11111111-1111-4111-8111-111111111111";
const report = { id: "report", title: "Requested report" };

function tools() {
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
  return (
    server as unknown as {
      _registeredTools: Record<
        string,
        {
          inputSchema: { safeParse(input: unknown): { success: boolean; data?: unknown } };
        }
      >;
    }
  )._registeredTools;
}

describe("goal MCP report field contracts", () => {
  test("direct and secondary declarations use typed persisted requirements", () => {
    const registered = tools();
    expect(
      registered.goal_set!.inputSchema.safeParse({
        text: "Write report",
        reportRequirements: [report],
      }).success,
    ).toBe(true);
    expect(
      registered.goal_progress!.inputSchema.safeParse({
        progressNote: "Secondary report needed",
        idempotencyKey: id,
        reportRequirements: [report],
      }).success,
    ).toBe(true);
    expect(
      registered.goal_set!.inputSchema.safeParse({
        text: "Write report",
        reportRequirements: [{ title: "No ID" }],
      }).success,
    ).toBe(false);
    expect(
      registered.goal_progress!.inputSchema.safeParse({
        progressNote: "Report",
        idempotencyKey: id,
        reportRequirements: [report, report],
      }).success,
    ).toBe(false);
  });
  test("completion accepts proof references, never self-asserted inspection", () => {
    const schema = tools().goal_complete!.inputSchema;
    expect(schema.safeParse({ evidence: "Non-report task done" }).success).toBe(true);
    expect(
      schema.safeParse({
        evidence: "Report delivered",
        reportDeliveries: [
          { requirementId: report.id, artifactId: "a".repeat(32), inspectionReceiptId: id },
        ],
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        evidence: "Report delivered",
        reportDeliveries: [
          { requirementId: report.id, artifactId: "a".repeat(32), inspected: true },
        ],
      }).success,
    ).toBe(false);
  });
});
