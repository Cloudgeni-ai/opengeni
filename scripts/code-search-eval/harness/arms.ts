import {
  Bm25,
  chunkFile,
  filesFromChunks,
  loadRepo,
  reciprocalRankFusion,
  tokenize,
  type Chunk,
} from "./index-lexical";
import { RepoMap } from "./index-repomap";
import type { DecisionModel } from "../../../packages/decisions/src/types";
import {
  addUsage,
  zeroUsage,
  type Arm,
  type ArmContext,
  type Prediction,
  type Span,
  type Task,
} from "./types";

/** Context budget every arm's spans are cut to, matching code_search's default pack size. */
export const CONTEXT_BUDGET_TOKENS = 12_000;
const TOKENS_PER_LINE = 10;

/** Take spans in rank order until the context budget is spent. */
export function budgetSpans(
  spans: Span[],
  budgetTokens = CONTEXT_BUDGET_TOKENS,
): Span[] {
  const out: Span[] = [];
  let used = 0;
  for (const span of spans) {
    const cost = (span.end - span.start + 1) * TOKENS_PER_LINE;
    if (used + cost > budgetTokens) break;
    out.push(span);
    used += cost;
  }
  return out;
}

type RepoIndex = { files: Map<string, string>; bm25: Bm25; map: RepoMap };
const indexCache = new Map<string, Promise<RepoIndex>>();

/** One index per repository directory (a directory is one repo at one commit). */
export function repoIndex(repoDir: string): Promise<RepoIndex> {
  let pending = indexCache.get(repoDir);
  if (!pending) {
    pending = loadRepo(repoDir).then((files) => {
      const chunks: Chunk[] = [];
      for (const [file, text] of files) chunks.push(...chunkFile(file, text));
      return { files, bm25: new Bm25(chunks), map: new RepoMap(files) };
    });
    indexCache.set(repoDir, pending);
  }
  return pending;
}
export const clearIndexCache = () => indexCache.clear();

const strip = ({ file, start, end }: Span): Span => ({ file, start, end });

/** File-level BM25 (whole files as documents), the baseline published localization papers report. */
const fileBm25Cache = new Map<string, Bm25>();
export const bm25FileArm: Arm = {
  name: "bm25-file",
  live: false,
  async run(task, { repoDir }) {
    const { files } = await repoIndex(repoDir);
    let index = fileBm25Cache.get(repoDir);
    if (!index) {
      index = new Bm25(
        [...files].map(([file, text]) => ({
          file,
          start: 1,
          end: text.split("\n").length,
          tokens: tokenize(`${file}\n${text}`),
        })),
      );
      fileBm25Cache.clear();
      fileBm25Cache.set(repoDir, index);
    }
    const hits = index.search(task.query, 20);
    return {
      prediction: { files: hits.map((h) => h.chunk.file), spans: [] },
      usage: zeroUsage(),
    };
  },
};

/**
 * The candidate pool the dense arm embeds: the best chunks of the top hybrid files. Embedding a
 * whole repository at every commit on CPU is out of reach, so dense retrieval re-ranks this pool;
 * its recall ceiling is the pool's recall, which the report states.
 */
export async function densePool(
  task: Task,
  repoDir: string,
  topFiles = 20,
  perFile = 10,
  max = 200,
) {
  const { bm25, files: texts } = await repoIndex(repoDir);
  const { files } = await hybridCandidates(task, repoDir, topFiles);
  const pool: (Span & { text: string })[] = [];
  for (const file of files) {
    const lines = (texts.get(file) ?? "").split("\n");
    const chunks = bm25.docs.filter((c) => c.file === file).slice(0, perFile);
    for (const c of chunks)
      pool.push({
        file,
        start: c.start,
        end: c.end,
        text: `${file}\n${lines.slice(c.start - 1, c.end).join("\n")}`,
      });
  }
  return pool.slice(0, max);
}

export const bm25Arm: Arm = {
  name: "bm25",
  live: false,
  async run(task, { repoDir }) {
    const { bm25 } = await repoIndex(repoDir);
    const hits = bm25.search(task.query, 200);
    return {
      prediction: {
        files: filesFromChunks(hits).slice(0, 20),
        spans: budgetSpans(hits.map((h) => strip(h.chunk))),
      },
      usage: zeroUsage(),
    };
  },
};

export const repoMapArm: Arm = {
  name: "repomap",
  live: false,
  async run(task, { repoDir }) {
    const { map } = await repoIndex(repoDir);
    const files = map
      .rank(task.query)
      .slice(0, 20)
      .map((r) => r.file);
    return {
      prediction: {
        files,
        spans: budgetSpans(files.flatMap((f) => map.spansFor(f, task.query))),
      },
      usage: zeroUsage(),
    };
  },
};

/** Lexical chunks and the repo map fused by reciprocal rank; spans from the best chunks of the fused files. */
export async function hybridCandidates(
  task: Task,
  repoDir: string,
  limit = 30,
) {
  const { bm25, map } = await repoIndex(repoDir);
  const hits = bm25.search(task.query, 300);
  const files = reciprocalRankFusion([
    filesFromChunks(hits),
    map.rank(task.query).map((r) => r.file),
  ]).slice(0, limit);
  const chunksByFile = new Map<string, Span[]>();
  for (const h of hits)
    chunksByFile.set(h.chunk.file, [
      ...(chunksByFile.get(h.chunk.file) ?? []),
      strip(h.chunk),
    ]);
  const spansOf = (file: string) => {
    const chunks = chunksByFile.get(file);
    return chunks?.length
      ? chunks.slice(0, 2)
      : map.spansFor(file, task.query, 2);
  };
  return { files, spansOf };
}

