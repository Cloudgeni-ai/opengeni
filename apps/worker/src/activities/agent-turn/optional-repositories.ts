import type { Settings } from "@opengeni/config";
import { resourceMountPath, type ResourceRef } from "@opengeni/contracts";
import { prReviewRegistrationIdFromCredentialBinding } from "@opengeni/core";
import { areGitHubRepositoriesAllowedForWorkspace, type Database } from "@opengeni/db";
import {
  findInaccessibleGitHubAppInstallationRepositories,
  githubAppMissingSettings,
} from "@opengeni/github";
import { gitHubTokenAuthorizationSelections } from "../environment";

/**
 * Turn-time access check for automatically attached (`optional: true`) GitHub
 * App repositories.
 *
 * A Slack-started session attaches the caller's recently used repositories as
 * optional resources. The per-turn workspace-allowlist recheck and the
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
  /** Test seam; defaults to the workspace allowlist under RLS. */
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
  // PR-review bindings are authorized by their own registration, not the
  // workspace allowlist; they are never automatically attached.
  if (prReviewRegistrationIdFromCredentialBinding(selection.credentialBindingId)) return null;
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

  const isAllowlisted =
    input.isAllowlisted ??
    ((installationId: number, repositoryId: number) =>
      areGitHubRepositoriesAllowedForWorkspace(input.db, input.workspaceId, installationId, [
        repositoryId,
      ]));
  const dropped = new Map<OptionalRepositoryCandidate, OptionalRepositoryDropReason>();
  const allowlisted: OptionalRepositoryCandidate[] = [];
  const admitted = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return (await isAllowlisted(candidate.installationId, candidate.repositoryId))
          ? ("allowlisted" as const)
          : ("not_allowlisted" as const);
      } catch {
        // The check itself failed: an optional repository must not fail the
        // turn, so it sits this turn out like an unverifiable GitHub answer.
        return "unverified" as const;
      }
    }),
  );
  candidates.forEach((candidate, index) => {
    const outcome = admitted[index]!;
    if (outcome === "allowlisted") allowlisted.push(candidate);
    else dropped.set(candidate, outcome);
  });

  const findInaccessible =
    input.findInaccessible ??
    (!input.hostMintsGitCredentials && githubAppMissingSettings(input.settings).length === 0
      ? (installationId: number, repositoryIds: number[]) =>
          findInaccessibleGitHubAppInstallationRepositories(input.settings, {
            installationId,
            repositoryIds,
          })
      : null);
  if (findInaccessible && allowlisted.length > 0) {
    const byInstallation = new Map<number, OptionalRepositoryCandidate[]>();
    for (const candidate of allowlisted) {
      const group = byInstallation.get(candidate.installationId) ?? [];
      group.push(candidate);
      byInstallation.set(candidate.installationId, group);
    }
    await Promise.all(
      [...byInstallation].map(async ([installationId, group]) => {
        try {
          const inaccessible = new Set(
            await findInaccessible(
              installationId,
              group.map((candidate) => candidate.repositoryId),
            ),
          );
          for (const candidate of group) {
            if (inaccessible.has(candidate.repositoryId)) dropped.set(candidate, "inaccessible");
          }
        } catch {
          // GitHub could not answer. An optional repository must never fail
          // the turn, and keeping it would put it into a mint GitHub may then
          // refuse, so it sits this turn out and is checked again next turn.
          for (const candidate of group) dropped.set(candidate, "unverified");
        }
      }),
    );
  }
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
