/**
 * leads.ts - wave 3: identifiers referenced by relevant passages whose definitions were not read.
 *
 * Extraction (code only): called functions, imported names, PascalCase types, UPPER_CASE constants,
 * env/config keys and camelCase member accesses. Excluded: names already searched (keywords and their
 * variants), names defined inside the selected passages, a stoplist of builtins/common helpers, and
 * names shorter than 4 chars. Definitions are located with one ripgrep regex call (a few when the names do
 * not fit one pattern under CODE_SEARCH_MAX_PATTERN_CHARS).
 */
import type { CodeSearchConfig } from "./config";
import { mapLimit, RIPGREP_SPLIT_CONCURRENCY, type WorkspaceSession } from "./session";
import { escapeRegex, isTestPath, splitWords } from "./text";
import { CODE_SEARCH_MAX_PATTERN_CHARS } from "./workspace";

export interface SeedPassage {
  path: string;
  start: number;
  /** raw file lines of the passage (no `N|` prefixes) */
  lines: string[];
  rel: number;
}

export interface LeadCandidate {
  name: string;
  /** weighted frequency: sum of relevance of seed passages mentioning it + occurrence bonus */
  weight: number;
  occurrences: number;
  called: boolean;
  seenAt: { path: string; line: number };
  context: string;
  kinds: string[];
}

export const LEAD_STOPLIST = new Set(
  // JS/TS builtins, globals, utility types
  (
    "Promise Array Object String Number Boolean Map Set WeakMap WeakSet Symbol Error TypeError RangeError SyntaxError " +
    "JSON Math Date RegExp BigInt Buffer URL URLSearchParams console require parseInt parseFloat setTimeout clearTimeout " +
    "setInterval clearInterval setImmediate queueMicrotask isNaN isFinite encodeURIComponent decodeURIComponent " +
    "structuredClone fetch Response Request Headers FormData Blob File AbortController AbortSignal TextEncoder TextDecoder " +
    "Uint8Array Int32Array Float64Array ArrayBuffer DataView Record Partial Readonly ReadonlyArray Pick Omit Exclude Extract " +
    "ReturnType Parameters Awaited NonNullable Required InstanceType Iterable AsyncIterable Generator AsyncGenerator " +
    "PromiseLike Function Uppercase Lowercase keyof typeof instanceof undefined null true false this super " +
    "process Bun Deno globalThis window document performance crypto " +
    // test helpers
    "expect describe test beforeEach afterEach beforeAll afterAll mock spyOn toBe toEqual toStrictEqual toMatch " +
    "toContain toThrow toHaveBeenCalled toHaveBeenCalledWith toHaveLength toBeDefined toBeUndefined toBeNull toBeTruthy " +
    "toBeFalsy toMatchObject toBeGreaterThan toBeLessThan resolves rejects " +
    // very common methods
    "push pop shift unshift map filter reduce forEach find findIndex some every includes join split slice splice concat " +
    "indexOf lastIndexOf keys values entries from assign freeze stringify parse toString valueOf trim trimStart trimEnd " +
    "replace replaceAll match matchAll exec startsWith endsWith toLowerCase toUpperCase padStart padEnd localeCompare " +
    "then catch finally resolve reject allSettled race floor ceil round abs sqrt random sort reverse flat flatMap fill " +
    "length size delete clear warn error info debug trace assert emit once listen close write read send next done " +
    "toISOString getTime toFixed charAt charCodeAt codePointAt fromEntries isArray hasOwnProperty defineProperty " +
    "getOwnPropertyNames create apply call bind " +
    // drizzle / zod / sql helpers
    "select insert update values returning where from innerJoin leftJoin orderBy groupBy limit offset execute " +
    "inArray isNull isNotNull desc asc sql eq ne gt gte lt lte and or not like ilike between exists " +
    "object string number boolean array optional nullable nullish literal union enum infer default describe " +
    "safeParse parseAsync strict passthrough extend merge partial refine superRefine transform coerce positive " +
    "nonnegative int min max email uuid regex " +
    // SQL functions
    "coalesce count now greatest least jsonb_build_object jsonb_set jsonb_agg array_agg format lower upper nullif " +
    "current_setting set_config gen_random_uuid clock_timestamp " +
    // Rust
    "Ok Err Some None Box Vec Arc Mutex RwLock Option Result clone unwrap expect into iter collect map_err ok_or as_ref " +
    "to_string to_owned println eprintln format vec"
  ).split(/\s+/),
);

const CONTROL = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "typeof",
  "await",
  "async",
  "new",
  "else",
  "case",
  "void",
  "delete",
  "yield",
  "import",
  "export",
  "constructor",
  "super",
  "this",
  "static",
  "private",
  "public",
  "protected",
]);

