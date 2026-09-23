import type { AttemptToolDefinition } from "@opengeni/codemode";
import { AttemptToolResult } from "@opengeni/contracts";
import { z } from "zod";

const selectorSchema = z.union([
  z.object({ operationId: z.string().uuid() }).strict(),
  z.object({ sourceTurnId: z.string().uuid(), sourceCallId: z.string().min(1) }).strict(),
]);

export type McpOperationReadSelector = z.infer<typeof selectorSchema>;

/** Attempt-local adapter. The supplied read closure owns canonical session
 * access, current provider authority, immutable binding checks and settlement.
 * No caller-controlled provider parameters cross this tool boundary. */
export function createOperationReadAttemptToolDefinition(input: {
  read: (selector: McpOperationReadSelector) => Promise<Record<string, unknown>>;
}): AttemptToolDefinition {
  return {
    identity: { serverId: "opengeni", toolName: "operation_read" },
    modelName: "operation_read",
    codemodePath: ["opengeni", "operation_read"],
    title: "Read an existing MCP operation outcome",
    description:
      "Read a retained MCP operation and, when supported and currently authorized, observe its provider receipt. " +
      "Use the operationId from the original call, or its exact sourceTurnId and sourceCallId if that response was lost. " +
      "This never repeats the original mutation. Unknown means the outcome is not proven, not that the operation failed. " +
      "Provider support and renewed authorization may be required after reconnecting.",
    inputSchema: {
      type: "object",
      properties: {
        operationId: { type: "string", format: "uuid" },
        sourceTurnId: { type: "string", format: "uuid" },
        sourceCallId: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
      oneOf: [
        {
          required: ["operationId"],
          not: { anyOf: [{ required: ["sourceTurnId"] }, { required: ["sourceCallId"] }] },
        },
        { required: ["sourceTurnId", "sourceCallId"], not: { required: ["operationId"] } },
      ],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    source: "opengeni",
    approval: "none",
    execute: async (args) => {
      const selector = selectorSchema.parse(args);
      const receipt = await input.read(selector);
      return AttemptToolResult.parse({
        content: [{ type: "text", text: JSON.stringify(receipt) }],
        structuredContent: receipt,
      });
    },
  };
}
