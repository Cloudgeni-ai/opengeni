/**
 * Artifact ids of every `generated_image` receipt in a value (session events),
 * in the order they appear. Receipts nest objects (retention, retrieval), so
 * this walks the structure instead of pattern-matching text.
 */
export function generatedImageIds(value: unknown): string[] {
  const ids: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.kind === "generated_image" && typeof record.artifactId === "string") {
      if (!ids.includes(record.artifactId)) ids.push(record.artifactId);
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(value);
  return ids;
}
