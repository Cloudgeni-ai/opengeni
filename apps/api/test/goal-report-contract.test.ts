import { describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { DEFAULT_FIRST_PARTY_MCP_TOOLS, type AccessGrant } from "@opengeni/contracts";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import { z } from "zod";

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
  test("evidence has an explicit character cap without stripping spaces", () => {
    const schema = tools().goal_complete!.inputSchema;
    const evidence = " normal proof ".repeat(500);
    expect(schema.safeParse({ evidence }).data).toEqual({ evidence });
    expect(schema.safeParse({ evidence: "x".repeat(8192) }).success).toBe(true);
    expect(schema.safeParse({ evidence: "x".repeat(8193) }).success).toBe(false);
  });
  test("every goal-tool text limit and purpose is model-visible, with normal spacing preserved", () => {
    const registered = tools();
    for (const [toolName, field, cap] of [
      ["goal_set", "text", 8192],
      ["goal_set", "successCriteria", 8192],
      ["goal_update", "text", 8192],
      ["goal_update", "rationale", 2048],
      ["goal_progress", "progressNote", 8192],
      ["goal_pause", "rationale", 2048],
      ["wait_for_input", "reason", 2048],
    ] as const) {
      const schema = registered[toolName]!.inputSchema as unknown as z.ZodType;
      const json = z.toJSONSchema(schema, { unrepresentable: "any" });
      const property = (
        json.properties as Record<string, { maxLength?: number; description?: string }>
      )[field]!;
      expect(property.maxLength).toBe(cap);
      expect(property.description).toContain(`${cap} UTF-8 bytes`);
      expect(property.description).toMatch(/normal spac/);
    }
    const progress = registered.goal_progress!.inputSchema;
    const status = "Milestone verified with normal spaces. ".repeat(150);
    expect(status.length).toBeGreaterThan(4096);
    expect(progress.safeParse({ progressNote: status, idempotencyKey: id }).data).toEqual({
      progressNote: status,
      idempotencyKey: id,
    });
    expect(progress.safeParse({ progressNote: "x".repeat(8192), idempotencyKey: id }).success).toBe(
      true,
    );
    expect(progress.safeParse({ progressNote: "x".repeat(8193), idempotencyKey: id }).success).toBe(
      false,
    );
    expect(
      progress.safeParse({ progressNote: "界".repeat(2731), idempotencyKey: id }).success,
    ).toBe(false);
    const reportSchema = z.toJSONSchema(registered.goal_set!.inputSchema as unknown as z.ZodType, {
      unrepresentable: "any",
    });
    expect(JSON.stringify(reportSchema)).toContain("Short human-readable report title");
    expect(JSON.stringify(reportSchema)).toContain('"maxLength":512');
  });
});
