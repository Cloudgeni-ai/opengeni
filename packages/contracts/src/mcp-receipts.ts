import { z } from "zod";

/**
 * Versioned, provider-neutral receipt returned by first-party MCP mutation tools.
 *
 * A receipt intentionally contains only server-generated identity and outcome
 * facts. Callers already have mutation inputs in their tool-call history, so
 * copying names, prompts, instructions, commands, evidence, or other request
 * fields into the result wastes context and can expose data twice.
 */
export const MCP_MUTATION_RECEIPT_VERSION = "mcp-mutation-receipt.v1" as const;
export const MCP_MUTATION_RECEIPT_MAX_BYTES = 64 * 1024;

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

function boundedUtf8String(maxBytes: number, minLength = 0) {
  return z
    .string()
    .min(minLength)
    .max(maxBytes)
    .superRefine((value, context) => {
      if (utf8ByteLength(value) > maxBytes) {
        context.addIssue({
          code: "custom",
          message: `string must contain at most ${maxBytes} UTF-8 bytes`,
        });
      }
    });
}

export const McpMutationReceiptOutcome = z.enum([
  "created",
  "updated",
  "deleted",
  "unchanged",
  "accepted",
  "triggered",
  "repaired",
  "replayed",
  "partial_failure",
]);
export type McpMutationReceiptOutcome = z.infer<typeof McpMutationReceiptOutcome>;

export const McpMutationReceiptIdempotencyStatus = z.enum([
  "not_supported",
  "not_requested",
  "applied",
  "replayed",
  "unknown",
]);
export type McpMutationReceiptIdempotencyStatus = z.infer<
  typeof McpMutationReceiptIdempotencyStatus
>;

export const McpMutationResource = z
  .object({
    type: boundedUtf8String(128, 1),
    id: boundedUtf8String(256, 1),
    version: z.union([z.number().int().nonnegative(), boundedUtf8String(128, 1)]).optional(),
    etag: boundedUtf8String(512, 1).optional(),
    state: boundedUtf8String(128, 1).optional(),
  })
  .strict();
export type McpMutationResource = z.infer<typeof McpMutationResource>;

