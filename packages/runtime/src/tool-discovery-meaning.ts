import { createHash } from "node:crypto";
import type { Tool } from "@openai/agents";

/**
 * Turns texts into vectors in one fixed space. `space` names that space (for
 * example the endpoint, model and dimensions): vectors from different spaces
 * are never compared.
 */
export type ToolTextEmbedder = {
  space: string;
  embed(texts: string[]): Promise<number[][]>;
};

/**
 * Ranks tools by what they do rather than the words they use. For each query
 * (one per independent request in a search) it returns every given tool's
 * name, closest in meaning first; or undefined when it cannot rank them now,
 * and the search then ranks by keywords alone. It never throws.
 */
export type ToolMeaningRanker = (input: {
  queries: readonly string[];
  tools: readonly Tool[];
  signal: AbortSignal;
}) => Promise<string[][] | undefined>;

/** A meaning ranker that can also compute its tools' vectors ahead of a search. */
export type EmbeddingToolRanker = ToolMeaningRanker & {
  /** Computes any missing vectors for these tools; true when all of them have one. */
  warm(tools: readonly Tool[]): Promise<boolean>;
};

export const TOOL_MEANING_POLICY = {
  /** A ranking still unanswered after this is skipped for keywords alone. */
  deadlineMs: 1_500,
  /** Characters of a tool's description its vector reads. */
  descriptionChars: 2_000,
  /** Tool texts per embedding request while vectors are computed. */
  batch: 64,
  /** After a failed request, vectors are not requested again for this long. */
  retryAfterMs: 60_000,
  /** Vector values one ranker keeps in memory (64 MB as 32-bit floats). */
  maxValues: 16_000_000,
} as const;

/** The text a tool's vector is computed from: its readable name and description. */
export function toolMeaningText(tool: Tool): string {
  if (tool.type !== "function") throw new Error("Only function tools are ranked by meaning");
  // Transport routing hashes carry no meaning; the readable part follows the separator.
  const separator = tool.name.lastIndexOf("__");
  const name = separator < 0 ? tool.name : tool.name.slice(separator + 2);
  return `${name}\n${(tool.description ?? "").slice(0, TOOL_MEANING_POLICY.descriptionChars)}`;
}

function unit(values: readonly number[]): Float32Array | undefined {
  let norm = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) return undefined;
    norm += value * value;
  }
  if (!(norm > 0)) return undefined;
  const scale = 1 / Math.sqrt(norm);
  return Float32Array.from(values, (value) => value * scale);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * A meaning ranker over an embedding model, shared by every turn in a process.
 * Tool vectors are computed once per tool text and kept in memory, keyed by a
 * hash of the text, so no tool is embedded twice while its description is
 * unchanged and a vector is only found by a caller holding the same text.
 * Until every tool a search could return has a vector, that search uses
 * keywords alone while the missing vectors are computed in the background:
 * a search never waits for a catalog to be embedded. Each search then embeds
 * only its own queries.
 */
export function createEmbeddingToolRanker(
  embedder: ToolTextEmbedder,
  options: { now?: () => number; onError?: (error: unknown) => void } = {},
): EmbeddingToolRanker {
  const now = options.now ?? Date.now;
  // Insertion order is recency order: a used vector is moved to the end.
  const vectors = new Map<string, Float32Array>();
  let storedValues = 0;
  const queued = new Map<string, string>();
  let computing: Promise<void> | undefined;
  let pausedUntil = 0;
  let dimensions: number | undefined;

  const keyOf = (text: string) =>
    createHash("sha256").update(embedder.space).update("\0").update(text).digest("base64url");

  const pause = (error: unknown) => {
    pausedUntil = now() + TOOL_MEANING_POLICY.retryAfterMs;
    options.onError?.(error);
  };

  const store = (key: string, vector: Float32Array) => {
    if (vectors.has(key)) return;
    vectors.set(key, vector);
    storedValues += vector.length;
    for (const [oldest, old] of vectors) {
      if (storedValues <= TOOL_MEANING_POLICY.maxValues) break;
      vectors.delete(oldest);
      storedValues -= old.length;
    }
  };

  const embedChecked = async (texts: string[]): Promise<Float32Array[]> => {
    const raw = await embedder.embed(texts);
    if (!Array.isArray(raw) || raw.length !== texts.length)
      throw new Error("Embedding model returned the wrong number of vectors");
    return raw.map((values) => {
      const vector = Array.isArray(values) ? unit(values) : undefined;
      if (!vector || (dimensions !== undefined && vector.length !== dimensions))
        throw new Error("Embedding model returned an invalid vector");
      dimensions ??= vector.length;
      return vector;
    });
  };

  const compute = () =>
    (computing ??= (async () => {
      try {
        while (queued.size && now() >= pausedUntil) {
          const batch = [...queued].slice(0, TOOL_MEANING_POLICY.batch);
          try {
            const computed = await embedChecked(batch.map(([, text]) => text));
            batch.forEach(([key], i) => store(key, computed[i]!));
          } catch (error) {
            queued.clear();
            pause(error);
            return;
          }
          for (const [key] of batch) queued.delete(key);
        }
      } finally {
        computing = undefined;
      }
    })());

  const documentsOf = (tools: readonly Tool[]) =>
    tools
      .filter((tool) => tool.type === "function")
      .map((tool) => ({
        name: tool.name,
        key: keyOf(toolMeaningText(tool)),
        tool,
      }));

  /** Queues the documents without a vector; true when there are none. */
  const queueMissing = (documents: ReturnType<typeof documentsOf>) => {
    const missing = documents.filter((document) => !vectors.has(document.key));
    for (const document of missing) queued.set(document.key, toolMeaningText(document.tool));
    return missing.length === 0;
  };

  const rank: ToolMeaningRanker = async ({ queries, tools, signal }) => {
    try {
      const documents = documentsOf(tools);
      if (!documents.length || !queries.length) return undefined;
      if (!queueMissing(documents)) {
        if (now() >= pausedUntil) void compute();
        return undefined;
      }
      if (now() < pausedUntil) return undefined;
      const toolVectors = documents.map((document) => {
        const vector = vectors.get(document.key)!;
        vectors.delete(document.key);
        vectors.set(document.key, vector);
        return vector;
      });
      const queryVectors = await abortable(embedChecked([...queries]), signal);
      return queryVectors.map((query) =>
        documents
          .map((document, i) => ({
            name: document.name,
            score: dot(query, toolVectors[i]!),
          }))
          .sort((a, b) => b.score - a.score)
          .map((scored) => scored.name),
      );
    } catch (error) {
      // A search that ran out of time says nothing about the model.
      if (!signal.aborted) pause(error);
      return undefined;
    }
  };

  return Object.assign(rank, {
    async warm(tools: readonly Tool[]) {
      const documents = documentsOf(tools);
      if (queueMissing(documents)) return true;
      if (now() >= pausedUntil) await compute();
      return queueMissing(documents);
    },
  });
}

/**
 * Reciprocal rank fusion of rankings of one pool: each list adds 1 / (k + rank)
 * to a name's score, so neither ranking's raw scores need calibrating.
 */
export function fuseRankings(rankings: readonly (readonly string[])[], k = 60): string[] {
  const scores = new Map<string, { score: number; first: number }>();
  let order = 0;
  for (const ranking of rankings)
    ranking.forEach((name, rank) => {
      const entry = scores.get(name) ?? { score: 0, first: order++ };
      entry.score += 1 / (k + rank + 1);
      scores.set(name, entry);
    });
  return [...scores]
    .sort(([, a], [, b]) => b.score - a.score || a.first - b.first)
    .map(([name]) => name);
}
