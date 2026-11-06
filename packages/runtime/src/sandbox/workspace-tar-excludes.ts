/** One definition of how a workspace tar leaves paths out, shared by every
 * backend's archive and by the workspace fingerprint.
 *
 * It matches the Agents SDK's `workspaceTarExcludeArgs`: each path becomes one
 * pattern anchored at `./` with its glob characters escaped. A bare
 * `--exclude=<name>` would also match the same name deeper in the tree
 * (`docs/target` for a top-level `target`), and an unescaped `[`, `*` or `?`
 * in a path would match other names, so the archive and the fingerprint would
 * disagree and a restore could never verify. */

export function shellQuoteTarArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** A literal path as a glob pattern: `*`, `?`, `[`, `]` and `\` match only
 * themselves. */
export function escapeWorkspaceGlobPattern(path: string): string {
  return path.replace(/([*?[\]\\])/gu, "\\$1");
}

/** Shell-quoted tar `--exclude` arguments for workspace-relative literal
 * paths, plus optional top-level glob patterns (used as given, anchored at
 * `./`) such as `.opengeni-old-*`. */
export function workspaceTarExcludeArgs(
  literalPaths: readonly string[],
  topLevelGlobs: readonly string[] = [],
): string[] {
  const patterns = [
    // An empty path would become `./`, which excludes nothing (the SDK drops
    // it as well).
    ...literalPaths
      .filter((path) => path.length > 0)
      .map((path) => `./${escapeWorkspaceGlobPattern(path)}`),
    ...topLevelGlobs.map((glob) => `./${glob}`),
  ].sort();
  return [...new Set(patterns)].map((pattern) => shellQuoteTarArg(`--exclude=${pattern}`));
}
