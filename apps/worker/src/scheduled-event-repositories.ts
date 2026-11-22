/**
 * The repository a GitHub event is about, checked out by the run it starts
 * (docs/agents.md, "Starts when"). A trigger may cover all of the GitHub
 * connection's repositories or several chosen ones (its
 * `data.repository.full_name` condition), so its task keeps no repository of
 * its own; each run attaches only the repositories its events are about.
 *
 * A repository is attached only when the workspace's GitHub App allowlist
 * offers it now, through one of the workspace's own installations: the same
 * check as the repository picker and every other attach. Event data is not
 * trusted for what it names (a test event's data is anyone's): the allowlist
 * decides on the event's repository id, and GitHub, asked through that
 * installation, must resolve the event's `owner/name` to that same id; the
 * name and default branch attached are GitHub's. One that fails any check is
 * left out, and the run goes ahead without it.
 *
 * Only an agent's triggers (Add trigger on an agent's page) with no
 * repository of their own work this way. Other automations keep exactly the
 * repositories they were saved with.
 */
import type { Settings } from "@opengeni/config";
import {
  defaultRepositoryMountPath,
  stableJson,
  type InboundEvent,
  type RepositoryResourceRef,
  type Session,
} from "@opengeni/contracts";
import { attachSessionRepositoryResource } from "@opengeni/core";
import {
  SessionRepositoryRemovedError,
  eventOccurrenceIdFromProducerKey,
  getEventOccurrenceForRun,
  getEventOccurrenceForScheduledTaskRun,
  listAllowedGitHubRepositoryIdsForWorkspace,
  listGitHubInstallationIdsForWorkspace,
  type Database,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import {
  createGitHubAppInstallationRepositoryLookup,
  type GitHubAppInstallationRepositoryLookup,
} from "@opengeni/github";

/** At most this many repositories per run, for an occurrence that coalesced several events. */
export const SCHEDULED_EVENT_REPOSITORY_LIMIT = 5;
/** At most this many GitHub lookups per run, whatever they find. */
export const SCHEDULED_EVENT_REPOSITORY_LOOKUPS = 10;

const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const BRANCH = /^[^\s~^:?*[\\]{1,255}$/u;

export type GitHubEventRepository = { id: number; fullName: string; defaultBranch: string };

/**
 * Whether a run's chat takes the repositories its events are about: a new
 * chat per run, started by an event, for an agent's trigger that keeps no
 * repository of its own.
 */
export function attachesEventRepositories(
  task: {
    runMode: string;
    agentConfig: {
      agentId?: string | null | undefined;
      resources?: readonly { kind: string }[] | null | undefined;
    };
  },
  run: { triggerType: string },
): boolean {
  return (
    task.runMode === "new_session_per_run" &&
    run.triggerType === "event" &&
    Boolean(task.agentConfig.agentId) &&
    !(task.agentConfig.resources ?? []).some((resource) => resource.kind === "repository")
  );
}

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

/** GitHub's repository lookup, or null when the GitHub App isn't set up here. */
export function eventRepositoryLookup(
  settings: Settings,
): GitHubAppInstallationRepositoryLookup | null {
  try {
    return createGitHubAppInstallationRepositoryLookup(settings);
  } catch {
    return null;
  }
}

/**
 * The repositories an event run checks out: its events' own that the
 * allowlist offers and GitHub confirms, at most
 * `SCHEDULED_EVENT_REPOSITORY_LIMIT`.
 */
export async function scheduledEventRepositoryResources(
  db: Database,
  /** The run's producer key (before the run exists), or the run's id. */
  input: { workspaceId: string } & ({ producerKey: string } | { runId: string }),
  lookup: GitHubAppInstallationRepositoryLookup | null,
): Promise<RepositoryResourceRef[]> {
  if (!lookup) return [];
  let occurrence;
  if ("producerKey" in input) {
    const occurrenceId = eventOccurrenceIdFromProducerKey(input.producerKey);
    occurrence = occurrenceId
      ? await getEventOccurrenceForRun(db, input.workspaceId, occurrenceId)
      : null;
  } else {
    occurrence = await getEventOccurrenceForScheduledTaskRun(db, input.workspaceId, input.runId);
  }
  if (!occurrence) return [];
  const repositories = githubEventRepositories(occurrence.events);
  if (repositories.length === 0) return [];
  // The installation offering each allowlisted id: one read per installation.
  const installationFor = new Map<number, number>();
  for (const installationId of await listGitHubInstallationIdsForWorkspace(db, input.workspaceId)) {
    const pending = repositories
      .map((repository) => repository.id)
      .filter((id) => !installationFor.has(id));
    if (pending.length === 0) break;
    for (const id of await listAllowedGitHubRepositoryIdsForWorkspace(
      db,
      input.workspaceId,
      installationId,
      pending,
    )) {
      installationFor.set(id, installationId);
    }
  }
  return await confirmedEventRepositoryResources(
    repositories,
    installationFor,
    lookup,
    "runId" in input ? input.runId : input.producerKey,
  );
}

/**
 * The event repositories GitHub confirms, as resources: each allowlisted id
 * (`installationFor`) whose event `owner/name` GitHub resolves, through that
 * installation, to the same id, with GitHub's own name and default branch.
 */
export async function confirmedEventRepositoryResources(
  repositories: readonly GitHubEventRepository[],
  installationFor: ReadonlyMap<number, number>,
  lookup: GitHubAppInstallationRepositoryLookup,
  runId: string,
): Promise<RepositoryResourceRef[]> {
  const resources: RepositoryResourceRef[] = [];
  let lookups = 0;
  for (const repository of repositories) {
    if (resources.length >= SCHEDULED_EVENT_REPOSITORY_LIMIT) break;
    const installationId = installationFor.get(repository.id);
    if (installationId === undefined) continue;
    if (lookups >= SCHEDULED_EVENT_REPOSITORY_LOOKUPS) break;
    lookups += 1;
    const [owner = "", name = ""] = repository.fullName.split("/");
    let found;
    try {
      found = await lookup({ installationId, owner, name });
    } catch (error) {
      console.warn("scheduled event repository lookup failed", {
        runId,
        repositoryId: repository.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    // The name must be the allowlisted repository's, as GitHub says now.
    if (!found || found.id !== repository.id) continue;
    const [confirmed] = githubEventRepositories([
      {
        sourceKind: "github",
        data: {
          repository: {
            id: found.id,
            full_name: found.fullName,
            default_branch: found.defaultBranch,
          },
        },
      },
    ]);
    if (confirmed) resources.push(githubEventRepositoryResource(confirmed, installationId));
  }
  return resources;
}

/**
 * Attach an event run's repositories (`scheduledEventRepositoryResources`,
 * resolved before any transaction, since it asks GitHub) to its chat before
 * its first turn, on the scheduler's behalf: a repository someone removed
 * from the chat stays removed, and one refused since the allowlist read is
 * left out.
 */
export async function attachScheduledEventRepositories(
  deps: { db: Database; bus: EventBus },
  input: {
    workspaceId: string;
    runId: string;
    sessionId: string;
    deferPublication: boolean;
    resources: readonly RepositoryResourceRef[];
  },
): Promise<{
  session: Session | null;
  events: Awaited<ReturnType<typeof attachSessionRepositoryResource>>["events"];
}> {
  let session: Session | null = null;
  const events: Awaited<ReturnType<typeof attachSessionRepositoryResource>>["events"] = [];
  for (const resource of input.resources) {
    try {
      const attached = await attachSessionRepositoryResource(
        { db: deps.db, bus: deps.bus },
        { workspaceId: input.workspaceId, sessionId: input.sessionId, resource },
        { deferPublication: input.deferPublication, requester: "agent" },
      );
      session = attached.session;
      events.push(...attached.events);
    } catch (error) {
      const status =
        error instanceof Error ? (error as Error & { status?: unknown }).status : undefined;
      if (!(error instanceof SessionRepositoryRemovedError) && status !== 409 && status !== 422) {
        throw error;
      }
      console.warn("scheduled event repository not attached", {
        runId: input.runId,
        repository: resource.uri,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { session, events };
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
