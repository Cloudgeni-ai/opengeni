import type { ComputerOperationReceipt } from "@opengeni/contracts";

const MAX_RESULT_BYTES = 12 * 1024 * 1024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Transport projection only. The controller journal retains the original result.
 * Keep below Code Mode's 16 MiB completion bound as well as the HTTP envelope. */
export function boundComputerNativeReceipt<T extends ComputerOperationReceipt>(receipt: T): T {
  if (receipt.targetId !== null || !receipt.observation || bytes(receipt) <= MAX_RESULT_BYTES)
    return receipt;
  const original = receipt.observation.result;
  let remaining = 8 * 1024 * 1024;
  const content = original.content.filter((part) => {
    const size = bytes(part);
    if (size > remaining) return false;
    remaining -= size;
    return true;
  });
  content.push({
    type: "text",
    text: JSON.stringify({
      outputTruncated: true,
      operationId: receipt.operationId,
      state: receipt.state,
      guidance:
        "Some CUA output exceeded the response limit. The original result remains in the controller journal. Do not repeat the action to retrieve output. Read current state with a smaller image or tree, or inspect the retained journal.",
    }),
  });
  return {
    ...receipt,
    observation: {
      ...receipt.observation,
      result: {
        content,
        // The operation state is unchanged; only this response is incomplete.
        // Skip the upstream output-schema check for the truncated projection.
        isError: true,
        ...(original.structuredContent && bytes(original.structuredContent) <= 1024 * 1024
          ? { structuredContent: original.structuredContent }
          : {}),
        _meta: { opengeniOutputTruncated: true },
      },
    },
  } as T;
}
