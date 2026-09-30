/**
 * symbols.ts - symbol discovery: the identifiers a set of files declares, imports and calls, and where those
 * identifiers are defined and used across the workspace.
 *
 * Extraction is a language-agnostic line regex, not tree-sitter or ctags. Both would parse more exactly, but
 * tree-sitter needs a native or wasm grammar per language (the package has no runtime dependencies and runs
 * in the worker and in genigrep), and ctags is not installed in sandboxes, where the engine may run only
 * ripgrep. The regexes below take well under a millisecond per file, work on any brace, indent or SQL
 * language well enough, and the noise they let through (locals, common helpers) is what the Jev judgment
 * after them removes. Usages are found with one ripgrep pass per round (a few when the names do not fit one
 * pattern), capped per file.
 */
import type { CodeSearchConfig } from "./config";
import { DEF_SCAN_EXCLUDES, definitionKinds, LEAD_STOPLIST, TEST_EXCLUDES } from "./leads";
import { mapLimit, RIPGREP_SPLIT_CONCURRENCY, type WorkspaceSession } from "./session";
import { escapeRegex, splitWords } from "./text";
import { CODE_SEARCH_MAX_PATTERN_CHARS } from "./workspace";

export type SymbolKind = "decl" | "import" | "call" | "jsx" | "member" | "type" | "constant";

export interface SymbolOccurrence {
  name: string;
  kind: SymbolKind;
  /** 1-based line */
  line: number;
  text: string;
  /** Module an import comes from. */
  from?: string | undefined;
}

const KEYWORDS = new Set(
  (
    "if for while switch catch return function typeof await async new else case void delete yield import export " +
    "constructor super this static private public protected default from const let var class interface type enum " +
    "extends implements declare readonly abstract override get set of in as is keyof infer never unknown any " +
    "string number boolean object symbol bigint true false null undefined try finally throw break continue do with " +
    "fn pub mut impl struct trait mod use crate self Self where match loop move ref def lambda pass elif except " +
    "raise with global nonlocal func package defer range chan select go map"
  ).split(/\s+/),
);

