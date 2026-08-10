import { describe, expect, test } from "bun:test";
import type { AccessGrant } from "@opengeni/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerEditableArtifactAgentTools } from "../src/mcp/editable-artifacts";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const artifactId = "a".repeat(32);

describe("editable artifact MCP surface", () => {
  test("uses exact signed attempt context and returns CodeMode-compatible structured output", async () => {
    const creates: Array<Record<string, unknown>> = [];
    let authorizationCalls = 0;
    const server = new McpServer({ name: "artifact-test", version: "1" });
    registerEditableArtifactAgentTools({
      server,
      deps: {
        editableArtifactAgent: {
          async create(input: Record<string, unknown>) {
            creates.push(input);
            return metadata("spreadsheet");
          },
        },
      } as never,
      grant: grant(),
      sessionId,
      async authorize() {
        authorizationCalls += 1;
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifact-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "editable_artifact_list",
        "editable_artifact_create",
        "editable_artifact_import",
        "editable_artifact_get",
        "editable_artifact_inspect",
        "editable_artifact_apply",
        "editable_artifact_export",
        "editable_artifact_export_status",
      ]);
      expect(
        listed.tools.find((tool) => tool.name === "editable_artifact_create")?.outputSchema,
      ).toBeTruthy();
      expect(
        listed.tools.find((tool) => tool.name === "editable_artifact_create")?.annotations,
      ).toMatchObject({ destructiveHint: false, idempotentHint: true });
      expect(
        listed.tools.find((tool) => tool.name === "editable_artifact_apply")?.annotations,
      ).toMatchObject({ destructiveHint: true, idempotentHint: true });

      const first = await client.callTool({
        name: "editable_artifact_create",
        arguments: { modality: "spreadsheet", title: "Plan" },
        _meta: { opengeniOperationId: "operation-1" },
      });
      const replay = await client.callTool({
        name: "editable_artifact_create",
        arguments: { modality: "spreadsheet", title: "Plan" },
        _meta: { opengeniOperationId: "operation-1" },
      });

      expect(first.structuredContent).toEqual(metadata("spreadsheet"));
      expect(replay.structuredContent).toEqual(first.structuredContent);
      expect(authorizationCalls).toBe(2);
      expect(creates).toHaveLength(2);
      expect(creates[0]?.idempotencyKey).toBe(creates[1]?.idempotencyKey);
      expect(creates[0]).toMatchObject({
        scope: { accountId, workspaceId },
        sessionId,
        actor: {
          kind: "agent",
          subjectId: "worker:test",
          sessionId,
          turnId,
          attemptId,
          generation: 7,
        },
      });
      expect(String((creates[0]!.actor as { replicaId: string }).replicaId)).toMatch(
        /^[0-9a-f]{16}$/u,
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  test("normalizes kernel bigint and binary projections without losing structure", async () => {
    const server = new McpServer({ name: "artifact-json-test", version: "1" });
    registerEditableArtifactAgentTools({
      server,
      deps: {
        editableArtifactAgent: {
          async inspect() {
            return {
              artifact: metadata("presentation"),
              projection: { revision: 9n, digest: Uint8Array.of(1, 2, 3) },
            };
          },
        },
      } as never,
      grant: grant(),
      sessionId,
      async authorize() {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifact-json-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "editable_artifact_inspect",
        arguments: {
          artifactId,
          modality: "presentation",
          query: { kind: "metadata", maxBytes: 1024 },
        },
      });
      expect(result.structuredContent).toMatchObject({
        projection: {
          revision: "9",
          digest: { encoding: "base64", data: "AQID" },
        },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  test("requires and forwards the exact inspected head for every direct edit", async () => {
    const applies: Array<Record<string, unknown>> = [];
    const server = new McpServer({ name: "artifact-edit-test", version: "1" });
    registerEditableArtifactAgentTools({
      server,
      deps: {
        editableArtifactAgent: {
          async apply(input: Record<string, unknown>) {
            applies.push(input);
            return {
              artifact: { ...metadata("spreadsheet"), headSequence: 1 },
              transaction: {
                id: "c".repeat(32),
                clientTransactionId: "operation-1",
                sequenceStart: 1,
                sequenceEnd: 1,
                stateHash: `sha256:${"d".repeat(64)}`,
                committedAt: "2026-08-10T10:00:01.000Z",
                replayed: false,
              },
            };
          },
        },
      } as never,
      grant: grant(),
      sessionId,
      async authorize() {},
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "artifact-edit-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const command = {
      kind: "sheet.create",
      sheetId: "1".repeat(32),
      name: "Data",
      after: null,
    };
    try {
      const missingFence = await client.callTool({
        name: "editable_artifact_apply",
        arguments: { artifactId, modality: "spreadsheet", commands: [command] },
      });
      expect(missingFence.isError).toBe(true);
      expect(applies).toHaveLength(0);

      const result = await client.callTool({
        name: "editable_artifact_apply",
        arguments: {
          artifactId,
          modality: "spreadsheet",
          expectedHeadSequence: 0,
          expectedStateHash: `sha256:${"b".repeat(64)}`,
          commands: [command],
        },
        _meta: { opengeniOperationId: "operation-1" },
      });
      expect(result.isError).not.toBe(true);
      expect(applies).toHaveLength(1);
      expect(applies[0]).toMatchObject({
        expectedHeadSequence: 0,
        expectedStateHash: `sha256:${"b".repeat(64)}`,
        batch: { modality: "spreadsheet", commands: [command] },
      });
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

function grant(): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "worker:test",
    permissions: ["artifacts:read", "artifacts:publish", "files:read", "files:upload"],
    principalKind: "agent_attempt",
    metadata: { sessionId, turnId, attemptId, executionGeneration: 7 },
  };
}

function metadata(modality: "spreadsheet" | "document" | "presentation") {
  return {
    id: artifactId,
    modality,
    title: "Plan",
    lifecycle: "active" as const,
    headSequence: 0,
    stateHash: `sha256:${"b".repeat(64)}`,
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  };
}
