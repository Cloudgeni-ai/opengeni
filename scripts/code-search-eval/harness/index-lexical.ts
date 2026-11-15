import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Span } from "./types";

/** Source extensions indexed by the model-free arms. Binary, vendored and generated trees are skipped. */
export const SOURCE_EXTENSIONS = new Set(
  "py pyi js jsx mjs cjs ts tsx go rs c h cc cpp cxx hpp hh java kt scala rb php cs swift m mm lua sh md rst txt toml yaml yml json cfg ini".split(
    " ",
  ),
);
const SKIP_DIRS =
  /(^|\/)(node_modules|vendor|third_party|dist|build|target|\.git|__pycache__|\.venv)\//;
export const MAX_FILE_BYTES = 512 * 1024;

export function isIndexable(path: string): boolean {
  if (SKIP_DIRS.test(path)) return false;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

/** Split identifiers into lowercase subwords: `parseHTTPRequest_v2` -> parse, http, request, v2, plus the whole token. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) ?? []) {
    const whole = raw.toLowerCase();
    if (whole.length < 2) continue;
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[_\s]+/)
      .map((p) => p.toLowerCase())
      .filter((p) => p.length >= 2);
    out.push(whole);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

export type Chunk = Span & { tokens: string[] };

/** Fixed line windows with overlap; the unit BM25 and embeddings rank. */
export function chunkFile(
  file: string,
  text: string,
  window = 60,
  stride = 40,
): Chunk[] {
  const lines = text.split("\n");
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += stride) {
    const end = Math.min(lines.length, start + window);
    // Paths are searchable too: issues often name modules.
    const tokens = tokenize(`${file}\n${lines.slice(start, end).join("\n")}`);
    chunks.push({ file, start: start + 1, end, tokens });
    if (end === lines.length) break;
  }
  return chunks;
}

export class Bm25 {
  private readonly df = new Map<string, number>();
  private readonly tf: Map<string, number>[] = [];
  private readonly lengths: number[] = [];
  private avg = 0;
  constructor(
    readonly docs: Chunk[],
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {
    for (const doc of docs) {
      const counts = new Map<string, number>();
      for (const t of doc.tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.tf.push(counts);
      this.lengths.push(doc.tokens.length);
    }
    this.avg = this.lengths.reduce((s, n) => s + n, 0) / (docs.length || 1);
  }
  idf(term: string): number {
    const n = this.df.get(term) ?? 0;
    return Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5));
  }
  search(query: string, limit = 50): { chunk: Chunk; score: number }[] {
    const terms = [...new Set(tokenize(query))];
    const scored: { chunk: Chunk; score: number }[] = [];
    this.docs.forEach((chunk, i) => {
      let score = 0;
      const counts = this.tf[i]!;
      for (const t of terms) {
        const f = counts.get(t);
        if (!f) continue;
        score +=
          (this.idf(t) * f * (this.k1 + 1)) /
          (f + this.k1 * (1 - this.b + (this.b * this.lengths[i]!) / this.avg));
      }
      if (score > 0) scored.push({ chunk, score });
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export async function listFiles(repoDir: string): Promise<string[]> {
  const proc = Bun.spawn(["git", "-C", repoDir, "ls-files", "-z"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0)
    throw new Error(`git ls-files failed in ${repoDir}`);
  return out.split("\0").filter((f) => f && isIndexable(f));
}

export async function loadRepo(repoDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const file of await listFiles(repoDir)) {
    const buffer = await readFile(join(repoDir, file)).catch(() => null);
    if (!buffer || buffer.length > MAX_FILE_BYTES || buffer.includes(0))
      continue;
    files.set(file, buffer.toString("utf8"));
  }
  return files;
}

/** Reciprocal rank fusion of several ranked key lists (k=60, Cormack et al. 2009). */
export function reciprocalRankFusion(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists)
    list.forEach((key, rank) =>
      score.set(key, (score.get(key) ?? 0) + 1 / (k + rank + 1)),
    );
  return [...score]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}

/** Rank files by their best chunk, keeping chunk order for spans. */
export function filesFromChunks(ranked: { chunk: Chunk }[]): string[] {
  return [...new Set(ranked.map((r) => r.chunk.file))];
}
