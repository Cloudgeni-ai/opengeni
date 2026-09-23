// Executed only by mcp-operation-lifecycle.test.ts in a fresh Bun process.
// This is an adapter-process fixture, not a Temporal/whole-worker boot test.
import { RunContext } from "@openai/agents-core";
import type { Settings } from "@opengeni/config";
import { createDb, getSessionTurnForAttempt } from "@opengeni/db";
import {
  buildOpenGeniAgent,
  prepareAgentTools,
  type ResolveConnectionCredentialResult,
} from "@opengeni/runtime";
import {
  createMcpOperationPersistence,
  type McpOperationAttempt,
} from "../../../packages/db/src/mcp-operations";
import { createMcpOperationReadStore } from "../src/activities/mcp-operation-store";
import { readMcpOperation } from "../src/activities/mcp-operation-reader";
import { createMcpOperationObserverResolver } from "../src/activities/mcp-operation-observer";

const input = (await new Response(Bun.stdin.stream()).json()) as {
  mode: "mutate" | "read";
  appUrl: string;
  settings: Settings;
  attempt: McpOperationAttempt;
  sourceCallId: string;
  sourceTurnId: string;
  arguments?: Record<string, unknown>;
};
const client = createDb(input.appUrl);
const connectorActionPolicy = {
  prepare: async () => ({ managed: false as const, decision: "unmanaged" as const }),
  begin: async () => ({ allowed: true as const, managed: false as const }),
  complete: async () => {},
};
// Explicit fixture trust boundary: only credentials are synthetic. Each fresh
// process derives authorization and operation state through the real DB APIs.
const resolveSyntheticCredential = async (): Promise<ResolveConnectionCredentialResult> => ({
  status: "ok",
  connectionId: "lifecycle-test-connection",
  headers: {},
  operationAuthorityDigest: "a".repeat(64),
  authorizeProviderRequest: async () => true,
});
let prepared: Awaited<ReturnType<typeof prepareAgentTools>> | undefined;
try {
  prepared = await prepareAgentTools(input.settings, [{ kind: "mcp", id: "lifecycle" }], {
    ...input.attempt,
    workspaceToolGateway: {},
    connectorActionPolicy,
    resolveCredential: resolveSyntheticCredential,
    mcpOperationPersistence: createMcpOperationPersistence(client.db, input.attempt),
  });
  let output: unknown;
  if (input.mode === "mutate") {
    if (!input.arguments) throw new Error("Mutation fixture arguments missing");
    const agent = buildOpenGeniAgent(input.settings, [], { mcpServers: prepared.mcpServers });
    const tool = (await agent.getMcpTools(new RunContext())).find(
      (entry) => entry.type === "function" && entry.name === "lifecycle__mutate",
    );
    if (!tool || tool.type !== "function") throw new Error("Mutation SDK tool unavailable");
    if (await tool.needsApproval(new RunContext(), input.arguments, input.sourceCallId)) {
      throw new Error("Unexpected fixture approval requirement");
    }
    output = await tool.invoke(new RunContext(), JSON.stringify(input.arguments), {
      toolCall: { callId: input.sourceCallId },
    } as never);
  } else if (input.mode === "read") {
    const currentPrepared = prepared;
    const deps = {
      ...createMcpOperationReadStore(client.db, input.attempt),
      resolveObserver: createMcpOperationObserverResolver({
        settings: input.settings,
        workspaceId: input.attempt.workspaceId,
        resolveCredential: resolveSyntheticCredential,
        assertAttempt: async () => {
          const current = await getSessionTurnForAttempt(
            client.db,
            input.attempt.workspaceId,
            input.attempt.sessionId,
            input.attempt.attemptId,
          );
          if (
            !current ||
            current.id !== input.attempt.turnId ||
            current.executionGeneration !== input.attempt.executionGeneration
          ) {
            throw new Error("Stale subprocess attempt");
          }
        },
        getEnvironment: async () => currentPrepared.attemptToolEnvironment ?? null,
      }),
    };
    const selector = { sourceTurnId: input.sourceTurnId, sourceCallId: input.sourceCallId };
    output = {
      first: await readMcpOperation(selector, deps),
      cached: await readMcpOperation(selector, deps),
    };
  } else {
    throw new Error("Invalid lifecycle fixture mode");
  }
  console.log(`MCP_LIFECYCLE_RESULT:${JSON.stringify({ pid: process.pid, output })}`);
} finally {
  await prepared?.close();
  await client.close();
}
