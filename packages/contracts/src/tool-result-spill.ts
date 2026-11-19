import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

/**
 * Earlier receipt of a tool result over 1 MiB: its exact JSON lives on a
 * workspace File. New results use `tool_result_stored`; this shape stays so
 * history that already holds it is read, replayed and validated unchanged.
 */
export const TOOL_RESULT_SPILLED_TYPE = "tool_result_spilled" as const;
export const TOOL_RESULT_SPILL_MEDIA_TYPE = "application/json" as const;
export const TOOL_RESULT_SPILL_MOUNT_PATH = "tool-results" as const;

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const ToolResultSpilledReceipt = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      type: z.literal(TOOL_RESULT_SPILLED_TYPE),
      sandboxPath: z.string().min(1).max(4_096).nullable(),
      fileId: primitives.string.regex(LOWERCASE_UUID),
      byteSize: primitives.positiveInteger.safe(),
      mediaType: z.literal(TOOL_RESULT_SPILL_MEDIA_TYPE),
    })
    .strict(),
);
export type ToolResultSpilledReceipt = z.infer<typeof ToolResultSpilledReceipt>;

export function isToolResultSpilledReceipt(value: unknown): value is ToolResultSpilledReceipt {
  return ToolResultSpilledReceipt.safeParse(value).success;
}

/**
 * A tool result larger than the model's inline tool-output policy. Its full
 * model-visible text is stored whole as a workspace File (`resultId`); the
 * model sees part of it and reads the rest by byte offset with
 * `tool_result_read`. Bytes `notShownFrom` up to `notShownTo` (exclusive) are
 * the part the view leaves out: the end of the text for a result shown from
 * its start, the middle for shell output shown as its head and tail.
 */
export const TOOL_RESULT_STORED_TYPE = "tool_result_stored" as const;
export const TOOL_RESULT_STORED_MEDIA_TYPE = "text/plain" as const;
/** The built-in tool that reads a stored tool result by id and byte offset. */
export const TOOL_RESULT_READ_TOOL_NAME = "tool_result_read" as const;

export const ToolResultStoredReceipt = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      type: z.literal(TOOL_RESULT_STORED_TYPE),
      resultId: primitives.string.regex(LOWERCASE_UUID),
      byteSize: primitives.positiveInteger.safe(),
      notShownFrom: primitives.nonnegativeInteger.safe(),
      notShownTo: primitives.positiveInteger.safe(),
      sandboxPath: z.string().min(1).max(4_096).nullable(),
    })
    .strict()
    .refine(
      (receipt) =>
        receipt.notShownFrom < receipt.notShownTo && receipt.notShownTo <= receipt.byteSize,
      { message: "notShownFrom..notShownTo must be a nonempty range within byteSize" },
    ),
);
export type ToolResultStoredReceipt = z.infer<typeof ToolResultStoredReceipt>;

export function isToolResultStoredReceipt(value: unknown): value is ToolResultStoredReceipt {
  return ToolResultStoredReceipt.safeParse(value).success;
}

/** `_meta` key that carries a stored result's receipt; the model never sees `_meta`. */
export const TOOL_RESULT_STORED_META_KEY = "opengeni/toolResultStored" as const;

/**
 * A model view of a result kept in the tool-result store instead of shown
 * whole: its receipt is in `_meta` (or, for earlier spills, the structured
 * content). Such a view does not match the tool's own output schema.
 */
export function isModelToolResultStoreView(result: {
  structuredContent?: unknown;
  _meta?: unknown;
}): boolean {
  if (isToolResultSpilledReceipt(result.structuredContent)) return true;
  const meta = result._meta;
  return (
    meta !== null &&
    typeof meta === "object" &&
    isToolResultStoredReceipt((meta as Record<string, unknown>)[TOOL_RESULT_STORED_META_KEY])
  );
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

/** File name of a stored tool result's text: `<resultId>.txt`. */
export function toolResultStoredFilename(resultId: string): string {
  const normalized = resultId.toLowerCase();
  if (!LOWERCASE_UUID.test(normalized)) {
    throw new Error("stored tool result filename requires a lowercase UUID result id");
  }
  return `${normalized}.txt`;
}
