import type { AttemptToolDefinition, AttemptToolExecutionContext } from "@opengeni/codemode";
import {
  ToolResultSpilledReceipt,
  sandboxShellPath,
  type AttemptToolIdentity,
  type AttemptToolResult as AttemptToolResultValue,
  type ToolResultSpilledReceipt as ToolResultSpilledReceiptValue,
} from "@opengeni/contracts";
import { projectKnowledgeToolResultForModel } from "./knowledge-model-projection";
import { MCP_MAX_TOOL_RESULT_BYTES, mcpSerializedSizeBytes } from "./mcp-network";

export type SpillOversizedModelToolResult = (input: {
  operationId: string;
  result: AttemptToolResultValue;
  serializedBytes: number;
}) => Promise<AttemptToolResultValue>;

const OVERFLOW_ERROR = {
  code: "result_too_large",
  message: "Tool result exceeded the bounded model-visible size.",
  retryable: false,
} as const;

export function modelToolResultOverflowError(): AttemptToolResultValue {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: OVERFLOW_ERROR }) }],
    structuredContent: { error: OVERFLOW_ERROR },
  };
}

export function spilledModelToolResult(
  receipt: ToolResultSpilledReceiptValue,
): AttemptToolResultValue {
  // Rematerialization keeps the virtual `/workspace/tool-results/...` path.
  // The model-visible receipt is cwd-relative so exec_command can open the copy
  // on a Connected Machine (no `/workspace` directory exists there).
  const structuredContent = ToolResultSpilledReceipt.parse({
    ...receipt,
    sandboxPath: receipt.sandboxPath === null ? null : sandboxShellPath(receipt.sandboxPath),
  });
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/**
 * The single per-caller seam over one executor result. Codemode receives the
 * exact result. The model receives its model-visible projection (compact
 * Knowledge discovery output for the exact tool identity) when that fits in
 * 1 MiB; otherwise the exact result is spilled to a file, as for any tool.
 * MCP-backed tools are already bounded on their exact result by the MCP
 * transport cap before this seam runs.
 */
export async function projectAttemptToolResultForCaller(
  result: AttemptToolResultValue,
  context: AttemptToolExecutionContext,
  spill?: SpillOversizedModelToolResult,
  identity?: AttemptToolIdentity,
): Promise<AttemptToolResultValue> {
  switch (context.caller.kind) {
    case "codemode":
      return result;
    case "model": {
      const visible = identity ? projectKnowledgeToolResultForModel(identity, result) : result;
      if (mcpSerializedSizeBytes(visible) <= MCP_MAX_TOOL_RESULT_BYTES) return visible;
      if (!spill) return modelToolResultOverflowError();
      try {
        return await spill({
          operationId: context.operationId,
          result,
          serializedBytes: mcpSerializedSizeBytes(result),
        });
      } catch {
        return modelToolResultOverflowError();
      }
    }
    default: {
      const unexpected: never = context.caller.kind;
      throw new Error(`unhandled tool caller ${unexpected}`);
    }
  }
}

export function wrapAttemptToolExecute(
  execute: AttemptToolDefinition["execute"],
  spill?: SpillOversizedModelToolResult,
  identity?: AttemptToolIdentity,
): AttemptToolDefinition["execute"] {
  return async (args, context) =>
    await projectAttemptToolResultForCaller(await execute(args, context), context, spill, identity);
}

export function wrapAttemptToolDefinitions(
  definitions: readonly AttemptToolDefinition[],
  spill?: SpillOversizedModelToolResult,
): AttemptToolDefinition[] {
  return definitions.map((definition) => ({
    ...definition,
    execute: wrapAttemptToolExecute(definition.execute, spill, definition.identity),
  }));
}
