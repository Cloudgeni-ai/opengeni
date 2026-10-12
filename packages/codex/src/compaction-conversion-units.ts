import { opaqueProviderArtifactFingerprint } from "./opaque-artifact";
import type { ConversionHistoryRow } from "./compaction-conversion-source";

export type ConversionWorkUnit = { text: string; coverage: string[]; key?: string };

/** Exact text-only supported projection. Unsupported structured media never disappears. */
export function conversionWorkUnits(
  rows: readonly ConversionHistoryRow[],
): ConversionWorkUnit[] | null {
  const units: ConversionWorkUnit[] = [];
  let current: ConversionWorkUnit = { text: "", coverage: [] };
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const row of rows) {
    const item = row.item;
    if (item.type === "message" && item.role === "user" && current.coverage.length) {
      if (pending.size) return null;
      units.push(current);
      current = { text: "", coverage: [] };
    }
    let portable = item;
    if (item.type === "message") {
      if (
        !["user", "assistant", "system", "developer"].includes(String(item.role)) ||
        !(
          typeof item.content === "string" ||
          (Array.isArray(item.content) &&
            item.content.every(
              (part) =>
                part &&
                typeof part === "object" &&
                ["input_text", "output_text", "text"].includes(part.type) &&
                typeof part.text === "string",
            ))
        )
      )
        return null;
    } else if (item.type === "function_call") {
      const id = item.callId ?? item.call_id;
      if (
        typeof id !== "string" ||
        !id ||
        seen.has(id) ||
        typeof item.name !== "string" ||
        typeof item.arguments !== "string"
      )
        return null;
      seen.add(id);
      pending.add(id);
    } else if (item.type === "function_call_result" || item.type === "function_call_output") {
      const id = item.callId ?? item.call_id;
      const output = item.output;
      if (
        typeof id !== "string" ||
        !pending.delete(id) ||
        !(
          typeof output === "string" ||
          (output &&
            typeof output === "object" &&
            (output as Record<string, unknown>).type === "text" &&
            typeof (output as Record<string, unknown>).text === "string")
        )
      )
        return null;
    } else if (item.type === "reasoning") {
      // Unknown reasoning fields might carry content. Support only this closed
      // shape; never strip arbitrary providerData as a convenient workaround.
      if (
        Object.keys(item).some(
          (key) =>
            !["type", "id", "encrypted_content", "encryptedContent", "summary"].includes(key),
        )
      )
        return null;
      if (
        item.summary !== undefined &&
        !(
          Array.isArray(item.summary) &&
          item.summary.every(
            (part) =>
              part &&
              typeof part === "object" &&
              part.type === "summary_text" &&
              typeof part.text === "string",
          )
        )
      )
        return null;
      if (opaqueProviderArtifactFingerprint(item) !== null || Object.keys(item).length === 1) {
        portable = {
          type: "reasoning",
          ...(item.summary === undefined ? {} : { summary: item.summary }),
        };
      }
    } else return null;
    current.coverage.push(row.id);
    current.text += `${JSON.stringify(portable)}\n`;
  }
  if (pending.size) return null;
  if (current.coverage.length) units.push(current);
  return units.length ? units : null;
}
