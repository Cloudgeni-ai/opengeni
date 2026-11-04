// Tells the composer's repository menu that the person left to change GitHub
// access, so it refreshes (and syncs, for an App manager) once they are back.
// Its own small module so the GitHub settings page can mark a return without
// loading the composer.

/**
 * When the person last left to change a workspace's GitHub access (on GitHub
 * or the GitHub settings page). Module scope, so the mark outlives a composer
 * that unmounted while they were on the settings page.
 */
const githubAccessChanges = new Map<string, number>();

/** Opening the menu refreshes at most this often; returning from a GitHub flow skips it. */
export const REPOSITORY_OPEN_REFRESH_COOLDOWN_MS = 30_000;
/**
 * Every return within this window counts as coming back from GitHub, so a
 * glance back before finishing there doesn't use up the sync.
 */
export const GITHUB_RETURN_WINDOW_MS = 10 * 60_000;
/** Returns refresh at most this often (alt-tabbing back and forth). */
export const GITHUB_RETURN_REFRESH_INTERVAL_MS = 10_000;

/**
 * The person is leaving to change this workspace's GitHub access: install,
 * choose repositories, or the GitHub settings page. Their next returns
 * refresh the repository menu at once (and sync for an App manager).
 */
export function markGitHubAccessChanged(workspaceId: string): void {
  githubAccessChanges.set(workspaceId, Date.now());
}

/** Forgets every return mark (for tests). */
export function clearGitHubAccessChanges(): void {
  githubAccessChanges.clear();
}

/** True while a return from GitHub is still within its window. */
export function returningFromGitHub(workspaceId: string): boolean {
  const leftAt = githubAccessChanges.get(workspaceId);
  if (leftAt === undefined) return false;
  if (Date.now() - leftAt < GITHUB_RETURN_WINDOW_MS) return true;
  githubAccessChanges.delete(workspaceId);
  return false;
}
