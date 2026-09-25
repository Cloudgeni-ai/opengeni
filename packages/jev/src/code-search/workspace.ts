/**
 * The only way the code_search engine touches files and processes. The sandbox side implements it.
 *
 * The engine passes ripgrep only these flags, so an adapter may enforce an allowlist:
 * --files, --null, --line-number, --with-filename, --no-heading, --color never, -i, -w, --no-require-git,
 * --hidden, -m N, --max-columns N, --max-filesize N, -g GLOB, -e PATTERN, then `--` followed by
 * workspace-relative paths ("." or paths without a leading "-", no absolute paths, no "..").
 * A PATTERN is never longer than CODE_SEARCH_MAX_PATTERN_CHARS: the engine splits a longer alternation
 * into several ripgrep calls and merges their output.
 */

/**
 * Longest `-e` pattern the engine passes to ripgrep, so an adapter may cap pattern length (the sandbox
 * adapter rejects patterns over 16,384 characters).
 */
export const CODE_SEARCH_MAX_PATTERN_CHARS = 16_000;

export type CodeSearchRipgrepResult = {
  stdout: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
};

export interface CodeSearchWorkspace {
  /** Run ripgrep in the workspace root. `args` excludes the binary. stdout is exactly what rg prints (up to the adapter's byte cap; `truncated` reports a cut). exitCode follows rg: 0 matches, 1 none, 2 error. Throws CodeSearchWorkspaceError when ripgrep is missing or the workspace is unreachable. */
  ripgrep(
    args: readonly string[],
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<CodeSearchRipgrepResult>;
  /** Read a workspace-relative file as UTF-8. Null when missing. */
  readText(
    path: string,
    options: { signal?: AbortSignal; maxBytes: number },
  ): Promise<{ text: string; truncated: boolean; binary: boolean } | null>;
  /** Classify workspace-relative paths. */
  pathKinds(
    paths: readonly string[],
    options: { signal?: AbortSignal },
  ): Promise<Record<string, "file" | "directory" | "missing">>;
}

export class CodeSearchWorkspaceError extends Error {}

/**
 * Thrown by an adapter when the ripgrep binary is not installed, so the tool can tell the model to use
 * other search commands. A plain CodeSearchWorkspaceError whose message says ripgrep is missing is
 * recognised too.
 */
export class CodeSearchRipgrepMissingError extends CodeSearchWorkspaceError {
  constructor(message = "ripgrep (rg) is not installed in this workspace") {
    super(message);
    this.name = "CodeSearchRipgrepMissingError";
  }
}