export const hybridArm: Arm = {
  name: "hybrid",
  live: false,
  async run(task, { repoDir }) {
    const { files, spansOf } = await hybridCandidates(task, repoDir);
    const top = files.slice(0, 20);
    // Interleave by rank: each file's best span first, then second spans.
    const spans = [
      ...top.map((f) => spansOf(f)[0]),
      ...top.map((f) => spansOf(f)[1]),
    ].filter((s): s is Span => !!s);
    return {
      prediction: { files: top, spans: budgetSpans(spans) },
      usage: zeroUsage(),
    };
  },
};

function excerpt(text: string, span: Span, maxLines = 40): string {
  return text
    .split("\n")
    .slice(span.start - 1, Math.min(span.end, span.start - 1 + maxLines))
    .map((line, i) => `${span.start + i}: ${line.slice(0, 200)}`)
    .join("\n");
}

/**
 * Jev selection over hybrid candidates: one typed predicate per candidate file ("is this file part of
 * the evidence needed"), batched, files re-ranked by probability. Same budget and output shape as
 * the model-free arms, so the gain is attributable to the selection alone.
 */
export function jevRerankArm(
  decisionModel: DecisionModel,
  options: {
    candidates?: number;
    batch?: number;
    threshold?: number;
    name?: string;
  } = {},
): Arm {
  const candidates = options.candidates ?? 30;
  const batch = options.batch ?? 6;
  // 0 keeps every candidate, ranked by probability; a cut is chosen on dev and applied afterwards
  // from the stored per-file probabilities (see thresholdVariant), so no threshold is tuned on test.
  const threshold = options.threshold ?? 0;
  return {
    name: options.name ?? "jev-rerank",
    live: true,
    async run(task, { repoDir, signal }) {
      const { files: index } = await repoIndex(repoDir);
      const { files, spansOf } = await hybridCandidates(
        task,
        repoDir,
        candidates,
      );
      const usage = zeroUsage();
      const probability = new Map<string, number>();
      for (let i = 0; i < files.length; i += batch) {
        const group = files.slice(i, i + batch);
        const state = {
          task: task.query.slice(0, 6000),
          candidates: Object.fromEntries(
            group.map((file, j) => [
              `c${j}`,
              {
                path: file,
                excerpts: spansOf(file).map((s) =>
                  excerpt(index.get(file) ?? "", s),
                ),
              },
            ]),
          ),
        };
        const questions = Object.fromEntries(
          group.map((_, j) => [
            `c${j}`,
            {
              type: "predicate" as const,
              instructions: `Would someone resolving the task need to read or change the file in candidates.c${j}? Judge from its path and excerpts against the task.`,
            },
          ]),
        );
        const result = await decisionModel.decide(state, questions, { signal });
        addUsage(usage, {
          modelCalls: 1,
          inputTokens: result.usage.inputTokens ?? 0,
          cashUsd: result.usage.costUsd ?? 0,
          apiEquivalentUsd: result.usage.costUsd ?? 0,
        });
        group.forEach((file, j) => {
          const answer = result.answers[`c${j}`];
          probability.set(
            file,
            answer?.type === "predicate" ? answer.probability : 0,
          );
        });
      }
      const ranked = files
        .map((file, rank) => ({ file, p: probability.get(file) ?? 0, rank }))
        .sort((a, b) => b.p - a.p || a.rank - b.rank);
      const kept = ranked.filter((r) => r.p >= threshold).map((r) => r.file);
      const ordered = kept.length
        ? kept
        : ranked.slice(0, 3).map((r) => r.file);
      return {
        prediction: {
          files: ordered,
          spans: budgetSpans(ordered.flatMap((f) => spansOf(f))),
          fileScores: Object.fromEntries(ranked.map((r) => [r.file, r.p])),
        },
        usage,
      };
    },
  };
}

/** Parse a code_search pack's `== path:start-end  rel x` block headers into spans, in pack order. */
export function spansFromPack(text: string): Span[] {
  return [...text.matchAll(/^== (.+?):(\d+)-(\d+)\s/gm)].map((m) => ({
    file: m[1]!,
    start: Number(m[2]),
    end: Number(m[3]),
  }));
}

/** Code-like terms in a query (identifiers with case or underscores, dotted paths, backticked text), as code_search keywords. */
export function queryKeywords(query: string, limit = 8): string[] {
  const found = new Set<string>();
  for (const m of query.matchAll(/`([^`\n]{2,60})`/g)) found.add(m[1]!.trim());
  for (const m of query.matchAll(
    /\b[A-Za-z_][\w]*(?:\.[A-Za-z_]\w*)+\b|\b[a-z]+_[\w]+\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][a-z]+[A-Z]\w*\b/g,
  ))
    found.add(m[0]);
  return [...found].slice(0, limit);
}

export const predictionFromSpans = (spans: Span[]): Prediction => ({
  files: [...new Set(spans.map((s) => s.file))],
  spans,
});

export type ArmRunner = (
  arm: Arm,
  task: Task,
  context: ArmContext,
) => ReturnType<Arm["run"]>;