const McpMutationReceiptFact = z.union([
  boundedUtf8String(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const McpMutationReceiptFacts = z
  .record(boundedUtf8String(64, 1), McpMutationReceiptFact)
  .superRefine((value, context) => {
    if (Object.keys(value).length > 16) {
      context.addIssue({
        code: "custom",
        message: "receipt facts may contain at most 16 scalar entries",
      });
    }
  });

const McpMutationReceiptNextActionArguments = z
  .record(boundedUtf8String(64, 1), McpMutationReceiptFact)
  .superRefine((value, context) => {
    if (Object.keys(value).length > 8) {
      context.addIssue({
        code: "custom",
        message: "receipt nextAction arguments may contain at most 8 scalar entries",
      });
    }
  });

export const McpMutationReceipt = z
  .object({
    receiptVersion: z.literal(MCP_MUTATION_RECEIPT_VERSION),
    operation: boundedUtf8String(128, 1),
    // v1 receipts describe committed truth only. Validation/auth/conflict and
    // fully compensated failures remain MCP errors rather than success-shaped
    // committed=false results.
    committed: z.literal(true),
    outcome: McpMutationReceiptOutcome,
    changed: z.boolean(),
    resource: McpMutationResource,
    relatedResources: z.array(McpMutationResource).max(8).optional(),
    timestamp: z.string().datetime({ offset: true }),
    idempotency: z
      .object({
        status: McpMutationReceiptIdempotencyStatus,
      })
      .strict(),
    partialFailure: z
      .object({
        stage: boundedUtf8String(128, 1),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
    warnings: z.array(boundedUtf8String(512, 1)).max(20),
    nextAction: z
      .object({
        tool: boundedUtf8String(128, 1),
        arguments: McpMutationReceiptNextActionArguments,
      })
      .strict()
      .optional(),
    /** Operation-specific outcome facts. Values are deliberately bounded scalars. */
    facts: McpMutationReceiptFacts.optional(),
    /**
     * Bounded session_create compatibility aliases. Existing orchestration
     * consumers use these server-authored lineage facts to spawn descendants
     * without fetching the full session entity.
     */
    id: boundedUtf8String(256, 1).optional(),
    rootSessionId: boundedUtf8String(256, 1).optional(),
    nestedAgentDepth: z.number().int().nonnegative().optional(),
    effectiveMaxNestedAgentDepth: z.number().int().nonnegative().optional(),
    /** Bounded session_steer compatibility alias for resource.id. */
    updateId: boundedUtf8String(256, 1).optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const sessionCreateCompatibility = [
      ["id", receipt.id],
      ["rootSessionId", receipt.rootSessionId],
      ["nestedAgentDepth", receipt.nestedAgentDepth],
      ["effectiveMaxNestedAgentDepth", receipt.effectiveMaxNestedAgentDepth],
    ] as const;
    if (receipt.operation === "session_create") {
      for (const [field, value] of sessionCreateCompatibility) {
        if (value === undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `session_create receipts require ${field}`,
          });
        }
      }
      if (receipt.id !== undefined && receipt.id !== receipt.resource.id) {
        context.addIssue({
          code: "custom",
          path: ["id"],
          message: "session_create id must equal resource.id",
        });
      }
    } else {
      for (const [field, value] of sessionCreateCompatibility) {
        if (value !== undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: `${field} is only valid for session_create receipts`,
          });
        }
      }
    }

    if (receipt.operation === "session_steer") {
      if (receipt.updateId === undefined) {
        context.addIssue({
          code: "custom",
          path: ["updateId"],
          message: "session_steer receipts require updateId",
        });
      } else if (receipt.updateId !== receipt.resource.id) {
        context.addIssue({
          code: "custom",
          path: ["updateId"],
          message: "session_steer updateId must equal resource.id",
        });
      }
    } else if (receipt.updateId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["updateId"],
        message: "updateId is only valid for session_steer receipts",
      });
    }

    if (receipt.outcome === "partial_failure") {
      if (!receipt.committed) {
        context.addIssue({
          code: "custom",
          path: ["committed"],
          message: "partial-failure receipts describe a committed mutation",
        });
      }
      if (!receipt.partialFailure) {
        context.addIssue({
          code: "custom",
          path: ["partialFailure"],
          message: "partial-failure receipts require stage and retryability",
        });
      }
    } else if (receipt.partialFailure) {
      context.addIssue({
        code: "custom",
        path: ["partialFailure"],
        message: "partialFailure is only valid for a partial_failure outcome",
      });
    }

    if (receipt.outcome === "unchanged" && receipt.changed) {
      context.addIssue({
        code: "custom",
        path: ["changed"],
        message: "unchanged receipts cannot report changed=true",
      });
    }
    if (receipt.outcome === "repaired") {
      if (!receipt.changed) {
        context.addIssue({
          code: "custom",
          path: ["changed"],
          message: "a repair must report changed=true",
        });
      }
      if (receipt.idempotency.status !== "applied") {
        context.addIssue({
          code: "custom",
          path: ["idempotency", "status"],
          message: "repaired outcomes require idempotency.status=applied",
        });
      }
    }
    if (receipt.outcome === "replayed") {
      if (receipt.changed) {
        context.addIssue({
          code: "custom",
          path: ["changed"],
          message: "a replay does not apply a new mutation",
        });
      }
      if (receipt.idempotency.status !== "replayed") {
        context.addIssue({
          code: "custom",
          path: ["idempotency", "status"],
          message: "replayed outcomes require idempotency.status=replayed",
        });
      }
    } else if (
      receipt.idempotency.status === "replayed" &&
      !(receipt.outcome === "partial_failure" && !receipt.changed)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message:
          "idempotency.status=replayed requires a replayed outcome or unchanged partial failure",
      });
    }

    if (utf8ByteLength(JSON.stringify(receipt, null, 2)) > MCP_MUTATION_RECEIPT_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        message: `receipt must contain at most ${MCP_MUTATION_RECEIPT_MAX_BYTES} UTF-8 bytes when serialized as pretty JSON`,
      });
    }
  });
export type McpMutationReceipt = z.infer<typeof McpMutationReceipt>;
