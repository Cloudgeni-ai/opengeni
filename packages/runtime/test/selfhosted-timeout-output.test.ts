import { expect, test } from "bun:test";
import { ErrorCode } from "@opengeni/agent-proto";
import { normalizeSdkEvent } from "../src/run-events";
import {
  FakeOpRunner,
  InMemoryOpStreamTransport,
  RoutingSandboxSession,
  SelfhostedSession,
} from "../src/sandbox";

test("routed timeout preserves the agent's uncertainty text and marks the audit event failed", async () => {
  const transport = new InMemoryOpStreamTransport();
  const runner = new FakeOpRunner({
    transport,
    workspaceId: "workspace",
    agentId: "machine",
    connectionInstanceId: "process",
    defaultScript: () => ({
      frames: [],
      startError: {
        code: ErrorCode.ERROR_CODE_TIMEOUT,
        message: "the agent did not respond in time",
        retryable: true,
        detail: {},
      },
    }),
  });
  const session = new SelfhostedSession({
    workspaceId: "workspace",
    agentId: "machine",
    connectionInstanceId: "process",
    workspaceRoot: "/tmp",
    controlRpc: runner,
    opStream: { transport },
    relay: { host: "localhost", port: 443, tls: true },
    retryClock: { sleep: async () => {}, jitter: () => 0 },
  });
  const resolved = { session, kind: "selfhosted" as const, sandboxId: null };
  const route = new RoutingSandboxSession({
    defaultResolved: resolved,
    readPointer: async () => ({ activeSandboxId: null, activeEpoch: 0 }),
    resolveActiveBackend: async () => resolved,
  });
  const output = await route.execCommand({ cmd: "fixture command" });
  expect(output).toContain("may or may not have run");
  expect(output).toContain("check whether it already took effect before re-running it");
  const [event] = normalizeSdkEvent({
    type: "run_item_stream_event",
    item: {
      type: "tool_call_output_item",
      rawItem: { type: "function_call_result", callId: "fixture-call" },
      output,
    },
  } as never);
  expect(event).toEqual({
    type: "agent.toolCall.output",
    payload: { id: "fixture-call", output, error: true },
  });
});

test("normal command output and trusted replacements do not gain an error flag", () => {
  const input = {
    type: "run_item_stream_event",
    item: {
      type: "tool_call_output_item",
      rawItem: { type: "function_call_result", callId: "fixture-call" },
      output: "Process exited with code 0\nOutput:\noutcome unknown",
    },
  } as const;
  expect(normalizeSdkEvent(input as never)[0]?.payload).toEqual({
    id: "fixture-call",
    output: input.item.output,
  });
  expect(
    normalizeSdkEvent(input as never, { toolOutputOverride: "replacement" })[0]?.payload,
  ).toEqual({
    id: "fixture-call",
    output: "replacement",
  });
});
