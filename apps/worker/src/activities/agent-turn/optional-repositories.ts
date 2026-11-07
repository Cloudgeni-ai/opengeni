import type { Settings } from "@opengeni/config";
import { resourceMountPath, type ResourceRef } from "@opengeni/contracts";
import { listAllowedGitHubRepositoryIdsForWorkspace, type Database } from "@opengeni/db";
import {
  findInaccessibleGitHubAppInstallationRepositories,
  githubAppMissingSettings,
} from "@opengeni/github";
import { gitHubTokenAuthorizationSelections } from "../environment";

/**
 * Turn-time access check for automatically attached (`optional: true`) GitHub
 * App repositories.
 *
 * A Slack-started session attaches the repositories in the caller's new-chat
 * form as optional resources. The per-turn workspace-allowlist recheck and the
 * installation-token mint both cover every GitHub repository of the session in
 * one request, so one optional repository that loses access after the session
 * started (an admin removes it from the allowlist, or it is deleted or removed
 * from the App on GitHub) would fail every later turn. Before those checks, this
 * drops each optional repository that is no longer allowlisted or no longer
 * reachable through its installation, for this turn only, and reports it the
 * same way a skipped optional clone is reported. It only ever removes
 * repositories: a remaining repository still passes the unchanged strict
 * allowlist recheck and mint, and an explicitly attached repository is never
 * dropped, so it keeps failing the turn when its access is gone.
 */

export const OPTIONAL_REPOSITORY_ACCESS_OPERATION = "optional-repository-access";

type OptionalRepositoryCandidate = {
  resource: Extract<ResourceRef, { kind: "repository" }>;
  installationId: number;
  repositoryId: number;
};

export type OptionalRepositoryDropReason = "not_allowlisted" | "inaccessible" | "unverified";

export type DropUnavailableOptionalRepositoriesInput = {
  db: Database;
  signal?: AbortSignal;
  settings: Settings;
  workspaceId: string;
  activeSandboxBackend: Settings["sandboxBackend"] | undefined;
  /**
   * True when a host `gitCredentials` port mints the Git tokens: the host may
   * use another GitHub App, so this deployment's App is not asked.
   */
  hostMintsGitCredentials: boolean;
  turnResources: readonly ResourceRef[];
  runtimeResources: readonly ResourceRef[];
  /** Publishes one attempt-fenced session event batch. */
  publish: (
    events: Array<{
      type: "sandbox.operation.completed";
      payload: {
        name: typeof OPTIONAL_REPOSITORY_ACCESS_OPERATION;
        repositoryCount: number;
        skippedOptionalRepositories: string[];
      };
    }>,
  ) => Promise<void>;
  /** Operational log line; counts only, never repository names. */
  warn: (message: string, fields: Record<string, string>) => void;
  /** Batched decisions under the same audited workspace authority. */
  allowedRepositoryIds?: (installationId: number, repositoryIds: number[]) => Promise<number[]>;
  /** Compatibility test seam for individual authority outcomes. */
  isAllowlisted?: (installationId: number, repositoryId: number) => Promise<boolean>;
  /** Test seam; defaults to a live GitHub App token-mint probe. */
  findInaccessible?: (installationId: number, repositoryIds: number[]) => Promise<number[]>;
};

function optionalGitHubAppRepositoryCandidate(
  resource: ResourceRef,
): OptionalRepositoryCandidate | null {
  if (resource.kind !== "repository" || resource.optional !== true) return null;
  let selections: ReturnType<typeof gitHubTokenAuthorizationSelections>;
  try {
    // The exact selection the allowlist recheck and the mint derive, so the
    // decision here covers precisely what those strict steps would check.
    selections = gitHubTokenAuthorizationSelections([resource]);
  } catch {
    return null;
  }
  const [selection] = selections;
  if (!selection || selections.length !== 1 || selection.repositoryIds.length !== 1) return null;
  return {
    resource,
    installationId: selection.installationId,
    repositoryId: selection.repositoryIds[0]!,
  };
}

function repositoryIdentity(resource: ResourceRef): string | null {
  return resource.kind === "repository"
    ? `${resource.uri}\u0000${resourceMountPath(resource)}`
    : null;
}

