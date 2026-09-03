import type { SessionEvent, WorkspaceArtifact, WorkspaceArtifactListResponse } from "@opengeni/sdk";

const SITE_MUTATION_TOOL_NAMES = new Set(
  [
    "artifacts_create",
    "artifacts_publish",
    "artifacts_rollback",
    "artifacts_archive",
    "artifacts_restore",
  ].flatMap((name) => [name, `opengeni__${name}`]),
);
const SITE_NAVIGATION_MAX_PAGES = 10;
let siteNavigationSnapshot = 0;
const siteNavigationListeners = new Set<() => void>();

export function subscribeSiteNavigation(listener: () => void): () => void {
  siteNavigationListeners.add(listener);
  return () => siteNavigationListeners.delete(listener);
}

export function getSiteNavigationSnapshot(): number {
  return siteNavigationSnapshot;
}

export function notifySiteNavigationChanged(): void {
  siteNavigationSnapshot += 1;
  for (const listener of siteNavigationListeners) listener();
}

export async function collectRecentActiveSites(
  fetchPage: (cursor: string | null) => Promise<WorkspaceArtifactListResponse>,
  displayLimit: number,
): Promise<readonly WorkspaceArtifact[]> {
  const active: WorkspaceArtifact[] = [];
  const artifactIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;

  while (active.length < displayLimit && pages < SITE_NAVIGATION_MAX_PAGES) {
    pages += 1;
    const page = await fetchPage(cursor);
    for (const artifact of page.artifacts) {
      if (artifact.status !== "active" || artifactIds.has(artifact.id)) continue;
      artifactIds.add(artifact.id);
      active.push(artifact);
      if (active.length === displayLimit) break;
    }
    const nextCursor = page.nextCursor;
    if (!page.truncated || !nextCursor || cursors.has(nextCursor)) break;
    cursors.add(nextCursor);
    cursor = nextCursor;
  }

  return active;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Return the latest settled first-party Site lifecycle mutation in one routed session.
 * The rail uses this compact primitive as a refresh key instead of fetching
 * after every unrelated tool output.
 */
export function latestSiteMutationSequence(events: readonly SessionEvent[]): number {
  const siteCalls = new Set<string>();
  let latest = 0;
  for (const event of events) {
    const payload = record(event.payload);
    const callId = typeof payload?.id === "string" ? payload.id : null;
    if (event.type === "agent.toolCall.created" && callId) {
      const name = typeof payload?.name === "string" ? payload.name : "";
      if (SITE_MUTATION_TOOL_NAMES.has(name)) siteCalls.add(callId);
      continue;
    }
    if (event.type === "agent.toolCall.output" && callId && siteCalls.has(callId)) {
      latest = event.sequence;
    }
  }
  return latest;
}
