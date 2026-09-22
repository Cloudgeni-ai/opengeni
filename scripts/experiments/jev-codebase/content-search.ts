import { hash, type Chunk, type Request } from "./core";
import { SourceTools } from "./trajectory";

const STOP = new Set(
  "the and for with from that this does source file code return whether only what when which would could should can how have has are was will into after before then than they their there these those its not true false question context inspect evaluate explain supplied exactly different consider already through without under remains first subsequent".split(
    " ",
  ),
);
/** No model call and no filename matching. Explicit tool terms take precedence. */
export function searchTerms(request: Request): string[] {
  const words =
    `${request.question} ${request.context ?? ""}`.match(/[A-Za-z_$][A-Za-z0-9_$-]{2,}/g) ?? [];
  const terms = (request.searchHints ?? words.filter((w) => !STOP.has(w.toLowerCase())))
    .filter((s) => typeof s === "string")
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 120);
  return [...new Map(terms.map((s) => [s.toLowerCase(), s])).values()].slice(0, 32);
}

export type ContentHit = Chunk & { matchLine: number; matchedTerms: string[] };
/** Shared deterministic retrieval for both arms. Scores only matches in source text. */
function searchContentInternal(
  source: SourceTools,
  queries: string[],
  offset = 0,
  deadlineAt = performance.now() + 2000,
) {
  if (
    queries.length > 32 ||
    queries.some((q) => typeof q !== "string" || q.length < 2 || q.length > 120) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 50000
  )
    throw new Error("invalid_content_search");
  const normalized = [...new Set(queries.map((q) => q.toLowerCase()))];
  if (!queries.length) return emptySearch(queries, offset, "no_search_terms");
  const raw: { file: Chunk; lines: string[]; line: number; matches: string[]; score: number }[] =
    [];
  const seen = new Set<string>();
  const frequency = new Map(normalized.map((q) => [q, 0]));
  let scannedChars = 0,
    scannedLines = 0,
    scanTruncated = false;
  const check = () => {
    if (performance.now() > deadlineAt) throw new Error("content_search_deadline");
  };
  scan: for (const file of source.files) {
    check();
    scannedChars += file.text.length;
    if (scannedChars > 8_000_000 || source.files.length > 10000)
      throw new Error("content_search_budget");
    const lines = file.text.split("\n");
    for (const [i, text] of lines.entries()) {
      if (scannedLines++ % 512 === 0) check();
      if (scannedLines > 200000 || raw.length >= 50000) {
        scanTruncated = true;
        break scan;
      }
      const line = file.startLine + i,
        key = `${file.path}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const lower = text.toLowerCase(),
        matches = normalized.filter((q) => lower.includes(q));
      if (matches.length) {
        raw.push({ file, lines, line, matches, score: 0 });
        for (const q of matches) frequency.set(q, frequency.get(q)! + 1);
      }
    }
  }
  // Rare content terms are useful anchors; never score the path itself.
  for (const r of raw)
    r.score = r.matches.reduce((n, q) => n + Math.log(1 + raw.length / (frequency.get(q) ?? 1)), 0);
  let comparisons = 0;
  raw.sort((a, b) => {
    if (comparisons++ % 4096 === 0) check();
    return b.score - a.score || a.file.path.localeCompare(b.file.path) || a.line - b.line;
  });
  const hits: ContentHit[] = [];
  let chars = 0,
    cursor = offset,
    unavailableWindows = 0;
  for (; cursor < raw.length && hits.length < 16; cursor++) {
    check();
    const r = raw[cursor];
    let startLine = Math.max(r.file.startLine, r.line - 2),
      endLine = Math.min(r.file.endLine, r.line + 2);
    let text = r.lines
      .slice(startLine - r.file.startLine, endLine - r.file.startLine + 1)
      .join("\n");
    if (text.length > 12000) {
      startLine = endLine = r.line;
      text = r.lines[r.line - r.file.startLine];
    }
    if (text.length > 12000) {
      unavailableWindows++;
      continue;
    }
    if (chars + text.length > 16000 && hits.length) break;
    chars += text.length;
    hits.push({
      id: `h${cursor}`,
      path: r.file.path,
      startLine,
      endLine,
      text,
      matchLine: r.line,
      matchedTerms: r.matches,
    });
  }
  return {
    error: null as string | null,
    queries: [...queries],
    offset,
    hits,
    total: raw.length,
    scanTruncated,
    unavailableWindows,
    nextOffset: cursor < raw.length ? cursor : null,
    digest: hash(JSON.stringify(hits)),
    note: queries.length
      ? "Content matches, not relevance or absence proof."
      : "No valid search terms; provide bounded content queries.",
  };
}
function emptySearch(queries: string[], offset: number, error: string) {
  return {
    error,
    queries: [...queries],
    offset,
    hits: [] as ContentHit[],
    total: 0,
    scanTruncated: true,
    unavailableWindows: 0,
    nextOffset: null as number | null,
    digest: hash(JSON.stringify([])),
    note: "Search unavailable, not proof of absence.",
  };
}
export function searchContent(
  source: SourceTools,
  queries: string[],
  offset = 0,
  deadlineAt = performance.now() + 2000,
) {
  try {
    return searchContentInternal(source, queries, offset, deadlineAt);
  } catch (error) {
    if (
      error instanceof Error &&
      ["content_search_budget", "content_search_deadline"].includes(error.message)
    )
      return emptySearch(queries, offset, error.message);
    throw error;
  }
}
