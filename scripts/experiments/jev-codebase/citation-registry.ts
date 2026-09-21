import { spanCovered, type Citation } from "./trajectory";

/** IDs reference exact received spans; they do not certify that a claim is supported. */
export class CitationRegistry {
  private readonly spans = new Map<string, Citation>();
  private readonly ids = new Map<string, string>();
  register(span: Citation): string {
    if (
      !span.path ||
      !Number.isInteger(span.startLine) ||
      !Number.isInteger(span.endLine) ||
      span.startLine < 1 ||
      span.endLine < span.startLine
    )
      throw new Error("invalid_citation_span");
    const key = JSON.stringify([span.path, span.startLine, span.endLine]),
      existing = this.ids.get(key);
    if (existing) return existing;
    const id = `c${this.spans.size}`;
    this.ids.set(key, id);
    this.spans.set(id, { path: span.path, startLine: span.startLine, endLine: span.endLine });
    return id;
  }
  resolve(ids: unknown, delivered: Citation[]): Citation[] {
    if (!Array.isArray(ids) || ids.length > 20 || ids.some((id) => typeof id !== "string"))
      throw new Error("invalid_citation_ids");
    return [...new Set(ids as string[])].map((id) => {
      const span = this.spans.get(id);
      if (!span || !spanCovered(span, delivered)) throw new Error("citation_not_delivered");
      return { ...span };
    });
  }
}
