import type { AttemptToolDefinition, AttemptToolExecutionContext } from "@opengeni/codemode";
import {
  ToolResultSpilledReceipt,
  type AttemptToolResult as AttemptToolResultValue,
  type ToolResultSpilledReceipt as ToolResultSpilledReceiptValue,
} from "@opengeni/contracts";
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
  const structuredContent = ToolResultSpilledReceipt.parse(receipt);
  return {
    isError: false,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export async function projectAttemptToolResultForCaller(
  result: AttemptToolResultValue,
  context: AttemptToolExecutionContext,
  spill?: SpillOversizedModelToolResult,
): Promise<AttemptToolResultValue> {
  switch (context.caller.kind) {
    case "codemode":
      return result;
    case "model": {
      const serializedBytes = mcpSerializedSizeBytes(result);
      if (serializedBytes <= MCP_MAX_TOOL_RESULT_BYTES) return result;
      if (!spill) return modelToolResultOverflowError();
      try {
        return await spill({
          operationId: context.operationId,
          result,
          serializedBytes,
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
): AttemptToolDefinition["execute"] {
  return async (args, context) =>
    await projectAttemptToolResultForCaller(await execute(args, context), context, spill);
}

export function wrapAttemptToolDefinitions(
  definitions: readonly AttemptToolDefinition[],
  spill?: SpillOversizedModelToolResult,
): AttemptToolDefinition[] {
  return definitions.map((definition) => ({
    ...definition,
    execute: wrapAttemptToolExecute(definition.execute, spill),
  }));
}
