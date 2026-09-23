import type { KnowledgeEntryContent } from "@opengeni/contracts";

export type KnowledgeIndexChunk = {
  index: number;
  field: "title" | "content";
  start: number;
  end: number;
  text: string;
  embeddingInput: string;
};

/** Rebuildable excerpts. Offsets use the same UTF-16 units as knowledge_get. */
export function* knowledgeIndexChunks(
  entry: Pick<KnowledgeEntryContent, "title" | "content">,
): Generator<KnowledgeIndexChunk> {
  const field = entry.content.length ? "content" : "title";
  const text = field === "content" ? entry.content : entry.title;
  const size = 1200;
  const overlap = 160;
  let start = 0;
  let index = 0;
  const scalarBoundary = (at: number) => {
    const code = text.charCodeAt(at);
    const previous = text.charCodeAt(at - 1);
    return code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff
      ? at - 1
      : at;
  };
  while (start < text.length) {
    const end = scalarBoundary(Math.min(start + size, text.length));
    const excerpt = text.slice(start, end);
    yield {
      index,
      field,
      start,
      end,
      text: excerpt,
      embeddingInput: field === "content" ? `${entry.title}\n${excerpt}` : excerpt,
    };
    if (end === text.length) return;
    start = scalarBoundary(end - overlap);
    index += 1;
  }
}
