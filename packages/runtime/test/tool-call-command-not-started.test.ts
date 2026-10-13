import { describe, expect, test } from "bun:test";
import { ToolCallError } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import { ModalCommandStartPreDispatchUnavailableError } from "../src/sandbox/providers/modal-command-router-wire";
import { isModalTaskExecStartPreDispatchUnavailableError } from "../src/sandbox/providers/modal";
import {
  ToolCallCommandNotStartedError,
  toolCallCommandNotStartedCallIds,
  withCommandNotStartedCallProof,
} from "../src/sandbox/tool-call-command-not-started";
import { buildAgentCapabilities } from "../src/index";

async function preDispatchProof(): Promise<Error> {
  return await ModalCommandStartPreDispatchUnavailableError.ensureReady({
    waitForReady: (_deadline: number, callback: (error: Error) => void) =>
      callback(new Error("router not ready")),
  } as never).catch((failure: Error) => failure);
}

function execTool(
  options: Parameters<typeof buildAgentCapabilities>[2] = {},
  execCommand: () => Promise<string>,
) {
  const caps = buildAgentCapabilities(testSettings({ sandboxBackend: "modal" }), [], options);
  const shell = caps.find((cap) => cap.type === "shell")!;
  const tool = shell
    .clone()
    .bind({ execCommand } as never)
    .tools()
    .find((candidate) => candidate.name === "exec_command");
  if (!tool || tool.type !== "function") throw new Error("No shell tool");
  return tool;
}

const toolCall = {
  type: "function_call" as const,
  callId: "call-exec",
  name: "exec_command",
  arguments: JSON.stringify({ cmd: "true" }),
};

describe("exec_command not-started proof", () => {
  for (const [label, options] of [
    ["plain", {}],
    ["with the turn cancellation fence", { turnCancellationSignal: new AbortController().signal }],
  ] as const) {
    test(`the production exec_command binds pre-dispatch proof to its call (${label})`, async () => {
      const proof = await preDispatchProof();
      const tool = execTool(options, async () => {
        throw proof;
      });
      const failure = await tool
        .invoke({} as never, toolCall.arguments, { toolCall } as never)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ToolCallCommandNotStartedError);
      expect((failure as ToolCallCommandNotStartedError).callId).toBe("call-exec");
      // Same-turn recovery still classifies the tagged failure.
      expect(isModalTaskExecStartPreDispatchUnavailableError(failure)).toBe(true);
      expect(toolCallCommandNotStartedCallIds(failure)).toEqual(["call-exec"]);
      // The SDK's own wrapper keeps the call identity readable.
      const sdkWrapped = new ToolCallError("Error running tool", failure as Error);
      expect(toolCallCommandNotStartedCallIds(sdkWrapped)).toEqual(["call-exec"]);
    });
  }

  test("a started or ambiguous command is never tagged", async () => {
    const tool = execTool({}, async () => {
      throw Object.assign(new Error("14 UNAVAILABLE: Name resolution failed"), { code: 14 });
    });
    const output = await tool
      .invoke({} as never, toolCall.arguments, { toolCall } as never)
      .catch((error: unknown) => error);
    expect(output).not.toBeInstanceOf(ToolCallCommandNotStartedError);
    expect(toolCallCommandNotStartedCallIds(output)).toEqual([]);
  });

  test("only exec_command with a call identity is wrapped", async () => {
    const proof = await preDispatchProof();
    const invoke = async () => {
      throw proof;
    };
    const other = { type: "function", name: "apply_patch", invoke };
    expect(withCommandNotStartedCallProof(other)).toBe(other);
    const exec = withCommandNotStartedCallProof({ type: "function", name: "exec_command", invoke });
    await expect(exec.invoke!({} as never, "{}")).rejects.toBe(proof);
    await expect(
      exec.invoke!({} as never, "{}", { toolCall: { callId: "" } } as never),
    ).rejects.toBe(proof);
  });

  test("lookalikes and unproven causes never name a call", async () => {
    const proof = await preDispatchProof();
    expect(
      toolCallCommandNotStartedCallIds(
        new ToolCallCommandNotStartedError("call-exec", new Error("router not ready")),
      ),
    ).toEqual([]);
    expect(
      toolCallCommandNotStartedCallIds(
        Object.assign(new Error("lookalike", { cause: proof }), {
          name: "ToolCallCommandNotStartedError",
          callId: "call-exec",
        }),
      ),
    ).toEqual([]);
    // A second, ambiguous failure in the same chain vetoes every call.
    const mixed = new AggregateError([
      new ToolCallCommandNotStartedError("call-exec", proof),
      Object.assign(new Error("14 UNAVAILABLE"), { code: 14 }),
    ]);
    expect(toolCallCommandNotStartedCallIds(mixed)).toEqual([]);
  });
});
