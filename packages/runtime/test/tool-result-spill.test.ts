import { describe, expect, test } from "bun:test";
import type { AttemptToolExecutionContext } from "@opengeni/codemode";
import {
  TOOL_RESULT_SPILL_MEDIA_TYPE,
  toolResultSpillFilename,
  toolResultSpillSandboxPath,
  type AttemptToolResult,
} from "@opengeni/contracts";
import { MCP_MAX_TOOL_RESULT_BYTES } from "../src/mcp-network";
import {
  modelToolResultOverflowError,
  projectAttemptToolResultForCaller,
  wrapAttemptToolDefinitions,
  wrapAttemptToolExecute,
  type SpillOversizedModelToolResult,
} from "../src/tool-result-spill";

const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function context(kind: "model" | "codemode"): AttemptToolExecutionContext {
  return {
    operationId: OPERATION_ID,
    caller: { kind, subjectId: kind === "codemode" ? "codemode:test" : "worker:mcp-model" },
  };
}

function smallResult(): AttemptToolResult {
  return {
    content: [{ type: "text", text: "ok" }],
    structuredContent: { ok: true },
  };
}

function oversizedResult(): AttemptToolResult {
  return {
    content: [{ type: "text", text: "x".repeat(MCP_MAX_TOOL_RESULT_BYTES + 1) }],
  };
}

describe("attempt tool result caller projection", () => {
  test("names spilled files from the operation UUID", () => {
    expect(toolResultSpillFilename(OPERATION_ID)).toBe(`${OPERATION_ID}.json`);
    expect(toolResultSpillFilename(OPERATION_ID.toUpperCase())).toBe(`${OPERATION_ID}.json`);
    expect(toolResultSpillSandboxPath(`${OPERATION_ID}.json`)).toBe(
      `/workspace/tool-results/${OPERATION_ID}.json`,
    );
    expect(() => toolResultSpillFilename("not-a-uuid")).toThrow(/lowercase UUID/);
  });
  test("Codemode caller keeps a result larger than the 1 MiB model cap", async () => {
    const result = oversizedResult();
    const projected = await projectAttemptToolResultForCaller(result, context("codemode"));
    expect(projected).toBe(result);
    expect(projected.isError).toBeUndefined();
  });

  test("model caller returns a fitting result unchanged", async () => {
    const result = smallResult();
    expect(await projectAttemptToolResultForCaller(result, context("model"))).toBe(result);
  });

  test("model caller without a spill port returns result_too_large", async () => {
    const projected = await projectAttemptToolResultForCaller(oversizedResult(), context("model"));
    expect(projected).toEqual(modelToolResultOverflowError());
    expect(JSON.stringify(projected.structuredContent ?? {})).not.toContain("x".repeat(64));
  });

  test("model caller spills exact bytes and returns the compact receipt", async () => {
    const result = oversizedResult();
    const receipt = {
      type: "tool_result_spilled" as const,
      sandboxPath: toolResultSpillSandboxPath(`${OPERATION_ID}.json`),
      fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      byteSize: MCP_MAX_TOOL_RESULT_BYTES + 64,
      mediaType: TOOL_RESULT_SPILL_MEDIA_TYPE,
    };
    const spill: SpillOversizedModelToolResult = async (input) => {
      expect(input.operationId).toBe(OPERATION_ID);
      expect(input.result).toBe(result);
      expect(input.serializedBytes).toBeGreaterThan(MCP_MAX_TOOL_RESULT_BYTES);
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        structuredContent: receipt,
      };
    };
    const projected = await projectAttemptToolResultForCaller(result, context("model"), spill);
    expect(projected.isError).toBe(false);
    expect(projected.structuredContent).toEqual(receipt);
    expect(projected.content[0]).toEqual({ type: "text", text: JSON.stringify(receipt) });
    expect(JSON.stringify(projected)).not.toContain("x".repeat(64));
  });

  test("model spill failure returns result_too_large without the huge payload", async () => {
    const projected = await projectAttemptToolResultForCaller(
      oversizedResult(),
      context("model"),
      async () => {
        throw new Error("object storage unavailable");
      },
    );
    expect(projected).toEqual(modelToolResultOverflowError());
    expect(JSON.stringify(projected)).not.toContain("x".repeat(64));
  });

  test("wrapAttemptToolExecute branches on caller kind", async () => {
    const execute = wrapAttemptToolExecute(async () => oversizedResult());
    const codemode = await execute({}, context("codemode"));
    expect(codemode).toEqual(oversizedResult());
    const model = await execute({}, context("model"));
    expect(model).toEqual(modelToolResultOverflowError());
  });

  test("wrapAttemptToolDefinitions wraps every execute", async () => {
    const [wrapped] = wrapAttemptToolDefinitions([
      {
        identity: { serverId: "interaction", toolName: "echo" },
        modelName: "echo",
        inputSchema: { type: "object" },
        source: "interaction",
        approval: "none",
        execute: async () => smallResult(),
      },
    ]);
    expect(wrapped).toBeDefined();
    expect(await wrapped!.execute({}, context("model"))).toEqual(smallResult());
  });
});