export async function dropUnavailableOptionalRepositories(
  input: DropUnavailableOptionalRepositoriesInput,
): Promise<{
  turnResources: ResourceRef[];
  runtimeResources: ResourceRef[];
  /**
   * The same decision for another view of this turn's resources (the GitHub
   * REST tool surface is built from the unbound session resources).
   */
  retainsResource: (resource: ResourceRef) => boolean;
}> {
  const passthrough = {
    turnResources: [...input.turnResources],
    runtimeResources: [...input.runtimeResources],
    retainsResource: () => true,
  };
  // A Connected Machine receives no platform Git credential and runs neither
  // the allowlist recheck nor the mint, so nothing can fail there.
  if (input.activeSandboxBackend === "selfhosted") return passthrough;
  const candidates = input.turnResources.flatMap(
    (resource) => optionalGitHubAppRepositoryCandidate(resource) ?? [],
  );
  if (candidates.length === 0) return passthrough;

  input.signal?.throwIfAborted();
  const dropped = new Map<OptionalRepositoryCandidate, OptionalRepositoryDropReason>();
  const byInstallation = new Map<number, OptionalRepositoryCandidate[]>();
  for (const candidate of candidates) {
    const group = byInstallation.get(candidate.installationId) ?? [];
    group.push(candidate);
    byInstallation.set(candidate.installationId, group);
  }
  await visitOptionalRepositories(
    [...byInstallation],
    input.signal,
    async ([installationId, group]) => {
      const ids = [...new Set(group.map((candidate) => candidate.repositoryId))];
      if (input.isAllowlisted) {
        // Preserve the individual failure seam used by embedded callers/tests.
        const outcomes = new Map<number, OptionalRepositoryDropReason>();
        await visitOptionalRepositories(ids, input.signal, async (id) => {
          try {
            if (!(await input.isAllowlisted!(installationId, id)))
              outcomes.set(id, "not_allowlisted");
          } catch {
            input.signal?.throwIfAborted();
            outcomes.set(id, "unverified");
          }
        });
        for (const candidate of group) {
          const reason = outcomes.get(candidate.repositoryId);
          if (reason) dropped.set(candidate, reason);
        }
        return;
      }
      try {
        const allowed = new Set(
          await (
            input.allowedRepositoryIds ??
            ((targetInstallationId, requestedIds) =>
              listAllowedGitHubRepositoryIdsForWorkspace(
                input.db,
                input.workspaceId,
                targetInstallationId,
                requestedIds,
              ))
          )(installationId, ids),
        );
        input.signal?.throwIfAborted();
        for (const candidate of group) {
          if (!allowed.has(candidate.repositoryId)) dropped.set(candidate, "not_allowlisted");
        }
      } catch {
        input.signal?.throwIfAborted();
        for (const candidate of group) dropped.set(candidate, "unverified");
      }
    },
  );
  input.signal?.throwIfAborted();
  const allowlisted = candidates.filter((candidate) => !dropped.has(candidate));

  const findInaccessible =
    input.findInaccessible ??
    (!input.hostMintsGitCredentials && githubAppMissingSettings(input.settings).length === 0
      ? (installationId: number, repositoryIds: number[]) =>
          findInaccessibleGitHubAppInstallationRepositories(input.settings, {
            installationId,
            repositoryIds,
            ...(input.signal ? { signal: input.signal } : {}),
          })
      : null);
  if (findInaccessible && allowlisted.length > 0) {
    const allowlistedByInstallation = new Map<number, OptionalRepositoryCandidate[]>();
    for (const candidate of allowlisted) {
      const group = allowlistedByInstallation.get(candidate.installationId) ?? [];
      group.push(candidate);
      allowlistedByInstallation.set(candidate.installationId, group);
    }
    await visitOptionalRepositories(
      [...allowlistedByInstallation],
      input.signal,
      async ([installationId, group]) => {
        try {
          const inaccessible = new Set(
            await findInaccessible(installationId, [
              ...new Set(group.map((candidate) => candidate.repositoryId)),
            ]),
          );
          input.signal?.throwIfAborted();
          for (const candidate of group) {
            if (inaccessible.has(candidate.repositoryId)) dropped.set(candidate, "inaccessible");
          }
        } catch {
          input.signal?.throwIfAborted();
          // GitHub could not answer. An optional repository must never fail
          // the turn, and keeping it would put it into a mint GitHub may then
          // refuse, so it sits this turn out and is checked again next turn.
          for (const candidate of group) dropped.set(candidate, "unverified");
        }
      },
    );
  }
  input.signal?.throwIfAborted();
  if (dropped.size === 0) return passthrough;

  const droppedIdentities = new Set(
    [...dropped.keys()].flatMap((candidate) => repositoryIdentity(candidate.resource) ?? []),
  );
  const keep = (resource: ResourceRef): boolean => {
    if (resource.kind !== "repository" || resource.optional !== true) return true;
    const identity = repositoryIdentity(resource);
    return identity === null || !droppedIdentities.has(identity);
  };
  const reasons = [...dropped.values()];
  input.warn("optional repository resources were dropped for this turn", {
    droppedCount: String(dropped.size),
    notAllowlistedCount: String(reasons.filter((reason) => reason === "not_allowlisted").length),
    inaccessibleCount: String(reasons.filter((reason) => reason === "inaccessible").length),
    unverifiedCount: String(reasons.filter((reason) => reason === "unverified").length),
    origin: "worker",
  });
  await input.publish([
    {
      type: "sandbox.operation.completed",
      payload: {
        name: OPTIONAL_REPOSITORY_ACCESS_OPERATION,
        repositoryCount: input.turnResources.filter((resource) => resource.kind === "repository")
          .length,
        skippedOptionalRepositories: [
          ...new Set([...dropped.keys()].map((candidate) => resourceMountPath(candidate.resource))),
        ].sort(),
      },
    },
  ]);
  return {
    turnResources: input.turnResources.filter(keep),
    runtimeResources: input.runtimeResources.filter(keep),
    retainsResource: keep,
  };
}

/** Bound queued provider/database work and join admitted siblings on failure. */
async function visitOptionalRepositories<T>(
  values: readonly T[],
  signal: AbortSignal | undefined,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(8, values.length) }, async () => {
      while (!failed && next < values.length) {
        try {
          signal?.throwIfAborted();
          await visit(values[next++]!);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
  signal?.throwIfAborted();
}
