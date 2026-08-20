import { z } from "zod";

/** Model-visible overflow of one tool result. Exact bytes live on a workspace File. */
export const TOOL_RESULT_SPILLED_TYPE = "tool_result_spilled" as const;
export const TOOL_RESULT_SPILL_MEDIA_TYPE = "application/json" as const;
export const TOOL_RESULT_SPILL_MOUNT_PATH = "tool-results" as const;

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const ToolResultSpilledReceipt = z
  .object({
    type: z.literal(TOOL_RESULT_SPILLED_TYPE),
    sandboxPath: z.string().min(1).max(4_096).nullable(),
    fileId: z.string().regex(LOWERCASE_UUID),
    byteSize: z.number().int().positive().safe(),
    mediaType: z.literal(TOOL_RESULT_SPILL_MEDIA_TYPE),
  })
  .strict();
export type ToolResultSpilledReceipt = z.infer<typeof ToolResultSpilledReceipt>;

export function isToolResultSpilledReceipt(value: unknown): value is ToolResultSpilledReceipt {
  return ToolResultSpilledReceipt.safeParse(value).success;
}

export function toolResultSpillSandboxPath(filename: string): string {
  return `/workspace/${TOOL_RESULT_SPILL_MOUNT_PATH}/${filename}`;
}

export function toolResultSpillFilename(operationId: string): string {
  const normalized = operationId.toLowerCase();
  if (!LOWERCASE_UUID.test(normalized)) {
    throw new Error("tool result spill filename requires a lowercase UUID operation id");
  }
  return `${normalized}.json`;
}
