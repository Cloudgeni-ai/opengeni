/**
 * recall.ts - wide, deterministic lexical recall with ripgrep.
 *
 * One ripgrep pass over the union of every keyword's identifier variants, searched case-insensitively
 * (camelCase <-> snake_case <-> kebab <-> spaced phrase; SCREAMING and Pascal forms are covered by -i);
 * lines are attributed to keywords in JS. Short plain words get a leading word boundary so `turn` does not
 * match `return`. Per-file score = sum over DISTINCT matched keywords of IDF + path bonus + a small
 * hit-count tie breaker; tests are down-weighted unless the question is about tests.
 */
import type { CodeSearchConfig } from "./config";
import { mapLimit, READ_CONCURRENCY, type WorkspaceSession } from "./session";
import {
  compoundFragments,
  escapeRegex,
  isChangelogPath,
  isDocPath,
  isShortPlainWord,
  isTestPath,
  keywordVariants,
  questionMentionsHistory,
  questionMentionsTests,
  splitWords,
} from "./text";

export const BUILTIN_EXCLUDES = [
  "!**/node_modules/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/.next/**",
  "!**/coverage/**",
  "!**/target/**",
  "!**/vendor/**",
  "!**/.git/**",
  // a linked worktree has a `.git` FILE (gitdir pointer), which --hidden would otherwise search
  "!**/.git",
  "!**/.turbo/**",
  "!*.lock",
  "!**/package-lock.json",
  "!**/pnpm-lock.yaml",
  "!**/yarn.lock",
  "!**/bun.lockb",
  "!*.min.js",
  "!*.min.css",
  "!*.map",
  "!*.snap",
  "!**/*.gen.*",
  "!**/*.generated.*",
  "!**/gen/**",
  "!**/*_pb.*",
  "!**/*.pb.go",
  "!*.{svg,png,jpg,jpeg,gif,ico,webp,woff,woff2,ttf,otf,eot,wasm,pdf,zip,gz,tgz,mp4,mp3,mov}",
];

export interface KeywordInfo {
  index: number;
  raw: string;
  variants: string[];
  /** "phrase" = any variant as a substring; "word-prefix" = `\bword`. */
  mode: "phrase" | "word-prefix";
  /** JS-dialect pattern (attribution, window scoring, line cutting). */
  pattern: string;
  /** ripgrep-dialect pattern: same language, but word boundaries are ASCII `(?-u:\b)`. */
  rgPattern: string;
  /** Number of files with at least one matching line (content). */
  df: number;
  /** Files whose path matches (no content needed). */
  pathDf: number;
  hitLines: number;
  idf: number;
  /** Fragments used because the full keyword had zero hits. */
  fragments: string[];
}

export interface HitLine {
  line: number;
  text: string;
  kws: number[];
}

export interface FileCandidate {
  path: string;
  lexScore: number;
  /** keyword index -> matching line count */
  kwHits: Record<number, number>;
  pathKws: number[];
  hitLines: Map<number, HitLine>;
  isTest: boolean;
  isDoc: boolean;
}

export interface RecallResult {
  keywords: KeywordInfo[];
  totalFiles: number;
  candidates: FileCandidate[];
  scoredFiles: number;
  searchPaths: string[];
  widened: boolean;
  /** Path prefixes that do not exist in the workspace (or are not workspace-relative); ignored. */
  missingPrefixes: string[];
  /** The path prefixes that exist, workspace-relative. */
  validPrefixes: string[];
  /** Path-only candidates dropped because their content is binary (NUL in the first 8 KB). */
  binaryDropped: number;
  ms: number;
}

export interface RecallInput {
  session: WorkspaceSession;
  question: string;
  keywords: string[];
  pathPrefixes: string[];
  config: CodeSearchConfig;
}

export function excludeArgs(cfg: CodeSearchConfig): string[] {
  return [
    ...BUILTIN_EXCLUDES,
    ...cfg.recall.extraExcludes.map((g) => (g.startsWith("!") ? g : `!${g}`)),
  ].flatMap((g) => ["-g", g]);
}

