/**
 * session.ts - one search's view of the workspace: counts calls, records partial ripgrep output and
 * makes every call honour the search's AbortSignal.
 */
import { CodeSearchWorkspaceError, type CodeSearchWorkspace } from "./workspace";

/** Parallel reads per search. */
export const READ_CONCURRENCY = 8;
/** Parallel ripgrep calls for one pattern split under CODE_SEARCH_MAX_PATTERN_CHARS. */
export const RIPGREP_SPLIT_CONCURRENCY = 4;

export class WorkspaceSession {
  calls = 0;
  /** A ripgrep call returned output cut at the adapter's byte cap. */
  truncated = false;
  /** A ripgrep call hit its time limit (its output is partial). */
  timedOut = false;

  constructor(
    private readonly workspace: CodeSearchWorkspace,
    readonly signal: AbortSignal,
    private readonly ripgrepTimeoutMs: number,
  ) {}

  get partial(): boolean {
    return this.truncated || this.timedOut;
  }

  /**
   * ripgrep stdout. Exit code 2 (error) with some output keeps the output (for example unreadable files);
   * with no output it throws unless `allowFailure`, which then yields "".
   */
  async ripgrep(
    args: readonly string[],
    options: { allowFailure?: boolean } = {},
  ): Promise<string> {
    this.signal.throwIfAborted();
    this.calls++;
    const r = await this.workspace.ripgrep(args, {
      signal: this.signal,
      timeoutMs: this.ripgrepTimeoutMs,
    });
    this.signal.throwIfAborted();
    if (r.truncated) this.truncated = true;
    if (r.timedOut) this.timedOut = true;
    if (r.exitCode === 2 && !r.stdout && !r.truncated && !r.timedOut && !options.allowFailure) {
      throw new CodeSearchWorkspaceError("ripgrep failed (exit code 2) without output");
    }
    return r.stdout;
  }

  /** File text, or null when missing or binary (NUL bytes). */
  async readText(path: string, maxBytes: number): Promise<string | null> {
    this.signal.throwIfAborted();
    this.calls++;
    const r = await this.workspace.readText(path, { signal: this.signal, maxBytes });
    this.signal.throwIfAborted();
    if (!r || r.binary || r.text.includes("\u0000")) return null;
    return r.text;
  }

  async pathKinds(
    paths: readonly string[],
  ): Promise<Record<string, "file" | "directory" | "missing">> {
    this.signal.throwIfAborted();
    this.calls++;
    const r = await this.workspace.pathKinds(paths, { signal: this.signal });
    this.signal.throwIfAborted();
    return r;
  }
}

/** Map with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
