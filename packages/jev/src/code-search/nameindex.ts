/**
 * nameindex.ts - match the QUESTION's own words against the workspace's declared names and file paths,
 * without Jev.
 *
 * The caller's keywords are guesses; the question usually names the feature in plain words ("the Artifacts
 * page", "tab switches", "cache"). One ripgrep pass (run alongside keyword recall) lists declarations whose
 * name contains a question word stem (`useArtifactCatalog` = use, artifact, catalog). A name scores by the
 * rarity of the distinct question stems it contains; a file by its best name plus its path words. The best
 * files join file triage as candidates, and the best names are real identifiers the search can recall with
 * when the caller's keywords matched nothing relevant.
 */
import type { CodeSearchConfig } from "./config";
import { DEF_SCAN_EXCLUDES, LEAD_STOPLIST, TEST_EXCLUDES } from "./leads";
import { specificName } from "./symbols";
import type { WorkspaceSession } from "./session";
import { escapeRegex, splitWords } from "./text";
import { keywordStems } from "./vocab";
import { CODE_SEARCH_MAX_PATTERN_CHARS } from "./workspace";

/** Question words that describe the task, not the code (plus the usual stopwords, dropped by keywordStems). */
const QUESTION_STOP = new Set(
  (
    "code codebase repo repository file files function functions method implement implementation implemented " +
    "where find show shows change changes add adding value values data check checks called call calls return " +
    "returns existing exist handle handles handled work works working behavior behaviour logic flow flows " +
    "path paths part parts place places line lines test tests question answer need needs needed new old right " +
    "wrong current currently time long take takes back come coming again also like include including relevant " +
    "related open opens opened pressing press click clicks load loads loading take taking point points entry " +
    "entries upon versus without pass passes cause causes appear appears another explicit explicitly prevent " +
    "reuse pattern patterns exact exactly whole across within inside outside via behind make sure ensure " +
    "possible possibly other others instead identify determine decide decides decided happen affect affects"
  ).split(/\s+/),
);

/** Distinct stems (>= 4 chars) of the question's content words. */
export function questionStems(text: string): string[] {
  const out = new Set<string>();
  for (const tok of text.match(/[A-Za-z][A-Za-z0-9_-]*/g) ?? []) {
    for (const w of splitWords(tok)) {
      if (QUESTION_STOP.has(w)) continue;
      for (const s of keywordStems(w)) if (s.length >= 4) out.add(s);
    }
  }
  return [...out];
}

const DECL_NAME =
  /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:function\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait)\s+([A-Za-z_$][\w$]*)/;

export interface NameHit {
  name: string;
  path: string;
  line: number;
  text: string;
  score: number;
  stems: string[];
}

export interface NameIndexResult {
  stems: string[];
  /** Best-scoring names (one per name, its strongest declaration), best first. */
  names: NameHit[];
  /** Files ranked by their best name plus matching path words. */
  files: Array<{ path: string; score: number; hits: NameHit[] }>;
  declarations: number;
  ms: number;
}

/** Stems a name's words start with (word-prefix match, so `artifact` matches `Artifacts`). */
function matchedStems(words: string[], stems: string[]): string[] {
  return stems.filter((s) => words.some((w) => w.startsWith(s)));
}

export async function nameIndex(o: {
  session: WorkspaceSession;
  question: string;
  /** Every file in the search scope (from recall's file listing), for path words. */
  files: string[];
  paths: string[];
  cfg: CodeSearchConfig;
  excludeArgs: string[];
  allowTests: boolean;
  maxFiles: number;
}): Promise<NameIndexResult> {
  const t0 = performance.now();
  const stems = questionStems(o.question);
  const empty = { stems, names: [], files: [], declarations: 0, ms: 0 };
  if (!stems.length) return empty;
  const alt = stems.map(escapeRegex).join("|");
  const pattern = `^\\s{0,4}(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:pub(?:\\([^)]*\\))?\\s+)?(?:function\\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait)\\s+[A-Za-z_$0-9]*(?:${alt})`;
  if (pattern.length > CODE_SEARCH_MAX_PATTERN_CHARS) return empty;
  const extra = [...DEF_SCAN_EXCLUDES, ...(o.allowTests ? [] : TEST_EXCLUDES)].flatMap((g) => ["-g", g]);
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
      "40",
      "--max-columns",
      "300",
      "--max-filesize",
      String(o.cfg.recall.maxFileBytes),
      ...o.excludeArgs,
      ...extra,
      "-e",
      pattern,
      "--",
      ...(o.paths.length ? o.paths : ["."]),
    ],
    { allowFailure: true },
  );
  const decls: Array<{ name: string; path: string; line: number; text: string; words: string[] }> = [];
  for (const row of out.split("\n")) {
    const z = row.indexOf("\0");
    if (z <= 0) continue;
    const colon = row.indexOf(":", z + 1);
    if (colon < 0) continue;
    const text = row.slice(colon + 1);
    const m = DECL_NAME.exec(text);
    if (!m || !specificName(m[1]!) || LEAD_STOPLIST.has(m[1]!)) continue;
    decls.push({
      name: m[1]!,
      path: row.slice(0, z).replace(/^\.\//, ""),
      line: Number(row.slice(z + 1, colon)),
      text: text.trim().slice(0, 200),
      words: splitWords(m[1]!),
    });
  }
  // rarity of each stem among the declared names that contain any question stem
  const df = new Map<string, number>();
  const n = Math.max(decls.length, 1);
  for (const d of decls) for (const s of matchedStems(d.words, stems)) df.set(s, (df.get(s) ?? 0) + 1);
  const idf = (s: string) => Math.log(1 + n / (1 + (df.get(s) ?? 0)));
  const maxIdf = Math.log(1 + n);
  const byName = new Map<string, NameHit>();
  const byFile = new Map<string, NameHit[]>();
  for (const d of decls) {
    const ms = matchedStems(d.words, stems);
    // one common stem alone (config, session) says little; two stems, or one rare stem, say more
    if (!ms.length || (ms.length === 1 && idf(ms[0]!) < 0.6 * maxIdf)) continue;
    // share of the name's words the question explains; long snake_case test names explain little
    const cover = ms.length / Math.max(1, d.words.length);
    const score = (ms.reduce((s, x) => s + idf(x), 0) * (0.5 + cover)) / (d.words.length > 5 ? 2 : 1);
    const hit: NameHit = { name: d.name, path: d.path, line: d.line, text: d.text, score, stems: ms };
    const prev = byName.get(d.name);
    if (!prev || prev.score < score) byName.set(d.name, hit);
    const arr = byFile.get(d.path) ?? [];
    arr.push(hit);
    byFile.set(d.path, arr);
  }
  const fileStems = new Map<string, string[]>();
  for (const f of o.files) {
    const ms = matchedStems(splitWords(f), stems);
    if (ms.length) fileStems.set(f, ms);
  }
  const files = [...byFile.entries()]
    .map(([path, hits]) => {
      hits.sort((a, b) => b.score - a.score || a.line - b.line);
      const pathScore = 0.5 * (fileStems.get(path) ?? []).reduce((s, x) => s + idf(x), 0);
      return { path, score: hits[0]!.score + 0.25 * (hits.length - 1) ** 0.5 + pathScore, hits: hits.slice(0, 5) };
    })
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
    .slice(0, o.maxFiles);
  const names = [...byName.values()].sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  return { stems, names, files, declarations: decls.length, ms: Math.round(performance.now() - t0) };
}