/** `--hidden` (rg skips dot-dirs such as .github/ by default); `.git/` stays excluded by BUILTIN_EXCLUDES. */
export function hiddenArgs(cfg: CodeSearchConfig): string[] {
  return cfg.recall.searchHidden ? ["--hidden"] : [];
}

export async function listFiles(
  session: WorkspaceSession,
  paths: string[],
  cfg: CodeSearchConfig,
): Promise<string[]> {
  const out = await session.ripgrep([
    "--files",
    "--no-require-git",
    ...hiddenArgs(cfg),
    "--max-filesize",
    String(cfg.recall.maxFileBytes),
    ...excludeArgs(cfg),
    "--",
    ...paths,
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace(/^\.\//, ""))
    .sort();
}

/**
 * Search pattern for one keyword. `pattern` is JS-dialect; `rgPattern` is the same for ripgrep except that the
 * word boundary is ASCII: a Unicode `\b` under -i disables ripgrep's fast engines (measured on repo-snap: 5.6 s
 * user CPU for one pass vs 0.2 s with `(?-u:\b)`), and JS `\b` is ASCII anyway.
 */
export function buildPattern(
  kw: string,
  cfg: CodeSearchConfig,
): { pattern: string; rgPattern: string; mode: "phrase" | "word-prefix"; variants: string[] } {
  const variants = keywordVariants(kw);
  if (variants.length === 1 && isShortPlainWord(variants[0]!, cfg.recall.shortWordMaxLen)) {
    const lit = escapeRegex(variants[0]!);
    return { pattern: `\\b${lit}`, rgPattern: `(?-u:\\b)${lit}`, mode: "word-prefix", variants };
  }
  // spaced-phrase variants match any run of whitespace
  const alts = variants.map((v) => escapeRegex(v).replace(/ /g, "\\s+"));
  return { pattern: alts.join("|"), rgPattern: alts.join("|"), mode: "phrase", variants };
}

/** Pattern for the 2-word fragments of a compound keyword (used only if the full keyword has zero hits). */
export function fragmentPattern(frags: string[]): string {
  return frags
    .flatMap((f) => keywordVariants(f))
    .map((v) => escapeRegex(v).replace(/ /g, "\\s+"))
    .join("|");
}

export interface RgMatch {
  path: string;
  line: number;
  text: string;
}

/** Parse `rg --null --line-number --with-filename --no-heading` output. Omitted long lines are skipped. */
export function parseRgOutput(out: string): RgMatch[] {
  const matches: RgMatch[] = [];
  let pos = 0;
  while (pos < out.length) {
    let nl = out.indexOf("\n", pos);
    if (nl < 0) nl = out.length;
    const z = out.indexOf("\0", pos);
    if (z > pos && z < nl) {
      const colon = out.indexOf(":", z + 1);
      if (colon > z && colon < nl) {
        const line = Number(out.slice(z + 1, colon));
        const text = out.slice(colon + 1, nl).replace(/\r$/, "");
        if (Number.isFinite(line) && !text.startsWith("[Omitted long line")) {
          matches.push({ path: out.slice(pos, z).replace(/^\.\//, ""), line, text });
        }
      }
    }
    pos = nl + 1;
  }
  return matches;
}

/** One rg pass for a pattern (any number of alternatives), all matching lines, sorted by path then line. */
export async function searchPattern(
  session: WorkspaceSession,
  pattern: string,
  paths: string[],
  cfg: CodeSearchConfig,
  opts: { caseInsensitive?: boolean; word?: boolean; maxPerFile?: number } = {},
): Promise<RgMatch[]> {
  const out = await session.ripgrep([
    "--null",
    "--line-number",
    "--with-filename",
    "--no-heading",
    "--color",
    "never",
    ...(opts.caseInsensitive === false ? [] : ["-i"]),
    ...(opts.word ? ["-w"] : []),
    "--no-require-git",
    ...hiddenArgs(cfg),
    ...(opts.maxPerFile ? ["-m", String(opts.maxPerFile)] : []),
    // very long lines (minified / generated / data) are omitted by rg and skipped by the parser
    "--max-columns",
    String(cfg.recall.maxLineColumns),
    "--max-filesize",
    String(cfg.recall.maxFileBytes),
    ...excludeArgs(cfg),
    "-e",
    pattern,
    "--",
    ...paths,
  ]);
  const matches = parseRgOutput(out);
  // rg searches in parallel; sort for determinism (same effect as --sort path, without serializing the search)
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  return matches;
}

export function idfOf(df: number, n: number): number {
  return Math.log(1 + n / (1 + df));
}

/** Does the path mention the keyword (any variant, separators ignored)? */
export function pathMatches(path: string, variants: string[]): boolean {
  const flatPath = path.toLowerCase().replace(/[-_ .]/g, "");
  return variants.some((v) => {
    const flat = v.toLowerCase().replace(/[-_ ]/g, "");
    return flat.length >= 4 && flatPath.includes(flat);
  });
}

/** JS regex for an rg pattern built by buildPattern/fragmentPattern (the escapes used are valid in both dialects). */
export function jsRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export interface Slot {
  /** keyword index */
  ki: number;
  fragment: boolean;
  re: RegExp | null;
  literals: string[];
}

/**
 * Attribute rg lines to keyword slots. Returns per slot the matches (all lines; the caller caps what it stores).
 * A JS regex that fails to compile falls back to a case-insensitive literal test on the variants.
 */
export function attribute(matches: RgMatch[], slots: Slot[]): RgMatch[][] {
  const out: RgMatch[][] = slots.map(() => []);
  for (const m of matches) {
    const lower = m.text.toLowerCase();
    slots.forEach((s, i) => {
      const hit = s.re ? s.re.test(m.text) : s.literals.some((l) => lower.includes(l));
      if (hit) out[i]!.push(m);
    });
  }
  return out;
}

/**
 * Normalize path prefixes to workspace-relative form ("./src/" -> "src"); prefixes that do not exist, are
 * absolute or climb out with ".." are reported as missing instead of crashing ripgrep (exit 2, no output).
 */
export async function normalizePrefixes(
  session: WorkspaceSession,
  prefixes: string[],
): Promise<{ ok: string[]; missing: string[] }> {
  const cleaned = prefixes.map((raw) => ({ raw, rel: cleanPrefix(raw) }));
  const lookup = [
    ...new Set(cleaned.map((c) => c.rel).filter((r): r is string => r !== null && r !== ".")),
  ];
  const kinds = lookup.length ? await session.pathKinds(lookup) : {};
  const ok: string[] = [];
  const missing: string[] = [];
  for (const { raw, rel } of cleaned) {
    if (rel === ".") ok.push(".");
    else if (rel !== null && (kinds[rel] === "file" || kinds[rel] === "directory")) ok.push(rel);
    else missing.push(raw);
  }
  return { ok: [...new Set(ok)], missing };
}

/** Workspace-relative form of a prefix, or null when it is absolute, climbs out, or starts with "-". */
export function cleanPrefix(p: string): string | null {
  let s = p.trim().replace(/\\/g, "/");
  if (!s || s.startsWith("/") || s.startsWith("~") || /^[A-Za-z]:\//.test(s)) return null;
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  if (s === "" || s === ".") return ".";
  if (s.startsWith("-") || s.split("/").some((seg) => seg === "..")) return null;
  return s;
}

/** Binary (NUL in the first 8 KB, ripgrep's own heuristic) or unreadable. */
async function looksBinary(
  session: WorkspaceSession,
  path: string,
  bytes = 8192,
): Promise<boolean> {
  return (await session.readText(path, bytes)) === null;
}

export async function recall(input: RecallInput): Promise<RecallResult> {
  const t0 = performance.now();
  const cfg = input.config;
  const session = input.session;
  // any whitespace run (newline, tab) becomes one space: a literal newline is not allowed in an rg pattern
  const kwsRaw = [
    ...new Set(
      input.keywords.map((k) => k.replace(/\s+/g, " ").trim()).filter((k) => k.length >= 2),
    ),
  ];
  const prefixes = await normalizePrefixes(session, input.pathPrefixes);
  let searchPaths = prefixes.ok.length ? prefixes.ok : ["."];
  // every -p prefix missing: search the whole repository (reported as widened)
  let widened = input.pathPrefixes.length > 0 && prefixes.ok.length === 0;

  const keywordsFresh = (): KeywordInfo[] =>
    kwsRaw.map((raw, index) => {
      const { pattern, rgPattern, mode, variants } = buildPattern(raw, cfg);
      return {
        index,
        raw,
        variants,
        mode,
        pattern,
        rgPattern,
        df: 0,
        pathDf: 0,
        hitLines: 0,
        idf: 0,
        fragments: [],
      };
    });

  /**
   * ONE rg pass over the union of every keyword pattern (and, speculatively, the 2-word fragments of
   * compound keywords); lines are then attributed to keywords in JS. ~0.2 s on a 6k-file repo versus
   * ~1-2 s for one rg process per keyword.
   */
  const attempt = async (paths: string[]) => {
    const keywords = keywordsFresh();
    const slots: Slot[] = [];
    const fragsOf = new Map<number, { frags: string[]; pattern: string }>();
    for (const k of keywords) {
      slots.push({
        ki: k.index,
        fragment: false,
        re: jsRegex(k.pattern),
        literals: k.variants.map((v) => v.toLowerCase()),
      });
      const frags = cfg.recall.fragmentFallback ? compoundFragments(k.raw) : [];
      if (frags.length) {
        const pattern = fragmentPattern(frags);
        fragsOf.set(k.index, { frags, pattern });
        slots.push({
          ki: k.index,
          fragment: true,
          re: jsRegex(pattern),
          literals: frags.flatMap((f) => keywordVariants(f)).map((v) => v.toLowerCase()),
        });
      }
    }
    const union = [
      ...keywords.map((k) => k.rgPattern),
      ...[...fragsOf.values()].map((f) => f.pattern),
    ]
      .map((p) => `(?:${p})`)
      .join("|");
    const [files, matches] = await Promise.all([
      listFiles(session, paths, cfg),
      union ? searchPattern(session, union, paths, cfg) : Promise.resolve([] as RgMatch[]),
    ]);
    const bySlot = attribute(matches, slots);
    const results: RgMatch[][] = keywords.map(() => []);
    slots.forEach((s, i) => {
      if (!s.fragment) results[s.ki] = bySlot[i]!;
    });
    // zero-hit compound keywords use their fragments (the model guessed a name that does not exist)
    slots.forEach((s, i) => {
      if (s.fragment && results[s.ki]!.length === 0 && bySlot[i]!.length > 0) {
        results[s.ki] = bySlot[i]!;
        keywords[s.ki]!.fragments = fragsOf.get(s.ki)!.frags;
      }
    });
    return { files, keywords, results };
  };

  let { files, keywords, results } = await attempt(searchPaths);
  const countFiles = (rs: RgMatch[][]) => new Set(rs.flat().map((m) => m.path)).size;
  if (prefixes.ok.length && countFiles(results) < cfg.recall.minCandidatesBeforeWiden) {
    searchPaths = ["."];
    widened = true;
    ({ files, keywords, results } = await attempt(searchPaths));
  }

  const n = Math.max(files.length, 1);
  const byPath = new Map<string, FileCandidate>();
  const get = (path: string) => {
    let c = byPath.get(path);
    if (!c) {
      c = {
        path,
        lexScore: 0,
        kwHits: {},
        pathKws: [],
        hitLines: new Map(),
        isTest: isTestPath(path),
        isDoc: isDocPath(path),
      };
      byPath.set(path, c);
    }
    return c;
  };
  const kwFiles = keywords.map(() => new Set<string>());
  const maxStored = cfg.recall.maxMatchesPerFile;
  results.forEach((matches, ki) => {
    const kw = keywords[ki]!;
    const seen = kwFiles[ki]!;
    for (const m of matches) {
      seen.add(m.path);
      const c = get(m.path);
      const cnt = (c.kwHits[ki] = (c.kwHits[ki] ?? 0) + 1);
      // every matching line counts for scoring; only the first maxMatchesPerFile per keyword are kept as hit lines
      if (cnt > maxStored) continue;
      let h = c.hitLines.get(m.line);
      if (!h) {
        h = { line: m.line, text: m.text, kws: [] };
        c.hitLines.set(m.line, h);
      }
      if (!h.kws.includes(ki)) h.kws.push(ki);
    }
    kw.df = seen.size;
    kw.hitLines = matches.length;
  });
  // path-name matches (also for files without content hits)
  for (const kw of keywords) {
    const variants = kw.fragments.length
      ? kw.fragments.flatMap((f) => keywordVariants(f))
      : kw.variants;
    for (const f of files) {
      if (pathMatches(f, variants)) {
        kw.pathDf++;
        kwFiles[kw.index]!.add(f);
        const c = get(f);
        if (!c.pathKws.includes(kw.index)) c.pathKws.push(kw.index);
      }
    }
  }
  // IDF over files matching by content OR path
  for (const kw of keywords)
    kw.idf = kwFiles[kw.index]!.size > 0 ? idfOf(kwFiles[kw.index]!.size, n) : 0;

  const testsOk = questionMentionsTests(input.question);
  const historyOk = questionMentionsHistory(input.question);
  for (const c of byPath.values()) {
    let s = 0;
    let lines = 0;
    for (const [ki, cnt] of Object.entries(c.kwHits)) {
      s += keywords[Number(ki)]!.idf;
      lines += cnt;
    }
    for (const ki of c.pathKws) s += cfg.recall.pathBonus * keywords[ki]!.idf;
    s += cfg.recall.hitCountWeight * Math.log(1 + lines);
    if (c.isTest && !testsOk) s *= cfg.recall.testWeight;
    if (!historyOk && isChangelogPath(c.path)) s *= cfg.recall.changelogWeight;
    c.lexScore = s;
  }
  const scored = [...byPath.values()].filter((c) => c.lexScore > 0);
  scored.sort((a, b) => b.lexScore - a.lexScore || (a.path < b.path ? -1 : 1));
  // `rg --files` lists binary files too; one that matches only by path (no content hit) would be windowed as text.
  // Same result as a sequential scan: each batch holds at most the number of slots still open.
  const candidates: FileCandidate[] = [];
  let binaryDropped = 0;
  let next = 0;
  while (next < scored.length && candidates.length < cfg.recall.maxCandidates) {
    const batch = scored.slice(next, next + cfg.recall.maxCandidates - candidates.length);
    next += batch.length;
    const pathOnly = batch.filter((c) => c.hitLines.size === 0);
    const binary = new Set<FileCandidate>();
    const flags = await mapLimit(pathOnly, READ_CONCURRENCY, (c) => looksBinary(session, c.path));
    pathOnly.forEach((c, i) => {
      if (flags[i]) binary.add(c);
    });
    for (const c of batch) {
      if (binary.has(c)) binaryDropped++;
      else candidates.push(c);
    }
  }
  return {
    keywords,
    totalFiles: files.length,
    candidates,
    scoredFiles: scored.length,
    searchPaths,
    widened,
    missingPrefixes: prefixes.missing,
    validPrefixes: prefixes.ok,
    binaryDropped,
    ms: Math.round(performance.now() - t0),
  };
}

/** Weight of one hit line: sum of IDF of the distinct keywords on it. */
export function lineWeight(h: HitLine, keywords: KeywordInfo[]): number {
  return h.kws.reduce((s, k) => s + (keywords[k]?.idf ?? 0), 0);
}

/** Up to n best hit lines of a file (by distinct-keyword IDF), returned in line order (long lines are trimmed by the caller). */
export function bestHitLines(c: FileCandidate, keywords: KeywordInfo[], n: number): HitLine[] {
  return [...c.hitLines.values()]
    .sort((a, b) => lineWeight(b, keywords) - lineWeight(a, keywords) || a.line - b.line)
    .slice(0, n)
    .sort((a, b) => a.line - b.line);
}

/** Words of all keywords (for overlap scoring). */
export function keywordWords(keywords: KeywordInfo[]): Set<string> {
  return new Set(keywords.flatMap((k) => splitWords(k.raw)));
}
