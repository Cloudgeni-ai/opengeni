/**
 * The repository a GitHub event is about, checked out by the run it starts
 * (docs/agents.md, "Starts when"). A trigger may cover all of the GitHub
 * connection's repositories or several chosen ones (its
 * `data.repository.full_name` condition), so its task keeps no repository of
 * its own; each run attaches only the repositories its events are about.
 *
 * A repository is attached only when the workspace's GitHub App allowlist
 * offers it now, through one of the workspace's own installations: the same
 * check as the repository picker and every other attach. One GitHub refuses
 * is left out; the run goes ahead without it.
 */
import {
  defaultRepositoryMountPath,
  stableJson,
  type InboundEvent,
  type RepositoryResourceRef,
} from "@opengeni/contracts";
import {
  getEventOccurrenceForScheduledTaskRun,
  listAllowedGitHubRepositoryIdsForWorkspace,
  listGitHubInstallationIdsForWorkspace,
  type Database,
} from "@opengeni/db";

/** At most this many repositories per run, for an occurrence that coalesced several events. */
export const SCHEDULED_EVENT_REPOSITORY_LIMIT = 5;

const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const BRANCH = /^[^\s~^:?*[\\]{1,255}$/u;

export type GitHubEventRepository = { id: number; fullName: string; defaultBranch: string };

/** The distinct repositories a run's GitHub events are about, in event order. */
export function githubEventRepositories(
  events: readonly Pick<InboundEvent, "sourceKind" | "data">[],
): GitHubEventRepository[] {
  const found = new Map<number, GitHubEventRepository>();
  for (const event of events) {
    if (event.sourceKind !== "github") continue;
    const repository = event.data.repository;
    if (!repository || typeof repository !== "object" || Array.isArray(repository)) continue;
    const {
      id,
      full_name: fullName,
      default_branch: defaultBranch,
    } = repository as Record<string, unknown>;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;
    if (
      typeof fullName !== "string" ||
      !FULL_NAME.test(fullName) ||
      fullName.split("/").some((part) => part === "." || part === "..")
    ) {
      continue;
    }
    if (typeof defaultBranch !== "string" || !BRANCH.test(defaultBranch)) continue;
    if (!found.has(id)) found.set(id, { id, fullName, defaultBranch });
  }
  return [...found.values()];
}

/** The repository resource of one event repository, as the picker binds it. */
export function githubEventRepositoryResource(
  repository: GitHubEventRepository,
  installationId: number,
): RepositoryResourceRef {
  const uri = `https://github.com/${repository.fullName}.git`;
  return {
    kind: "repository",
    uri,
    ref: repository.defaultBranch,
    provider: "github",
    mountPath: defaultRepositoryMountPath(uri, "github"),
    githubRepositoryId: repository.id,
    githubInstallationId: installationId,
    // Best effort: a repository GitHub can't clone leaves the run going.
    optional: true,
  };
}

/** The repositories an event run checks out: its events' own, where the allowlist offers them. */
export async function scheduledEventRepositoryResources(
  db: Database,
  input: { workspaceId: string; runId: string },
): Promise<RepositoryResourceRef[]> {
  const occurrence = await getEventOccurrenceForScheduledTaskRun(
    db,
    input.workspaceId,
    input.runId,
  );
  if (!occurrence) return [];
  const repositories = githubEventRepositories(occurrence.events).slice(
    0,
    SCHEDULED_EVENT_REPOSITORY_LIMIT,
  );
  if (repositories.length === 0) return [];
  const installations = await listGitHubInstallationIdsForWorkspace(db, input.workspaceId);
  const resources: RepositoryResourceRef[] = [];
  for (const repository of repositories) {
    for (const installationId of installations) {
      const allowed = await listAllowedGitHubRepositoryIdsForWorkspace(
        db,
        input.workspaceId,
        installationId,
        [repository.id],
      );
      if (allowed.includes(repository.id)) {
        resources.push(githubEventRepositoryResource(repository, installationId));
        break;
      }
    }
  }
  return resources;
}

/**
 * Whether a recovered run's chat has its task's repositories plus only
 * repositories its events were about, as `scheduledEventRepositoryResources`
 * attaches them.
 */
export function sessionResourcesMatchEventRun(input: {
  sessionResources: readonly unknown[];
  taskResources: readonly unknown[];
  eventRepositoryIds: ReadonlySet<number>;
}): boolean {
  const taskCount = input.taskResources.length;
  if (stableJson(input.sessionResources.slice(0, taskCount)) !== stableJson(input.taskResources)) {
    return false;
  }
  return input.sessionResources.slice(taskCount).every((resource) => {
    if (!resource || typeof resource !== "object") return false;
    const ref = resource as Partial<RepositoryResourceRef>;
    return (
      ref.kind === "repository" &&
      ref.provider === "github" &&
      typeof ref.githubRepositoryId === "number" &&
      input.eventRepositoryIds.has(ref.githubRepositoryId)
    );
  });
}
