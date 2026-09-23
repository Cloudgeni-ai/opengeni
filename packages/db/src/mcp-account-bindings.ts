import {
  McpConnectionAccountBindings,
  type McpConnectionAccountBinding,
} from "@opengeni/contracts";

/** NULL is a pre-account-routing receipt, not an empty accepted selection.
 * Never default it to [] (or default [] to NULL) during replay/inheritance. */
export function parseAcceptedMcpAccountBindings(
  value: unknown,
): McpConnectionAccountBinding[] | null {
  return value == null ? null : McpConnectionAccountBindings.parse(value);
}
