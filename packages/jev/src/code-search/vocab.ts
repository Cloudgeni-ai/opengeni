/**
 * vocab.ts - map the caller's keywords onto the workspace's real vocabulary.
 *
 * A keyword with zero hits, or with hits only in files the search judged irrelevant, usually means the
 * caller guessed names from another codebase or library (useQuery, staleTime, invalidateQueries in a
 * repository without react-query). The pack says so, and suggests real identifiers that share the
 * keyword's word stems, found with one ripgrep pass over the files the search looked at.
 */
import type { CodeSearchConfig } from "./config";
import type { KeywordNote } from "./pack";
import type { FileCandidate, KeywordInfo } from "./recall";
import type { WorkspaceSession } from "./session";
import { escapeRegex, splitWords, STOPWORDS } from "./text";
import { CODE_SEARCH_MAX_PATTERN_CHARS } from "./workspace";

/** Word stems of a keyword (plural/verb endings cut), at least 3 chars, stopwords dropped. */
export function keywordStems(raw: string): string[] {
  return splitWords(raw)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w))
    .map((w) =>
      w
        // "queries" and "query" share "quer"
        .replace(/(?:ies|y)$/, "")
        .replace(/(?<=\w{3})(?:es|s|ing|ed|ion|ions|er|ers)$/, "")
        .replace(/e$/, ""),
    )
    .filter((w) => w.length >= 3);
}

/** JS regex matching identifiers that contain the stems in order (case-insensitive). */
export function stemRegex(stems: string[]): RegExp | null {
  if (!stems.length) return null;
  return new RegExp(stems.map(escapeRegex).join("[\\w$]*"), "i");
}

export interface KeywordNotesInput {
  session: WorkspaceSession;
  keywords: KeywordInfo[];
  candidates: FileCandidate[];
  /** Files the search judged relevant (selected by triage with p >= T1, or with a shown passage). */
  relevantFiles: Set<string>;
  /** Files to look for suggestions in (the files the search read or triaged), workspace-relative. */
  suggestFrom: string[];
  cfg: CodeSearchConfig;
  excludeArgs: string[];
  maxSuggestions?: number;
}

export async function keywordNotes(o: KeywordNotesInput): Promise<KeywordNote[]> {
  const notes: KeywordNote[] = [];
  for (const k of o.keywords) {
    if (k.df === 0 && k.pathDf === 0) {
      notes.push({ raw: k.raw, fragments: [], suggestions: [], status: "zero" });
      continue;
    }
    if (k.fragments.length) {
      notes.push({ raw: k.raw, fragments: k.fragments, suggestions: [], status: "fragments" });
      continue;
    }
    const files = o.candidates.filter((c) => c.kwHits[k.index] || c.pathKws.includes(k.index));
    if (files.length && !files.some((c) => o.relevantFiles.has(c.path))) {
      notes.push({ raw: k.raw, fragments: [], suggestions: [], status: "irrelevant", files: k.df || files.length });
    }
  }
  if (!notes.length || !o.suggestFrom.length) return notes;
  const stems = new Map(notes.map((n) => [n.raw, keywordStems(n.raw)]));
  // ordered stems of each keyword, plus each longer stem alone for multi-word keywords
  const alts = new Set<string>();
  for (const st of stems.values()) {
    if (!st.length) continue;
    alts.add(st.map(escapeRegex).join("\\w*"));
    if (st.length > 1) for (const w of st) if (w.length >= 5) alts.add(escapeRegex(w));
  }
  if (!alts.size) return notes;
  const pattern = [...alts].join("|");
  if (pattern.length > CODE_SEARCH_MAX_PATTERN_CHARS) return notes;
  const out = await o.session.ripgrep(
    [
      "--null",
      "--line-number",
      "--with-filename",
      "--no-heading",
      "--color",
      "never",
      "--no-require-git",
      "-i",
      "-m",
      "20",
      "--max-columns",
      String(o.cfg.recall.maxLineColumns),
      ...o.excludeArgs,
      "-e",
      pattern,
      "--",
      ...o.suggestFrom,
    ],
    { allowFailure: true },
  );
  // identifier -> files, occurrences
  const seen = new Map<string, { files: Set<string>; n: number }>();
  for (const row of out.split("\n")) {
    const z = row.indexOf("\0");
    if (z <= 0) continue;
    const colon = row.indexOf(":", z + 1);
    if (colon < 0) continue;
    const path = row.slice(0, z).replace(/^\.\//, "");
    for (const id of row.slice(colon + 1).match(/[A-Za-z_$][\w$]{3,}/g) ?? []) {
      let s = seen.get(id);
      if (!s) seen.set(id, (s = { files: new Set(), n: 0 }));
      s.files.add(path);
      s.n++;
    }
  }
  const max = o.maxSuggestions ?? 3;
  for (const n of notes) {
    const st = stems.get(n.raw) ?? [];
    const ordered = stemRegex(st);
    const singles = st.filter((w) => w.length >= 5).map((w) => new RegExp(escapeRegex(w), "i"));
    const lower = n.raw.toLowerCase().replace(/[-_ ]/g, "");
    const scored: Array<{ id: string; score: number }> = [];
    for (const [id, s] of seen) {
      if (id.toLowerCase() === lower) continue;
      const full = ordered?.test(id) ?? false;
      const parts = singles.filter((re) => re.test(id)).length;
      if (!full && !parts) continue;
      const inRelevant = [...s.files].some((f) => o.relevantFiles.has(f));
      scored.push({
        id,
        score: (full ? 3 : parts) + (inRelevant ? 2 : 0) + 0.2 * Math.log(1 + s.n) + 0.3 * Math.log(1 + s.files.size),
      });
    }
    n.suggestions = scored
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, max)
      .map((x) => x.id);
  }
  return notes;
}
