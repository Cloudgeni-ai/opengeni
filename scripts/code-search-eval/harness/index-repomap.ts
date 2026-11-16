import { tokenize } from "./index-lexical";
import type { Span } from "./types";

/**
 * A language-agnostic repo map in the spirit of Aider's: definitions found with per-language
 * patterns (a dependency-free stand-in for tree-sitter tags), references by identifier, and a
 * PageRank over file -> file reference edges personalised toward files and symbols the query names.
 */
export type Definition = Span & { name: string };

const DEFINITION_PATTERNS: RegExp[] = [
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, // python
  /^\s*class\s+([A-Za-z_]\w*)/, // python, js, ts, java, kotlin, c++
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/, // js, ts
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, // go
  /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, // go
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl(?:<[^>]*>)?)\s+([A-Za-z_]\w*)/, // rust
  // Leading whitespace has one owner (`^\s*`): the old `(?:…|\s)*[…\s]+\s+` prefix backtracked as n^4 on indented lines.
  /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*[\w<>\[\],][\w<>\[\],\s]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws[^{]*)?\{\s*$/, // java, c, c++ functions
  /^\s*(?:struct|union|enum)\s+([A-Za-z_]\w*)\s*\{/, // c
  /^#define\s+([A-Za-z_]\w*)/,
];
const KEYWORDS = new Set(
  "if for while switch return catch else new sizeof".split(" "),
);

const MAX_DEFINITION_LINE = 400;

export function extractDefinitions(file: string, text: string): Definition[] {
  const lines = text.split("\n");
  const defs: Definition[] = [];
  lines.forEach((line, i) => {
    // Long lines are data (tables, minified code); the patterns backtrack badly on them.
    if (line.length > MAX_DEFINITION_LINE) return;
    for (const pattern of DEFINITION_PATTERNS) {
      const name = pattern.exec(line)?.[1];
      if (name && !KEYWORDS.has(name) && name.length > 1) {
        defs.push({ file, name, start: i + 1, end: i + 1 });
        break;
      }
    }
  });
  // A definition extends to the line before the next definition at the same or lower indentation; capped.
  for (let i = 0; i < defs.length; i++) {
    const next = defs[i + 1];
    defs[i]!.end = Math.min(
      next ? next.start - 1 : lines.length,
      defs[i]!.start + 80,
    );
  }
  return defs;
}

export class RepoMap {
  readonly definitions = new Map<string, Definition[]>();
  private readonly definedIn = new Map<string, Set<string>>();
  private readonly edges = new Map<string, Map<string, number>>();

  constructor(files: Map<string, string>) {
    for (const [file, text] of files) {
      const defs = extractDefinitions(file, text);
      this.definitions.set(file, defs);
      for (const d of defs)
        this.definedIn.set(
          d.name,
          (this.definedIn.get(d.name) ?? new Set()).add(file),
        );
    }
    for (const [file, text] of files) {
      const out = new Map<string, number>();
      for (const ident of new Set(text.match(/[A-Za-z_]\w{2,}/g) ?? [])) {
        const targets = this.definedIn.get(ident);
        // Very common names (defined in many files) carry little signal, as in Aider's weighting.
        if (!targets || targets.size > 20) continue;
        for (const target of targets)
          if (target !== file)
            out.set(target, (out.get(target) ?? 0) + 1 / targets.size);
      }
      this.edges.set(file, out);
    }
  }

  /** Personalised PageRank. Personalisation favours files whose path or definitions match query terms. */
  rank(
    query: string,
    iterations = 30,
    damping = 0.85,
  ): { file: string; score: number }[] {
    const files = [...this.edges.keys()];
    if (!files.length) return [];
    const terms = new Set(tokenize(query));
    const personal = new Map<string, number>();
    for (const file of files) {
      let weight = 0;
      for (const t of tokenize(file)) if (terms.has(t)) weight += 1;
      for (const d of this.definitions.get(file) ?? [])
        if (terms.has(d.name.toLowerCase())) weight += 3;
      personal.set(file, weight);
    }
    const totalPersonal = [...personal.values()].reduce((s, v) => s + v, 0);
    const base = (file: string) =>
      totalPersonal ? personal.get(file)! / totalPersonal : 1 / files.length;
    let rank = new Map(files.map((f) => [f, 1 / files.length]));
    for (let it = 0; it < iterations; it++) {
      const next = new Map(files.map((f) => [f, (1 - damping) * base(f)]));
      let dangling = 0;
      for (const file of files) {
        const out = this.edges.get(file)!;
        const total = [...out.values()].reduce((s, v) => s + v, 0);
        if (!total) {
          dangling += rank.get(file)!;
          continue;
        }
        for (const [target, w] of out)
          next.set(
            target,
            next.get(target)! + (damping * rank.get(file)! * w) / total,
          );
      }
      for (const file of files)
        next.set(file, next.get(file)! + damping * dangling * base(file));
      rank = next;
    }
    return files
      .map((file) => ({ file, score: rank.get(file)! }))
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  }

  /** Definition spans in a file that the query names, or its first definitions as a map summary. */
  spansFor(file: string, query: string, limit = 3): Span[] {
    const terms = new Set(tokenize(query));
    const defs = this.definitions.get(file) ?? [];
    const named = defs.filter((d) => terms.has(d.name.toLowerCase()));
    return (named.length ? named : defs)
      .slice(0, limit)
      .map(({ file: f, start, end }) => ({ file: f, start, end }));
  }
}