const COMMENT = /^\s*(\/\/|\*|\/\*|#(?!\[)|--)/;

/** Declared names on one line (declarations, methods, object-property functions). */
const DECL_RES: RegExp[] = [
  /\b(?:function\*?|class|interface|type|enum|namespace|struct|trait|fn|def|func|mod)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/g,
  /^\s*(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\([^;]*\)\s*(?::[^={;]+)?\{\s*$/g,
  /^\s*([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/g,
];

/** Every symbol occurrence in a file (comments skipped; import blocks spanning lines are joined). */
export function extractSymbols(lines: string[]): SymbolOccurrence[] {
  const out: SymbolOccurrence[] = [];
  const push = (name: string, kind: SymbolKind, i: number, from?: string) => {
    if (name.length < 3 || KEYWORDS.has(name)) return;
    out.push({ name, kind, line: i + 1, text: lines[i]!.trim().slice(0, 200), ...(from ? { from } : {}) });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (COMMENT.test(line)) continue;
    // import { a, b as c } from "m" (possibly over several lines)
    if (
      /^\s*(?:import\b[^'"(]*|export\s+(?:type\s+)?)\{[^}]*$/.test(line) &&
      !/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type\s+\w|enum)\b/.test(line)
    ) {
      let j = i;
      let joined = line;
      while (j + 1 < lines.length && j - i < 60 && !/\}/.test(lines[j]!)) joined += " " + lines[++j]!;
      if (j !== i) {
        importNames(joined).forEach(({ name, from }) => push(name, "import", i, from));
        i = j;
        continue;
      }
    }
    if (
      /^\s*import\b/.test(line) ||
      /^\s*export\s+(?:type\s+)?(?:\{|\*)/.test(line) ||
      /^\s*from\s+\S+\s+import\b/.test(line) ||
      /^\s*use\s/.test(line)
    ) {
      const names = importNames(line);
      names.forEach(({ name, from }) => push(name, "import", i, from));
      if (names.length && /^\s*import\b/.test(line)) continue;
    }
    for (const re of DECL_RES) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) push(m[1]!, "decl", i);
    }
    for (const m of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g)) {
      if (line[(m.index ?? 0) - 1] === ".") continue;
      push(m[1]!, "call", i);
    }
    for (const m of line.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)) push(m[1]!, "member", i);
    for (const m of line.matchAll(/<([A-Z][\w$]*)[\s/>]/g)) push(m[1]!, "jsx", i);
    for (const m of line.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+)\b/g)) push(m[1]!, "type", i);
    for (const m of line.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) push(m[1]!, "constant", i);
  }
  return out;
}

/** Names and module of an import/export/use line (TS/JS, Python, Rust). */
export function importNames(text: string): Array<{ name: string; from?: string }> {
  const from = /\bfrom\s+['"]([^'"]+)['"]/.exec(text)?.[1] ?? /\brequire\(\s*['"]([^'"]+)['"]\s*\)/.exec(text)?.[1];
  const out: Array<{ name: string; from?: string }> = [];
  const add = (raw: string) => {
    const name = raw
      .replace(/^\s*type\s+/, "")
      .split(/\s+as\s+/)
      .pop()!
      .trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(from ? { name, from } : { name });
  };
  const braces = /^\s*use\s/.test(text) ? null : /\{([^}]*)\}/.exec(text);
  if (braces) braces[1]!.split(",").forEach(add);
  const def = /^\s*import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|\s+from\b)/.exec(text);
  if (def) add(def[1]!);
  const py = /^\s*from\s+(\S+)\s+import\s+(.+)$/.exec(text);
  if (py) py[2]!.replace(/[()]/g, "").split(",").forEach(add);
  const rs = /^\s*use\s+[\w:]+::\{?([^};]+)\}?;/.exec(text);
  if (rs) rs[1]!.split(",").forEach((p) => add(p.split("::").pop()!));
  return out;
}

/** Framework and language names every file uses; their definitions and usages never narrow a question. */
export const SYMBOL_STOPLIST = new Set(
  (
    "useState useEffect useMemo useCallback useRef useContext useReducer useLayoutEffect useId useTransition " +
    "useDeferredValue useSyncExternalStore useImperativeHandle forwardRef createContext memo lazy Suspense Fragment " +
    "useNavigate useParams useSearch useLocation useRouter useRouterState useQueryClient createFileRoute Link " +
    "ReactNode ReactElement JSX Props PropsWithChildren ComponentProps ComponentType HTMLAttributes CSSProperties " +
    "className children onClick onChange onSubmit toString hasOwnProperty addEventListener removeEventListener " +
    "preventDefault stopPropagation setTimeout requestAnimationFrame querySelector getElementById"
  ).split(/\s+/),
);

/**
 * A name specific enough to follow: at least 4 chars and either several words (camelCase, snake_case) or a
 * Pascal/UPPER name. Single lowercase words (items, result, load, current) name locals and fields
 * everywhere, so their usages flood the search.
 */
export function specificName(n: string): boolean {
  if (n.length < 4 || LEAD_STOPLIST.has(n) || SYMBOL_STOPLIST.has(n)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(n)) return n.length >= 5;
  if (/^[A-Z]/.test(n)) return true;
  return splitWords(n).length >= 2;
}

export interface SymbolCandidate {
  name: string;
  weight: number;
  kinds: SymbolKind[];
  /** Files (of the given ones) the name occurs in. */
  files: string[];
  /** One line of context for the judge. */
  context: string;
  seenAt: { path: string; line: number };
}

export interface SymbolSourceFile {
  path: string;
  lines: string[];
  /** Triage probability (weights the file's names). */
  p: number;
  /** Keyword hit lines (1-based); names near a hit weigh more. */
  hitLines: number[];
}

