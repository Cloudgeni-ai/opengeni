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

export const McpMutationReceiptOutcome = z.enum([
  "created",
  "updated",
  "deleted",
  "unchanged",
  "accepted",
  "triggered",
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
    type: z.string().min(1).max(128),
    id: z.string().min(1).max(256),
    version: z.union([z.number().int().nonnegative(), z.string().min(1).max(128)]).optional(),
    etag: z.string().min(1).max(512).optional(),
    state: z.string().min(1).max(128).optional(),
  })
  .strict();
export type McpMutationResource = z.infer<typeof McpMutationResource>;

const McpMutationReceiptFact = z.union([
  z.string().max(512),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const McpMutationReceiptFacts = z
  .record(z.string().min(1).max(64), McpMutationReceiptFact)
  .superRefine((value, context) => {
    if (Object.keys(value).length > 16) {
      context.addIssue({
        code: "custom",
        message: "receipt facts may contain at most 16 scalar entries",
      });
    }
  });

const McpMutationReceiptNextActionArguments = z
  .record(z.string().min(1).max(64), McpMutationReceiptFact)
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
    operation: z.string().min(1).max(128),
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
        stage: z.string().min(1).max(128),
        retryable: z.boolean(),
      })
      .strict()
      .optional(),
    warnings: z.array(z.string().min(1).max(512)).max(20),
    nextAction: z
      .object({
        tool: z.string().min(1).max(128),
        arguments: McpMutationReceiptNextActionArguments,
      })
      .strict()
      .optional(),
    /** Operation-specific outcome facts. Values are deliberately bounded scalars. */
    facts: McpMutationReceiptFacts.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
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
    } else if (receipt.idempotency.status === "replayed") {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "idempotency.status=replayed requires outcome=replayed",
      });
    }
  });
export type McpMutationReceipt = z.infer<typeof McpMutationReceipt>;
