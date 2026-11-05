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
  const globs = workspaceTopLevelExcludeGlobs(topLevelGlobs);
  const patterns = [
    // An empty path would become `./`, which excludes nothing (the SDK drops
    // it as well).
    ...literalPaths
      .filter((path) => path.length > 0)
      .map((path) => `./${escapeWorkspaceGlobPattern(path)}`),
    ...globs.map((glob) => `./${glob}`),
  ].sort();
  return [...new Set(patterns)].map((pattern) => shellQuoteTarArg(`--exclude=${pattern}`));
}

/** The top-level folder a compute or OpenSandbox restore stages the new
 * workspace in, and the one it moves the old workspace to. */
export const WORKSPACE_RESTORE_STAGING_PREFIX = ".opengeni-restore-";
export const WORKSPACE_RESTORE_BACKUP_PREFIX = ".opengeni-old-";

/** Those folders as top-level globs. A failed cleanup can leave one behind;
 * it is never part of the workspace, so those backends' archives and the
 * workspace fingerprint both leave these out. */
export const WORKSPACE_RESTORE_SCRATCH_GLOBS: readonly string[] = Object.freeze([
  `${WORKSPACE_RESTORE_BACKUP_PREFIX}*`,
  `${WORKSPACE_RESTORE_STAGING_PREFIX}*`,
]);

/** The one check both the archive and the fingerprint apply to a session's
 * top-level exclusion globs: a plain top-level name pattern (no `/`, `\`,
 * control character, `.` or `..`). An invalid entry throws rather than being
 * dropped, since dropping it on one side only would make the archive and the
 * fingerprint disagree. Returns them sorted and de-duplicated. */
export function workspaceTopLevelExcludeGlobs(globs: readonly unknown[]): string[] {
  if (!Array.isArray(globs)) {
    throw new TypeError("workspace archive exclusion globs must be an array");
  }
  for (const glob of globs) {
    if (
      typeof glob !== "string" ||
      glob.length === 0 ||
      glob === "." ||
      glob === ".." ||
      // oxlint-disable-next-line no-control-regex
      /[/\\\u0000-\u001f\u007f]/u.test(glob)
    ) {
      throw new TypeError(
        `invalid top-level workspace archive exclusion glob: ${JSON.stringify(glob)}`,
      );
    }
  }
  return [...new Set(globs as string[])].sort();
}
