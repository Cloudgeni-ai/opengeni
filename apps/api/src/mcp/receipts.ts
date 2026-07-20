import {
  MCP_MUTATION_RECEIPT_VERSION,
  McpMutationReceipt,
  type McpMutationReceiptType,
} from "@opengeni/contracts";

export type McpMutationReceiptInput = Omit<
  McpMutationReceiptType,
  "receiptVersion" | "timestamp" | "warnings"
> & {
  timestamp?: string;
  warnings?: string[];
};

/**
 * Build and validate a compact first-party MCP mutation receipt at the API
 * boundary. Contract parsing is intentional: it prevents a handler from
 * accidentally adding an unbounded entity or a copy of request fields.
 */
export function mcpMutationReceipt(input: McpMutationReceiptInput): McpMutationReceiptType {
  return McpMutationReceipt.parse({
    receiptVersion: MCP_MUTATION_RECEIPT_VERSION,
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
    warnings: input.warnings ?? [],
  });
}
