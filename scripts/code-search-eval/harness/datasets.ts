import { createHash } from "node:crypto";
import type { Span, Task } from "./types";

/**
 * ContextBench row (arXiv 2602.05892, github.com/EuniAI/ContextBench, Apache-2.0), as exported to
 * JSONL from data/full.parquet with gold_context parsed and its file contents dropped.
 */
export type ContextBenchRow = {
  instance_id: string;
  original_inst_id?: string;
  repo: string;
  repo_url: string;
  language: string;
  base_commit: string;
  source: string;
  problem_statement: string | null;
  patch?: string;
  gold_context: { file: string; start_line: number; end_line: number }[];
};

/** Files a unified diff touches (pre-image paths; created files are skipped since no search can find them). */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const match of patch.matchAll(/^--- (?:a\/)?(.+)$/gm)) {
    const file = match[1]!.trim();
    if (file !== "/dev/null") files.add(file);
  }
  return [...files];
}

/** Merge overlapping or adjacent spans per file so precision does not double count. */
export function mergeSpans(spans: Span[]): Span[] {
  const byFile = new Map<string, Span[]>();
  for (const span of spans) {
    if (!(span.start >= 1 && span.end >= span.start)) continue;
    const list = byFile.get(span.file) ?? [];
    list.push({ ...span });
    byFile.set(span.file, list);
  }
  const merged: Span[] = [];
  for (const [file, list] of [...byFile].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    list.sort((a, b) => a.start - b.start);
    let current = list[0]!;
    for (const next of list.slice(1)) {
      if (next.start <= current.end + 1)
        current.end = Math.max(current.end, next.end);
      else {
        merged.push({ file, start: current.start, end: current.end });
        current = next;
      }
    }
    merged.push({ file, start: current.start, end: current.end });
  }
  return merged;
}

/**
 * Gold paths in some ContextBench sources are absolute in the annotators' container
 * (`/workspace/<owner>__<repo>__<version>/lib/x.js`). Make them repository-relative, and drop files
 * outside the repository (for example a scratch `/workspace/reproduce_error.js`), which no search can find.
 */
export function repoRelativePath(path: string): string | null {
  const p = path
    .replace(/^\/(?:workspace|testbed|app|repo)\/[^/]*__[^/]*\//, "")
    .replace(/^\/testbed\//, "")
    .replace(/^\.\//, "");
  return p.startsWith("/") || !p ? null : p;
}

export function contextBenchTask(row: ContextBenchRow): Task {
  const spans = mergeSpans(
    row.gold_context.flatMap((b) => {
      const file = repoRelativePath(b.file);
      return file ? [{ file, start: b.start_line, end: b.end_line }] : [];
    }),
  );
  return {
    id: row.instance_id,
    repo: row.repo,
    repoUrl: row.repo_url,
    commit: row.base_commit,
    language: row.language,
    source: row.source,
    // A few upstream rows have no problem statement; keep them (stable shards) with an empty query.
    query: row.problem_statement ?? "",
    oracle: { files: [...new Set(spans.map((s) => s.file))], spans },
  };
}

/** SWE-bench-style row (SWE-bench Lite, Loc-Bench): the oracle is the set of files the gold patch edits. */
export type SweBenchRow = {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string | null;
  patch: string;
};

export function sweBenchTask(row: SweBenchRow, source = "swebench"): Task {
  return {
    id: row.instance_id,
    repo: row.repo,
    repoUrl: `https://github.com/${row.repo}.git`,
    commit: row.base_commit,
    language: "python",
    source,
    // A few upstream rows have no problem statement; keep them (stable shards) with an empty query.
    query: row.problem_statement ?? "",
    oracle: { files: patchFiles(row.patch), spans: [] },
  };
}

/**
 * Deterministic dev/test split by repository: a repository is dev when a hash of its name falls
 * below the fraction, so tuning never sees test repositories. Stable across dataset versions.
 */
export function splitByRepo(
  tasks: Task[],
  devFraction = 0.15,
  salt = "code-search-eval-v1",
): Task[] {
  return tasks.map((task) => {
    const digest = createHash("sha256").update(`${salt}:${task.repo}`).digest();
    const unit = digest.readUInt32BE(0) / 0x1_0000_0000;
    return { ...task, split: unit < devFraction ? "dev" : "test" };
  });
}

/**
 * Stratified sample: up to perStratum tasks from each language, picked by a seeded hash order so
 * the same seed always gives the same sample and adding tasks does not reshuffle existing picks.
 */
export function stratifiedSample(
  tasks: Task[],
  perStratum: number,
  seed = "s1",
): Task[] {
  const rank = (task: Task) =>
    createHash("sha256").update(`${seed}:${task.id}`).digest().readUInt32BE(0);
  const byLanguage = new Map<string, Task[]>();
  for (const task of tasks)
    byLanguage.set(task.language, [
      ...(byLanguage.get(task.language) ?? []),
      task,
    ]);
  return [...byLanguage.keys()].sort().flatMap((language) =>
    byLanguage
      .get(language)!
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, perStratum),
  );
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}
