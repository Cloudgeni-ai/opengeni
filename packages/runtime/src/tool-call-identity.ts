/**
 * Resolve the stable correlation id carried by an SDK tool call or result.
 *
 * Most SDK items expose the id directly as `callId` (or the wire-format
 * `call_id`). Native tool-search items can instead keep their only stable id
 * inside `providerData`, so every persistence and replay boundary must inspect
 * both shapes before falling back to a stream-item id.
 */
export function toolCallIdFromSdkItem(item: unknown): string | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const record = item as { callId?: unknown; call_id?: unknown; providerData?: unknown };
  if (typeof record.callId === "string" && record.callId.length > 0) {
    return record.callId;
  }
  if (typeof record.call_id === "string" && record.call_id.length > 0) {
    return record.call_id;
  }
  const provider = record.providerData as
    | { call_id?: unknown; callId?: unknown }
    | null
    | undefined;
  if (provider && typeof provider === "object") {
    if (typeof provider.call_id === "string" && provider.call_id.length > 0) {
      return provider.call_id;
    }
    if (typeof provider.callId === "string" && provider.callId.length > 0) {
      return provider.callId;
    }
  }
  return undefined;
}
