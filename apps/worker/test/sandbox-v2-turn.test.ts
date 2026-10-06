import { expect, test } from "bun:test";
import {
  assertLegacySandboxTurnRoute,
  SandboxV2TurnUnavailableError,
} from "../src/sandbox-v2-turn";
import { createSandboxV2ShellBinding } from "../src/sandbox-v2-shell";

test("retained machine groups stop before the legacy turn path", () => {
  const route = {
    engine: "machine-v2" as const,
    sandboxGroupId: crypto.randomUUID(),
    machineId: crypto.randomUUID(),
    provider: "synthetic",
  };
  try {
    assertLegacySandboxTurnRoute(route);
    throw new Error("Expected retained-engine rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxV2TurnUnavailableError);
    expect((error as SandboxV2TurnUnavailableError).code).toBe("SANDBOX_V2_TURN_UNAVAILABLE");
    expect((error as SandboxV2TurnUnavailableError).route).toEqual(route);
  }
  expect(() =>
    assertLegacySandboxTurnRoute({ engine: "legacy", sandboxGroupId: crypto.randomUUID() }),
  ).not.toThrow();
});

test("native editor methods and function tools require their accepted invocation before I/O", async () => {
  let calls = 0;
  const machineId = crypto.randomUUID();
  const instance = {
    id: "synthetic-editor",
    bootId: "a".repeat(64),
    diskLineage: crypto.randomUUID(),
  };
  const options = {
    provider: "synthetic",
    machineId,
    instance,
    environment: async () => {
      calls++;
      return {};
    },
    transport: {
      exec: async () => {
        calls++;
        throw Error("Unexpected provider call");
      },
    },
    capabilities: { stdin: true, pty: false },
  };
  const binding = createSandboxV2ShellBinding(
    {} as never,
    {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      executionGeneration: 1,
      machineId,
      instance,
    },
    options,
  );
  const editor = binding.session.createEditor!();
  await expect(
    editor.createFile({ type: "create_file", path: "test.txt", diff: "invalid" }),
  ).rejects.toThrow("accepted tool action");
  await expect(
    editor.updateFile({ type: "update_file", path: "test.txt", diff: "@@\n-a\n+b\n" }),
  ).rejects.toThrow("accepted tool action");
  await expect(editor.deleteFile({ type: "delete_file", path: "test.txt" })).rejects.toThrow(
    "accepted tool action",
  );
  const tools = binding.filesystemCapability.clone().bind(binding.session).tools();
  const patch = tools.find((tool) => tool.type === "function" && tool.name === "apply_patch");
  if (!patch || patch.type !== "function") throw Error("Expected patch function");
  const input = JSON.stringify({ operation: { type: "delete_file", path: "test.txt" } });
  await expect(patch.invoke({} as never, input)).rejects.toThrow("exact accepted input");
  await expect(
    patch.invoke({} as never, input, {
      toolCall: {
        type: "function_call",
        name: "apply_patch",
        callId: "synthetic-call",
        arguments: "changed",
      },
    }),
  ).rejects.toThrow("exact accepted input");
  expect(calls).toBe(0);
  const withoutStdin = createSandboxV2ShellBinding({} as never, {} as never, {
    ...options,
    capabilities: { stdin: false, pty: false },
  });
  expect(withoutStdin.capabilities.map((capability) => capability.type)).toEqual(["shell"]);
});