/** Names declared inside a passage (so they are not leads). */
export function definedNames(text: string): Set<string> {
  const out = new Set<string>();
  const res = [
    /\bfunction\*?\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:class|interface|type|enum|namespace|struct|trait|fn|def|func|mod)\s+([A-Za-z_$][\w$]*)/g,
    /(?:FUNCTION|function)\s+(?:[\w"]+\.)?"?([A-Za-z_][\w]*)"?\s*\(/g,
    /^\s*(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\([^;]*\)\s*(?::[^={;]+)?\{\s*$/gm,
  ];
  for (const re of res) for (const m of text.matchAll(re)) if (!CONTROL.has(m[1]!)) out.add(m[1]!);
  // destructured consts: const { a, b: c } = ...
  for (const m of text.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.split(":").pop()!.split("=")[0]!.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return out;
}

/** Raw identifier occurrences (name, kind) in one line. */
export function identifiersInLine(line: string): Array<{ name: string; kind: string }> {
  const out: Array<{ name: string; kind: string }> = [];
  for (const m of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g))
    out.push({ name: m[1]!, kind: "call" });
  const imp = /import\s+(?:type\s+)?\{([^}]*)\}/.exec(line);
  if (imp) {
    for (const part of imp[1]!.split(",")) {
      const name = part
        .replace(/^\s*type\s+/, "")
        .split(/\s+as\s+/)[0]!
        .trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push({ name, kind: "import" });
    }
  }
  for (const m of line.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+)\b/g))
    out.push({ name: m[1]!, kind: "type" });
  for (const m of line.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g))
    out.push({ name: m[1]!, kind: "constant" });
  for (const m of line.matchAll(/\.([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*)\b/g))
    out.push({ name: m[1]!, kind: "member" });
  return out;
}

function trimContext(line: string, name: string, max = 160): string {
  const t = line.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const i = Math.max(0, t.indexOf(name) - 50);
  return (i > 0 ? "..." : "") + t.slice(i, i + max - 6) + "...";
}

/**
 * Extract lead candidates from seed passages (most relevant first), ranked by weighted frequency.
 * `searched` = lowercased keywords + variants (already searched; not leads).
 */
export function extractLeads(
  seeds: SeedPassage[],
  searched: Set<string>,
  questionWords: Set<string>,
  max: number,
): LeadCandidate[] {
  const defined = new Set<string>();
  for (const s of seeds) for (const n of definedNames(s.lines.join("\n"))) defined.add(n);
  const byName = new Map<string, LeadCandidate>();
  for (const s of seeds) {
    const inThis = new Set<string>();
    const prose = /\.(md|mdx|txt|rst)$/i.test(s.path);
    const sql = /\.sql$/i.test(s.path);
    s.lines.forEach((line, i) => {
      if (!prose && /^\s*(\/\/|\*|\/\*|#(?!\[)|--)/.test(line)) return; // code comments: skip
      // prose: only identifiers inside `backticks`
      const scan = prose ? (line.match(/`[^`]+`/g) ?? []).join(" ") : line;
      if (!scan) return;
      for (const { name, kind } of identifiersInLine(scan)) {
        if (name.length < 4 || CONTROL.has(name) || LEAD_STOPLIST.has(name) || defined.has(name))
          continue;
        if (sql && /^[A-Z]+$/.test(name)) continue; // SQL keywords followed by "(" (CHECK, EXISTS, VALUES) are not calls
        if (searched.has(name.toLowerCase()) || searched.has(splitWords(name).join(" "))) continue;
        let c = byName.get(name);
        if (!c) {
          c = {
            name,
            weight: 0,
            occurrences: 0,
            called: false,
            seenAt: { path: s.path, line: s.start + i },
            context: trimContext(line, name),
            kinds: [],
          };
          byName.set(name, c);
        }
        c.occurrences++;
        if (kind === "call") c.called = true;
        if (!c.kinds.includes(kind)) c.kinds.push(kind);
        if (!inThis.has(name)) {
          c.weight += s.rel;
          inThis.add(name);
        }
      }
    });
  }
  const score = (c: LeadCandidate) => {
    const words = splitWords(c.name);
    const ov = words.filter((w) => questionWords.has(w)).length / Math.max(1, words.length);
    return c.weight + 0.1 * Math.min(5, c.occurrences - 1) + (c.called ? 0.2 : 0) + ov;
  };
  return [...byName.values()]
    .sort((a, b) => score(b) - score(a) || (a.name < b.name ? -1 : 1))
    .slice(0, max)
    .map((c) => ({ ...c, weight: Math.round(score(c) * 1000) / 1000 }));
}

export interface DefinitionHit {
  name: string;
  path: string;
  line: number;
  kind: "decl" | "sqlfn" | "method" | "key";
  text: string;
}

/** The JS regexes used to classify an rg match line for one name (priority order). */
export function definitionKinds(name: string): Array<{ kind: DefinitionHit["kind"]; re: RegExp }> {
  const n = escapeRegex(name);
  return [
    {
      kind: "decl",
      re: new RegExp(
        `\\b(?:function\\*?|const|let|var|class|interface|type|enum|namespace|struct|trait|fn|def|func|mod)\\s+${n}\\b`,
      ),
    },
    { kind: "sqlfn", re: new RegExp(`\\bfunction\\s+(?:[\\w"]+\\.)?"?${n}"?\\s*\\(`, "i") },
    {
      kind: "method",
      re: new RegExp(
        `^\\s*(?:(?:public|private|protected|static|async|readonly|override|get|set)\\s+)*${n}\\s*(?:<[^>()]*>)?\\s*\\([^;]*(?:\\{|\\(|,)\\s*$`,
      ),
    },
    { kind: "key", re: new RegExp(`^\\s*["']?${n}["']?\\??\\s*[:=]`) },
  ];
}

/**
 * rg pattern (ASCII mode) for definition-shaped lines of any of the names: declarations, SQL functions,
 * methods and object keys / fields / config keys. Classified per name in JS with definitionKinds().
 */
export function definitionPattern(names: readonly string[]): string {
  const alt = names.map(escapeRegex).join("|");
  return (
    "(?-u:" +
    [
      `\\b(?:function\\*?|const|let|var|class|interface|type|enum|namespace|struct|trait|fn|def|func|mod)\\s+(?:${alt})\\b`,
      `(?i:function)\\s+(?:[\\w"]+\\.)?"?(?:${alt})"?\\s*\\(`,
      `^\\s*(?:(?:public|private|protected|static|async|readonly|override|get|set)\\s+)*(?:${alt})\\s*(?:<[^>()]*>)?\\s*\\(`,
      `^\\s*["']?(?:${alt})["']?\\??\\s*[:=]`,
    ].join("|") +
    ")"
  );
}

/**
 * definitionPattern over consecutive groups of names, each pattern at most maxChars. A name whose own pattern
 * is longer is left out: it gets no definition, as after a failed search.
 */
export function definitionPatterns(
  names: readonly string[],
  maxChars = CODE_SEARCH_MAX_PATTERN_CHARS,
): string[] {
  const out: string[] = [];
  let group: string[] = [];
  for (const name of names) {
    if (definitionPattern([name]).length > maxChars) continue;
    if (group.length && definitionPattern([...group, name]).length > maxChars) {
      out.push(definitionPattern(group));
      group = [];
    }
    group.push(name);
  }
  if (group.length) out.push(definitionPattern(group));
  return out;
}

const KIND_RANK: Record<DefinitionHit["kind"], number> = { decl: 3, sqlfn: 3, method: 2, key: 1 };

/** Package root of a path: the first two segments for apps/ and packages/ (apps/worker, packages/runtime), else the first. */
export function packageOf(path: string): string {
  const parts = path.split("/");
  return /^(apps|packages|services|libs|crates)$/.test(parts[0] ?? "") && parts.length > 2
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? "");
}

/**
 * Choose the best definitions per name. A name can be defined in many places (`search`, `isRecord`), so locality
 * dominates: the file where the lead was seen, then its package; then kind rank (declaration > method > key),
 * non-test, an already-selected file, a config-ish path for keys, path, line.
 */
export function chooseDefinitions(
  hits: DefinitionHit[],
  preferPaths: Set<string>,
  perName: number,
  allowTests = false,
  seenAt: Map<string, string> = new Map(),
): Map<string, DefinitionHit[]> {
  const by = new Map<string, DefinitionHit[]>();
  for (const h of hits) {
    if (!allowTests && isTestPath(h.path)) continue;
    const arr = by.get(h.name) ?? [];
    arr.push(h);
    by.set(h.name, arr);
  }
  const rank = (h: DefinitionHit) =>
    (seenAt.get(h.name) === h.path ? 100 : 0) +
    (seenAt.has(h.name) && packageOf(seenAt.get(h.name)!) === packageOf(h.path) ? 50 : 0) +
    KIND_RANK[h.kind] * 10 +
    (isTestPath(h.path) ? 0 : 4) +
    (preferPaths.has(h.path) ? 2 : 0) +
    (h.kind === "key" && /config|setting|schema|env/i.test(h.path) ? 1 : 0);
  const out = new Map<string, DefinitionHit[]>();
  for (const [name, arr] of by) {
    arr.sort(
      (a, b) => rank(b) - rank(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line),
    );
    out.set(name, arr.slice(0, perName));
  }
  return out;
}

export interface DefinitionSearch {
  hits: DefinitionHit[];
  /** name -> number of repository files that mention it as a word (for an IDF-style genericity penalty) */
  fileCounts: Map<string, number>;
  ms: number;
}

/** Files a definition search never needs: prose/data (definitions of code identifiers live in code or SQL). */
export const DEF_SCAN_EXCLUDES = ["!*.{md,mdx,txt,rst,json,jsonc,html,csv,svg,snap,xml}"];
/** Test files, excluded from the definition scan unless the question is about tests. */
export const TEST_EXCLUDES = [
  "!**/test/**",
  "!**/tests/**",
  "!**/__tests__/**",
  "!**/e2e/**",
  "!**/fixtures/**",
  "!*.test.*",
  "!*.spec.*",
];

/**
 * ONE rg pass (ASCII-mode regex, full lines) for definition-shaped lines of all names over code and SQL files
 * (tests only when the question is about tests), classified per name in JS: declarations/SQL functions/methods
 * first; object keys / fields / config keys (`name:` / `name =`) only for names without a stronger definition,
 * and a name whose only definitions are more than maxKeyOnlyDefs keys is a generic field (sessionId, accountId)
 * and gets none. fileCounts = files with any definition-shaped line for the name (generic fields and helpers
 * redefined everywhere score high), used as a genericity penalty. About 0.4 CPU-s on a 6k-file repository; a
 * second pass that counted every mention cost another ~0.7 CPU-s and full-line mention output was 80k lines.
 * Names that do not fit one pattern under the cap are searched in a few passes, merged line by line.
 * A failed definition search yields no hits (the leads are then dropped), as in scout.
 */
export async function locateDefinitions(
  session: WorkspaceSession,
  names: string[],
  cfg: CodeSearchConfig,
  excludeArgs: string[],
  maxKeyOnlyDefs = 12,
  allowTests = false,
): Promise<DefinitionSearch> {
  const t0 = performance.now();
  if (!names.length) return { hits: [], fileCounts: new Map(), ms: 0 };
  const extra = [...DEF_SCAN_EXCLUDES, ...(allowTests ? [] : TEST_EXCLUDES)].flatMap((g) => [
    "-g",
    g,
  ]);
  const defOuts = await mapLimit(definitionPatterns(names), RIPGREP_SPLIT_CONCURRENCY, (pattern) =>
    session.ripgrep(
      [
        "--null",
        "--line-number",
        "--with-filename",
        "--no-heading",
        "--color",
        "never",
        "--no-require-git",
        "--max-columns",
        String(cfg.recall.maxLineColumns),
        "--max-filesize",
        String(cfg.recall.maxFileBytes),
        ...excludeArgs,
        ...extra,
        "-e",
        pattern,
        "--",
        ".",
      ],
      { allowFailure: true },
    ),
  );
  const kinds = new Map(names.map((n) => [n, definitionKinds(n)]));
  const nameSet = new Set(names);
  const files = new Map<string, Set<string>>();
  const strong: DefinitionHit[] = [];
  const keys: DefinitionHit[] = [];
  const seenRows = new Set<string>();
  for (const row of defOuts.flatMap((out) => out.split("\n"))) {
    const z = row.indexOf("\0");
    if (z <= 0) continue;
    const colon = row.indexOf(":", z + 1);
    if (colon < 0) continue;
    // a line matched by two of the split patterns is classified once, as with one pattern
    const at = row.slice(0, colon);
    if (seenRows.has(at)) continue;
    seenRows.add(at);
    const text = row.slice(colon + 1);
    if (text.length > 400 || text.startsWith("[Omitted long line")) continue; // a definition line is short
    const path = row.slice(0, z).replace(/^\.\//, "");
    const line = Number(row.slice(z + 1, colon));
    const present = new Set((text.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((t) => nameSet.has(t)));
    for (const name of present) {
      for (const k of kinds.get(name)!) {
        if (!k.re.test(text)) continue;
        (k.kind === "key" ? keys : strong).push({
          name,
          path,
          line,
          kind: k.kind,
          text: text.trim().slice(0, 200),
        });
        let fs = files.get(name);
        if (!fs) files.set(name, (fs = new Set()));
        fs.add(path);
        break;
      }
    }
  }
  const hasStrong = new Set(strong.map((h) => h.name));
  const keyHits = keys.filter((h) => !hasStrong.has(h.name));
  const keyCount = new Map<string, number>();
  for (const h of keyHits) keyCount.set(h.name, (keyCount.get(h.name) ?? 0) + 1);
  const hits = [...strong, ...keyHits.filter((h) => (keyCount.get(h.name) ?? 0) <= maxKeyOnlyDefs)];
  hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  const fileCounts = new Map(names.map((n) => [n, files.get(n)?.size ?? 0]));
  return { hits, fileCounts, ms: Math.round(performance.now() - t0) };
}
