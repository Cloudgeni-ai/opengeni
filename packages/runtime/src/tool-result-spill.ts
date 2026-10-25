import type { AttemptToolDefinition, AttemptToolExecutionContext } from "@opengeni/codemode";
import {
  DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
  modelToolOutputSerializationBudgetTokens,
} from "@opengeni/codex";
import {
  ToolResultSpilledReceipt,
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

/**
 * A tool's own model-visible copy of one exact result (for example a local MCP
 * bridge's compact mail cards). Only the model caller receives it.
 */
export type ProjectModelToolResult = (result: AttemptToolResultValue) => AttemptToolResultValue;

/**
 * UTF-8 text bytes one model-visible tool result may use before the generic
 * model-output truncation cuts its middle (four bytes per approximate token),
 * less a small allowance for the `Structured result: ` framing of the model
 * view.
 */
export function modelToolTextBudgetBytes(
  policyTokens: number = DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
): number {
  return Math.max(4_096, modelToolOutputSerializationBudgetTokens(policyTokens) * 4 - 512);
}

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
  // `sandboxPath` is where the model's shell can open the copy, as the spill
  // port resolved it for the turn's placement, or null when there is no copy.
  const structuredContent = ToolResultSpilledReceipt.parse(receipt);
  return {
    isError: false,
    content: [
      { type: "text", text: JSON.stringify(structuredContent) },
      { type: "text", text: spilledToolResultGuidance(structuredContent) },
    ],
    structuredContent,
  };
}

/** How the model reads a spilled result: the shell copy when there is one,
 * and otherwise (or when that copy is gone, for example in a later turn on a
 * new box) the workspace File through the Files download tool, as for
 * attachments. */
function spilledToolResultGuidance(receipt: ToolResultSpilledReceiptValue): string {
  const size = `The result was too large to show (${receipt.byteSize} bytes)`;
  const read = "read the parts you need, for example with jq, head or grep";
  const download = `call files__files_get_download_url with fileId ${receipt.fileId} and download it with the shell`;
  return receipt.sandboxPath === null
    ? `${size}, so its exact JSON is saved as a workspace file. To read it, ${download}, then ${read}.`
    : `${size}, so its exact JSON is saved at ${receipt.sandboxPath} where your shell runs. With the shell, ${read}, instead of printing it whole. If the file is not there, ${download}.`;
}

/** True when the model receives this result as is, without a spill or overflow error. */
export function modelToolResultFits(result: AttemptToolResultValue): boolean {
  return mcpSerializedSizeBytes(result) <= MCP_MAX_TOOL_RESULT_BYTES;
}

/**
 * The single per-caller seam over one executor result. Codemode receives the
 * exact result. The model receives its model-visible projection (the tool's
 * own `projectForModel`, such as compact Gmail cards, or compact Knowledge
 * discovery output for the exact tool identity) when that fits in 1 MiB;
 * otherwise the exact result is spilled to a file, as for any tool. A
 * projection that throws leaves the exact result in place.
 * MCP-backed exact results are bounded only by the 8 MiB MCP transport cap
 * before this seam runs, so a large MCP read spills here like any other tool
 * instead of failing after the provider already returned it.
 */
export async function projectAttemptToolResultForCaller(
  result: AttemptToolResultValue,
  context: AttemptToolExecutionContext,
  spill?: SpillOversizedModelToolResult,
  identity?: AttemptToolIdentity,
  projectForModel?: ProjectModelToolResult,
): Promise<AttemptToolResultValue> {
  switch (context.caller.kind) {
    case "codemode":
      return result;
    case "model": {
      const own = projectForModel ? toolOwnModelProjection(projectForModel, result) : result;
      const visible = identity ? projectKnowledgeToolResultForModel(identity, own) : own;
      if (modelToolResultFits(visible)) return visible;
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

function toolOwnModelProjection(
  projectForModel: ProjectModelToolResult,
  result: AttemptToolResultValue,
): AttemptToolResultValue {
  try {
    return projectForModel(result);
  } catch {
    return result;
  }
}

export function wrapAttemptToolExecute(
  execute: AttemptToolDefinition["execute"],
  spill?: SpillOversizedModelToolResult,
  identity?: AttemptToolIdentity,
  projectForModel?: ProjectModelToolResult,
): AttemptToolDefinition["execute"] {
  return async (args, context) =>
    await projectAttemptToolResultForCaller(
      await execute(args, context),
      context,
      spill,
      identity,
      projectForModel,
    );
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
