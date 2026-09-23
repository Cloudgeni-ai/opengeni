import { AttemptToolResult } from "@opengeni/contracts";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";

export type McpOperationObservationAuthority = {
  serverId: string;
  observerTool: string;
  destinationDigest: string;
  authorityDigest: string;
};
const observationAuthority = new AsyncLocalStorage<{
  binding: McpOperationObservationAuthority;
  closed: boolean;
}>();

/** Pin the actual broker request, not merely the earlier credential lookup. */
export async function runMcpOperationObservationWithAuthority<T>(
  binding: McpOperationObservationAuthority,
  execute: () => Promise<T>,
): Promise<T> {
  const scope = { binding: { ...binding }, closed: false };
  return await observationAuthority.run(scope, async () => {
    try {
      return await execute();
    } finally {
      scope.closed = true;
    }
  });
}

/** The caller is the credential broker, after live authorization and before
 * physical tools/call dispatch. Unrelated ordinary calls remain unchanged. */
export function assertMcpOperationObservationAuthority(actual: {
  serverId: string;
  toolName?: string;
  destinationDigest: string;
  authorityDigest?: string;
}): void {
  const scope = observationAuthority.getStore();
  if (!scope) return;
  const expected = scope.binding;
  if (
    scope.closed ||
    actual.serverId !== expected.serverId ||
    actual.toolName !== expected.observerTool ||
    actual.destinationDigest !== expected.destinationDigest ||
    actual.authorityDigest !== expected.authorityDigest
  ) {
    throw new Error("MCP operation observation authority changed before provider use");
  }
}

const fingerprint = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("sha256"),
    value: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const identity = {
  version: z.literal(1),
  operationRef: z.string().uuid(),
  fingerprint,
};

const receiptSchema = z.discriminatedUnion("status", [
  z.object({ ...identity, status: z.literal("unknown") }).strict(),
  z
    .object({
      ...identity,
      status: z.literal("pending"),
      evidenceRevision: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...identity,
      status: z.literal("completed"),
      receiptRevision: z
        .string()
        .min(1)
        .refine((value) => Buffer.byteLength(value, "utf8") <= 1024, {
          message: "MCP receipt revision must fit the ledger's 1024-byte identity field",
        }),
      result: AttemptToolResult,
    })
    .strict(),
  z.object({ ...identity, status: z.literal("conflict") }).strict(),
]);

const bindingSchema = z
  .object({
    operationId: z.string().uuid(),
    serverId: z.string().min(1),
    originalTool: z.string().min(1),
    observerTool: z.string().min(1),
    argumentDigest: fingerprint.shape.value,
  })
  .strict()
  .refine((value) => value.originalTool !== value.observerTool, {
    message: "The observer must not be the original mutation tool",
  });

export type McpObservationBinding = z.infer<typeof bindingSchema>;
export type McpObservationReceipt = z.infer<typeof receiptSchema>;

/**
 * One observation, never a mutation retry. This helper is deliberately not an
 * authority resolver or a scheduler: its caller must load an immutable trusted
 * binding and bind callObserver to that exact authorized provider destination.
 * Tool annotations and model-supplied arguments cannot establish that trust.
 *
 * Durable settlement must additionally recheck authority under its own locks.
 * A successful return alone is not a durable delivery or commit receipt.
 */
export async function observeMcpOperation(input: {
  binding: McpObservationBinding;
  authorize: (phase: "before_request" | "before_delivery") => Promise<boolean>;
  callObserver: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}): Promise<McpObservationReceipt> {
  // Parse into a fresh object before callbacks can mutate the caller's input.
  const binding = bindingSchema.parse(input.binding);
  if (!(await input.authorize("before_request"))) {
    throw new Error("MCP operation observation is not authorized");
  }
  const response = await input.callObserver(binding.observerTool, {
    version: 1,
    operationRef: binding.operationId,
    originalTool: binding.originalTool,
    fingerprint: { version: 1, algorithm: "sha256", value: binding.argumentDigest },
  });
  if (!(await input.authorize("before_delivery"))) {
    throw new Error("MCP operation observation is not authorized for delivery");
  }
  const envelope = AttemptToolResult.parse(response);
  if (envelope.isError) {
    throw new Error("MCP operation observer returned an error, not a receipt");
  }
  const receipt = receiptSchema.parse(envelope.structuredContent);
  if (
    receipt.operationRef !== binding.operationId ||
    receipt.fingerprint.value !== binding.argumentDigest
  ) {
    throw new Error("MCP operation observation receipt identity does not match");
  }
  return receipt;
}