/**
 * Aggregate the symbols of the given files into judge candidates. Excluded: names already searched or judged,
 * stoplisted helpers, names shorter than 4 chars. A name only declared and used inside one file (a local
 * helper) weighs less: the file itself is windowed, so its usages add little.
 */
export function symbolCandidates(
  files: SymbolSourceFile[],
  exclude: Set<string>,
  questionWords: Set<string>,
): SymbolCandidate[] {
  interface Acc {
    name: string;
    kinds: Set<SymbolKind>;
    files: Map<string, number>;
    occ: number;
    nearHit: boolean;
    declaredIn: Set<string>;
    imported: boolean;
    first: SymbolOccurrence & { path: string };
    best: SymbolOccurrence & { path: string };
  }
  const acc = new Map<string, Acc>();
  const kindRank: Record<SymbolKind, number> = {
    import: 6,
    jsx: 5,
    call: 5,
    member: 4,
    decl: 3,
    constant: 2,
    type: 1,
  };
  for (const f of files) {
    const hits = [...f.hitLines].sort((a, b) => a - b);
    const near = (line: number) => hits.some((h) => Math.abs(h - line) <= 3);
    for (const o of extractSymbols(f.lines)) {
      const n = o.name;
      if (!specificName(n) || exclude.has(n) || exclude.has(n.toLowerCase())) continue;
      let a = acc.get(n);
      const at = { ...o, path: f.path };
      if (!a) {
        a = {
          name: n,
          kinds: new Set(),
          files: new Map(),
          occ: 0,
          nearHit: false,
          declaredIn: new Set(),
          imported: false,
          first: at,
          best: at,
        };
        acc.set(n, a);
      }
      a.kinds.add(o.kind);
      a.files.set(f.path, Math.max(a.files.get(f.path) ?? 0, f.p));
      a.occ++;
      if (o.kind === "decl") a.declaredIn.add(f.path);
      if (o.kind === "import") a.imported = true;
      if (near(o.line)) a.nearHit = true;
      if (kindRank[o.kind] > kindRank[a.best.kind]) a.best = at;
    }
  }
  const out: SymbolCandidate[] = [];
  for (const a of acc.values()) {
    const fileMass = [...a.files.values()].reduce((s, p) => s + p, 0);
    const words = splitWords(a.name);
    const qov = words.filter((w) => questionWords.has(w)).length / Math.max(1, words.length);
    const local = a.declaredIn.size > 0 && !a.imported && a.files.size === 1;
    const onlyType = [...a.kinds].every((k) => k === "type" || k === "constant");
    let w = fileMass + 0.1 * Math.min(8, a.occ) + (a.nearHit ? 0.6 : 0) + qov;
    if (a.imported) w += 0.5;
    if (a.kinds.has("call") || a.kinds.has("member") || a.kinds.has("jsx")) w += 0.3;
    if (local) w *= 0.4;
    if (onlyType) w *= 0.6;
    const b = a.best;
    const how =
      b.kind === "import"
        ? `imported${b.from ? ` from "${b.from}"` : ""}`
        : b.kind === "decl"
          ? "declared"
          : b.kind === "jsx"
            ? "rendered"
            : b.kind === "call" || b.kind === "member"
              ? "called"
              : "used";
    out.push({
      name: a.name,
      weight: Math.round(w * 1000) / 1000,
      kinds: [...a.kinds],
      files: [...a.files.keys()],
      context: `${how} at ${b.path}:${b.line}: ${b.text}`,
      seenAt: { path: b.path, line: b.line },
    });
  }
  return out.sort((x, y) => y.weight - x.weight || (x.name < y.name ? -1 : 1));
}

export interface UsageHit {
  name: string;
  path: string;
  line: number;
  text: string;
  kind: "def" | "import" | "ref";
}

