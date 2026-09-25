/**
 * A CodeSearchWorkspace over a local directory: runs the local `rg` with Bun.spawn and reads with node:fs.
 * It enforces the same ripgrep flag allowlist as the sandbox adapter, and the documented pattern cap, so a
 * test fails if the engine ever passes another flag or a longer pattern.
 */
import { open, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  CODE_SEARCH_MAX_PATTERN_CHARS,
  CodeSearchRipgrepMissingError,
  CodeSearchWorkspaceError,
  type CodeSearchRipgrepResult,
  type CodeSearchWorkspace,
} from "../../src";

const BARE_FLAGS = new Set([
  "--files",
  "--null",
  "--line-number",
  "--with-filename",
  "--no-heading",
  "-i",
  "-w",
  "--no-require-git",
  "--hidden",
]);
const VALUE_FLAGS = new Set(["--color", "-m", "--max-columns", "--max-filesize", "-g", "-e"]);

/** Throws when args contain anything outside the documented ripgrep allowlist. */
export function assertAllowedRipgrepArgs(args: readonly string[]): void {
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (BARE_FLAGS.has(a)) continue;
    if (!VALUE_FLAGS.has(a)) throw new Error(`ripgrep flag not allowed: ${a}`);
    const v = args[++i];
    if (v === undefined) throw new Error(`ripgrep flag ${a} needs a value`);
    if (a === "--color" && v !== "never") throw new Error(`--color ${v} not allowed`);
    if ((a === "-m" || a === "--max-columns" || a === "--max-filesize") && !/^\d+$/.test(v))
      throw new Error(`${a} ${v} not numeric`);
    if (a === "-e" && (!v || v.length > CODE_SEARCH_MAX_PATTERN_CHARS))
      throw new Error(
        `-e pattern of ${v.length} chars (1..${CODE_SEARCH_MAX_PATTERN_CHARS} allowed)`,
      );
  }
  if (args[i] !== "--") throw new Error("ripgrep args must end with -- and paths");
  const paths = args.slice(i + 1);
  if (!paths.length) throw new Error("ripgrep needs at least one path");
  for (const p of paths) {
    if (p !== "." && (p.startsWith("-") || isAbsolute(p) || p.split("/").includes("..")))
      throw new Error(`ripgrep path not allowed: ${p}`);
  }
}

export interface LocalWorkspaceOptions {
  rgBin?: string;
  /** Cut ripgrep stdout at this many bytes (reports truncated). */
  maxStdoutBytes?: number;
}

export class LocalCodeSearchWorkspace implements CodeSearchWorkspace {
  readonly calls: Array<{ kind: "ripgrep" | "readText" | "pathKinds"; args: readonly string[] }> =
    [];

  constructor(
    readonly root: string,
    private readonly options: LocalWorkspaceOptions = {},
  ) {}

  async ripgrep(
    args: readonly string[],
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<CodeSearchRipgrepResult> {
    this.calls.push({ kind: "ripgrep", args });
    assertAllowedRipgrepArgs(args);
    options.signal?.throwIfAborted();
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([this.options.rgBin ?? "rg", ...args], {
        cwd: this.root,
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") throw new CodeSearchRipgrepMissingError();
      throw new CodeSearchWorkspaceError(`ripgrep failed to start: ${(error as Error).message}`);
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, options.timeoutMs);
    const onAbort = () => proc.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const [out, exitCode] = await Promise.all([
        new Response(proc.stdout as ReadableStream).arrayBuffer(),
        proc.exited,
      ]);
      options.signal?.throwIfAborted();
      const bytes = new Uint8Array(out);
      const cap = this.options.maxStdoutBytes ?? Number.POSITIVE_INFINITY;
      const truncated = bytes.length > cap;
      const stdout = new TextDecoder().decode(truncated ? bytes.subarray(0, cap) : bytes);
      return { stdout, exitCode: timedOut ? null : exitCode, truncated, timedOut };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async readText(path: string, options: { signal?: AbortSignal; maxBytes: number }) {
    this.calls.push({ kind: "readText", args: [path] });
    options.signal?.throwIfAborted();
    const abs = this.inside(path);
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fh = await open(abs, "r");
      const st = await fh.stat();
      if (!st.isFile()) return null;
      const n = Math.min(st.size, options.maxBytes);
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, 0);
      return {
        text: buf.toString("utf8"),
        truncated: st.size > options.maxBytes,
        binary: buf.subarray(0, 8192).includes(0),
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") return null;
      throw error;
    } finally {
      await fh?.close();
    }
  }

  async pathKinds(paths: readonly string[], options: { signal?: AbortSignal }) {
    this.calls.push({ kind: "pathKinds", args: paths });
    options.signal?.throwIfAborted();
    const out: Record<string, "file" | "directory" | "missing"> = {};
    for (const p of paths) {
      try {
        const st = await stat(this.inside(p));
        out[p] = st.isDirectory() ? "directory" : st.isFile() ? "file" : "missing";
      } catch {
        out[p] = "missing";
      }
    }
    return out;
  }

  private inside(path: string): string {
    const abs = resolve(this.root, path);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new CodeSearchWorkspaceError(`path outside the workspace: ${path}`);
    return join(this.root, rel);
  }
}
