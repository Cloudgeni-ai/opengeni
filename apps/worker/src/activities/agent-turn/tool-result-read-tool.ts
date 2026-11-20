import type { AttemptToolDefinition } from "@opengeni/codemode";
import { AttemptToolResult, TOOL_RESULT_READ_TOOL_NAME } from "@opengeni/contracts";
import { z } from "zod";

/** Room left in one read for its header and continuation lines. */
const READ_FRAMING_BYTES = 1_024;

const argsSchema = z
  .object({
    resultId: z.string().uuid(),
    offset: z.number().int().min(0).optional(),
    maxBytes: z.number().int().min(1).optional(),
  })
  .strict();

/**
 * One read of a stored tool result: the UTF-8 bytes from `offset`, at most
 * `maxBytes`, cut at character boundaries. `end` is where the next read starts.
 */
export function readStoredToolResultSlice(
  bytes: Buffer,
  offset: number,
  maxBytes: number,
): { start: number; end: number; text: string } {
  let start = Math.min(offset, bytes.length);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  let end = Math.min(bytes.length, start + Math.max(1, maxBytes));
  while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  // A single character wider than maxBytes is still returned whole.
  if (end === start && start < bytes.length) {
    end = start + 1;
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end += 1;
  }
  return { start, end, text: bytes.subarray(start, end).toString("utf8") };
}

/**
 * `tool_result_read`: the one built-in reader of tool results that were too
 * large to show whole. It reads by result id and byte offset from durable
 * storage, so it works with or without a sandbox, for every tool.
 */
export function createToolResultReadAttemptToolDefinition(input: {
  read: (resultId: string) => Promise<Buffer | null>;
  /** The current model's inline budget, in UTF-8 bytes. */
  inlineMaxBytes: () => number;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: TOOL_RESULT_READ_TOOL_NAME },
    modelName: TOOL_RESULT_READ_TOOL_NAME,
    codemodePath: ["opengeni", TOOL_RESULT_READ_TOOL_NAME],
    title: "Read a stored tool result",
    description:
      "Read more of a tool result that was too large to show whole. Pass the resultId and the byte offset its note gives; " +
      "each read returns the next part and the offset to continue from. maxBytes is optional and capped at one result's inline size.",
    inputSchema: {
      type: "object",
      properties: {
        resultId: { type: "string", format: "uuid" },
        offset: { type: "integer", minimum: 0, default: 0 },
        maxBytes: { type: "integer", minimum: 1 },
      },
      required: ["resultId"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      const parsed = argsSchema.parse(args);
      const resultId = parsed.resultId.toLowerCase();
      const offset = parsed.offset ?? 0;
      const limit = Math.max(1_024, input.inlineMaxBytes() - READ_FRAMING_BYTES);
      const maxBytes = Math.min(parsed.maxBytes ?? limit, limit);
      const bytes = await input.read(resultId);
      if (!bytes) {
        return AttemptToolResult.parse({
          isError: true,
          content: [
            {
              type: "text",
              text: `No stored tool result ${resultId} in this workspace. Use the resultId from the note of the result you want to read.`,
            },
          ],
        });
      }
      if (offset >= bytes.length) {
        return AttemptToolResult.parse({
          isError: true,
          content: [
            {
              type: "text",
              text: `Offset ${offset} is at or past the end of this ${bytes.length}-byte result.`,
            },
          ],
        });
      }
      const slice = readStoredToolResultSlice(bytes, offset, maxBytes);
      const next =
        slice.end < bytes.length
          ? `[Opengeni: continue with ${TOOL_RESULT_READ_TOOL_NAME} ${JSON.stringify({ resultId, offset: slice.end })}]`
          : "[Opengeni: end of the stored result]";
      return AttemptToolResult.parse({
        content: [
          {
            type: "text",
            text: `[Opengeni: bytes ${slice.start} to ${slice.end} of ${bytes.length}]\n${slice.text}\n${next}`,
          },
        ],
      });
    },
  };
}