export interface UsageSearch {
  hits: UsageHit[];
  /** name -> files with any hit */
  files: Map<string, Set<string>>;
  /** Files whose hits were cut at the per-file cap (`-m`). */
  cappedFiles: number;
  ms: number;
}

/** ripgrep patterns (case-sensitive, ASCII word boundaries) over the names, each at most maxChars. */
export function usagePatterns(names: readonly string[], maxChars = CODE_SEARCH_MAX_PATTERN_CHARS): string[] {
  const wrap = (xs: string[]) => `(?-u:\\b)(?:${xs.map(escapeRegex).join("|")})(?-u:\\b)`;
  const out: string[] = [];
  let group: string[] = [];
  for (const n of names) {
    if (wrap([n]).length > maxChars) continue;
    if (group.length && wrap([...group, n]).length > maxChars) {
      out.push(wrap(group));
      group = [];
    }
    group.push(n);
  }
  if (group.length) out.push(wrap(group));
  return out;
}

/**
 * Definitions, imports and references of the names across the workspace: one case-sensitive ripgrep pass
 * over code files (prose and data excluded; tests only when the question is about tests), at most
 * `perFile` matching lines per file.
 */
export async function locateUsages(
  session: WorkspaceSession,
  names: string[],
  cfg: CodeSearchConfig,
  excludeArgs: string[],
  allowTests: boolean,
  perFile = 30,
): Promise<UsageSearch> {
  const t0 = performance.now();
  if (!names.length) return { hits: [], files: new Map(), cappedFiles: 0, ms: 0 };
  const extra = [...DEF_SCAN_EXCLUDES, ...(allowTests ? [] : TEST_EXCLUDES)].flatMap((g) => ["-g", g]);
  const outs = await mapLimit(usagePatterns(names), RIPGREP_SPLIT_CONCURRENCY, (pattern) =>
    session.ripgrep(
      [
        "--null",
        "--line-number",
        "--with-filename",
        "--no-heading",
        "--color",
        "never",
        "--no-require-git",
        "-m",
        String(perFile),
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
  const nameSet = new Set(names);
  const kinds = new Map(names.map((n) => [n, definitionKinds(n).filter((k) => k.kind !== "key")]));
  const hits: UsageHit[] = [];
  const files = new Map<string, Set<string>>();
  const perFileCount = new Map<string, number>();
  const seen = new Set<string>();
  for (const row of outs.flatMap((o) => o.split("\n"))) {
    const z = row.indexOf("\0");
    if (z <= 0) continue;
    const colon = row.indexOf(":", z + 1);
    if (colon < 0) continue;
    const at = row.slice(0, colon);
    if (seen.has(at)) continue;
    seen.add(at);
    const text = row.slice(colon + 1);
    if (text.startsWith("[Omitted long line")) continue;
    const path = row.slice(0, z).replace(/^\.\//, "");
    const line = Number(row.slice(z + 1, colon));
    perFileCount.set(path, (perFileCount.get(path) ?? 0) + 1);
    const present = new Set((text.match(/[A-Za-z_$][\w$]*/g) ?? []).filter((t) => nameSet.has(t)));
    for (const name of present) {
      const isImport = /^\s*(?:import|export\s*\{|from\s+\S+\s+import|use\s)/.test(text) || /require\(/.test(text);
      const isDef = !isImport && kinds.get(name)!.some((k) => k.re.test(text));
      hits.push({
        name,
        path,
        line,
        text: text.trim().slice(0, 200),
        kind: isDef ? "def" : isImport ? "import" : "ref",
      });
      let fs = files.get(name);
      if (!fs) files.set(name, (fs = new Set()));
      fs.add(path);
    }
  }
  const cappedFiles = [...perFileCount.values()].filter((c) => c >= perFile).length;
  hits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
  return { hits, files, cappedFiles, ms: Math.round(performance.now() - t0) };
}
