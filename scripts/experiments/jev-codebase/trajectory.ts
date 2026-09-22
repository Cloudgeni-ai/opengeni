import { fileEvidence } from "./investigation";
import type { Chunk, Snapshot } from "./core";

export type Citation = { path: string; startLine: number; endLine: number };
export type FinalAnswer = {
  answer: "yes" | "no" | "indecisive";
  explanation: string;
  citations: Citation[];
};
export type BenchmarkCase = {
  id: string;
  question: string;
  context: string;
  mode: "binary" | "evidence";
  expectedAnswer: FinalAnswer["answer"];
  requiredSpans: Citation[];
  acceptableConclusion: string;
  category: string;
  oracleRationale: string;
};

export function nonnegativeAmount(raw: unknown): number {
  if (
    (typeof raw !== "number" && typeof raw !== "string") ||
    (typeof raw === "string" && !raw.trim())
  )
    throw new Error("invalid_amount");
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error("invalid_amount");
  return value;
}

export function remainingTime(start: number, now: number, limit = 240000): number {
  const remaining = limit - (now - start);
  if (remaining <= 0) throw new Error("trajectory_deadline");
  return Math.ceil(remaining);
}

export function validateCases(cases: BenchmarkCase[]): void {
  if (!Array.isArray(cases) || !cases.length) throw new Error("invalid_cases");
  const ids = new Set<string>();
  for (const c of cases) {
    if (
      !c.id ||
      ids.has(c.id) ||
      typeof c.question !== "string" ||
      !c.question.trim() ||
      typeof c.context !== "string" ||
      !["binary", "evidence"].includes(c.mode) ||
      !["yes", "no", "indecisive"].includes(c.expectedAnswer) ||
      (c.mode === "evidence" && c.expectedAnswer !== "indecisive") ||
      !Array.isArray(c.requiredSpans) ||
      !c.requiredSpans.length
    )
      throw new Error("invalid_case");
    ids.add(c.id);
    for (const span of c.requiredSpans)
      if (
        !span.path ||
        span.path.startsWith("/") ||
        span.path.split("/").includes("..") ||
        !Number.isInteger(span.startLine) ||
        !Number.isInteger(span.endLine) ||
        span.startLine < 1 ||
        span.endLine < span.startLine ||
        span.endLine > 100000
      )
        throw new Error("invalid_oracle_span");
  }
}

/** Identical bounded primitives in both arms; no oracle is used by this class. */
export class SourceTools {
  readonly files: Chunk[];
  readonly returned: Citation[] = [];
  constructor(readonly snapshot: Snapshot) {
    // Snapshot loader owns physical-line normalization, including real trailing blank lines.
    this.files = fileEvidence(snapshot);
  }
  list(filter: string, offset: number) {
    const paths = [...new Set(this.files.map((f) => f.path))]
      .filter((p) => p.toLowerCase().includes(filter.toLowerCase()))
      .sort();
    return {
      paths: paths.slice(offset, offset + 60),
      total: paths.length,
      nextOffset: offset + 60 < paths.length ? offset + 60 : null,
    };
  }
  search(queries: string[]) {
    const hits: { path: string; line: number; text: string }[] = [];
    let matched = 0;
    const seen = new Set<string>();
    for (const file of this.files)
      for (const [i, line] of file.text.split("\n").entries()) {
        if (!queries.some((q) => line.toLowerCase().includes(q.toLowerCase()))) continue;
        const n = file.startLine + i,
          key = `${file.path}:${n}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matched++;
        if (hits.length < 30) {
          hits.push({ path: file.path, line: n, text: line.slice(0, 250) });
          // Truncated lines do not count as exact full source evidence.
          if (line.length <= 250) this.returned.push({ path: file.path, startLine: n, endLine: n });
        }
      }
    return { hits, matched, truncated: matched > hits.length };
  }
  read(path: string, startLine: number, endLine: number) {
    const file = this.files.find(
      (f) => f.path === path && f.startLine <= startLine && f.endLine >= startLine,
    );
    if (!file) return { error: "path_or_range_not_in_snapshot" };
    const end = Math.min(endLine, startLine + 119, file.endLine);
    const lines = file.text.split("\n").slice(startLine - file.startLine, end - file.startLine + 1);
    const selected: string[] = [];
    for (const line of lines) {
      if (selected.join("\n").length + line.length + 1 > 12000) break;
      selected.push(line);
    }
    if (!selected.length) return { error: "line_exceeds_result_budget" };
    const result = {
      path,
      startLine,
      endLine: startLine + selected.length - 1,
      text: selected.join("\n"),
    };
    this.returned.push(result);
    return result;
  }
}

export function spanCovered(span: Citation, delivered: Citation[]): boolean {
  const valid = (s: Citation) =>
    Number.isSafeInteger(s.startLine) &&
    Number.isSafeInteger(s.endLine) &&
    s.startLine > 0 &&
    s.endLine >= s.startLine;
  if (!valid(span)) return false;
  let next = span.startLine;
  for (const d of delivered
    .filter((candidate) => candidate.path === span.path && valid(candidate))
    .sort((a, b) => a.startLine - b.startLine)) {
    if (d.endLine < next) continue;
    if (d.startLine > next) return false;
    if (d.endLine >= span.endLine) return true;
    next = d.endLine + 1;
  }
  return false;
}
export function scoreTrajectory(
  c: BenchmarkCase,
  final: FinalAnswer | null,
  delivered: Citation[],
  source: SourceTools,
) {
  const citationsValid =
    !!final &&
    final.citations.length > 0 &&
    final.citations.every(
      (s) =>
        Number.isInteger(s.startLine) &&
        Number.isInteger(s.endLine) &&
        s.startLine > 0 &&
        s.endLine >= s.startLine &&
        spanCovered(s, source.files) &&
        spanCovered(s, delivered),
    );
  return {
    completed: final !== null,
    answerAgreement: !!final && final.answer === c.expectedAnswer,
    wrongDecisive:
      c.mode === "binary" &&
      !!final &&
      final.answer !== "indecisive" &&
      final.answer !== c.expectedAnswer,
    outputContractPass: !!final && (c.mode !== "evidence" || final.answer === "indecisive"),
    requiredSpanRecall:
      c.requiredSpans.filter((s) => spanCovered(s, delivered)).length / c.requiredSpans.length,
    citationsValid,
    requiredCitationRecall: final
      ? c.requiredSpans.filter((s) => spanCovered(s, final.citations)).length /
        c.requiredSpans.length
      : 0,
    // Semantic explanation correctness requires a separate blinded review.
    evidenceAndLabelPass:
      !!final &&
      final.answer === c.expectedAnswer &&
      citationsValid &&
      c.requiredSpans.every((s) => spanCovered(s, final.citations)) &&
      c.requiredSpans.every((s) => spanCovered(s, delivered)),
  };
}
