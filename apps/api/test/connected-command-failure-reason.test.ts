import { expect, test } from "bun:test";
import { AgentEvent, OperationCompleted } from "@opengeni/agent-proto";
import type { Database } from "@opengeni/db";
import type { Observability } from "@opengeni/observability";
import type { ConnectedCommandCompletionLocator } from "../src/sandbox/completion-locator";
import { handleAgentEventPayload } from "../src/sandbox/metrics-ingestion";

// Telemetry exports only reviewed attribute keys, so a warning's error text
// never leaves the process. A failed completion must still say why it failed.
test("a completion that cannot be settled logs its typed reason", async () => {
  const warnings: Array<{ message: string; attributes: Record<string, unknown> }> = [];
  const observability = {
    warn: (message: string, attributes: Record<string, unknown>) => {
      warnings.push({ message, attributes });
    },
  } as unknown as Observability;
  const locate = (async () => ({
    commandId: "11111111-1111-4111-8111-111111111111",
    terminal: false,
  })) as unknown as ConnectedCommandCompletionLocator;
  const payload = AgentEvent.encode({
    agentId: "",
    event: {
      $case: "operationCompleted",
      operationCompleted: OperationCompleted.fromPartial({
        opId: "command-op",
        exit: { exitCode: 0 },
      }),
    },
  }).finish();
  // No output transport: the exit cannot be collected.
  await handleAgentEventPayload(
    {} as Database,
    observability,
    payload,
    "agent.workspace-1.agent-1.connection.connection-1.events",
    undefined,
    undefined,
    locate,
  );
  expect(warnings).toEqual([
    {
      message: "Failed to settle a Connected Machine completion event",
      attributes: expect.objectContaining({ reason: "output_transport_unavailable" }),
    },
  ]);
});
