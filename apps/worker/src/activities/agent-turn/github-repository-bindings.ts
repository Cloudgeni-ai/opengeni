import type { Settings } from "@opengeni/config";
import type { CredentialAuthNeededPayload, ResourceRef } from "@opengeni/contracts";
import {
  applyGitHubRepositoryBindings,
  listGitHubRepositoryBindingCandidates,
  resolveGitHubRepositoryBindings,
  unboundGitHubRepositoryResources,
  type GitHubRepositoryBinding,
  type GitHubRepositoryBindingCandidate,
  type GitHubRepositoryBindingLookup,
  type GitHubRepositoryBindingResolution,
} from "@opengeni/core";
import type { Database } from "@opengeni/db";
import {
  createGitHubAppInstallationRepositoryLookup,
  githubAppMissingSettings,
} from "@opengeni/github";

/**
 * Turn-time GitHub App binding resolution for bare repository URIs.
 *
 * The web composer and the MCP repository catalog stamp
 * `githubInstallationId`/`githubRepositoryId` on every bound repository, but an
 * API caller, an older session, or an agent-spawned child may still carry a
 * bare `https://github.com/<owner>/<repo>` resource. The workspace allowlist
 * stores repository ids only, so the worker (which already talks to GitHub to
 * mint the sandbox token) resolves the URI here: the owner selects the
 * workspace's auditable installation(s) from Postgres, one server-side read
 * supplies GitHub's repository id, and the allowlist decides. Exactly one
 * allowlisted match stamps the ids for this turn's in-memory resources; every
 * other case keeps the resource bare (anonymous clone, as before) and reports a
 * visible warning. Nothing here is durable and nothing can fail the turn.
 */

export type TurnGitHubRepositoryBindings = {
  resources: ResourceRef[];
  bindings: Map<string, GitHubRepositoryBinding>;
  resolutions: GitHubRepositoryBindingResolution[];
  warnings: CredentialAuthNeededPayload[];
  /** Apply the same bindings to a sibling resource list (runtime resources). */
  apply: (resources: readonly ResourceRef[]) => ResourceRef[];
};

export async function resolveTurnGitHubRepositoryBindings(input: {
  db: Database;
  settings: Settings;
  workspaceId: string;
  resources: readonly ResourceRef[];
  /** Test seam; defaults to the workspace's auditable bindings under RLS. */
  listCandidates?: (
    db: Database,
    workspaceId: string,
  ) => Promise<GitHubRepositoryBindingCandidate[]>;
  /** Test seam; defaults to one live GitHub App lookup client per call. */
  lookup?: GitHubRepositoryBindingLookup;
}): Promise<TurnGitHubRepositoryBindings> {
  const passthrough = (): TurnGitHubRepositoryBindings => ({
    resources: [...input.resources],
    bindings: new Map(),
    resolutions: [],
    warnings: [],
    apply: (resources) => [...resources],
  });
  if (unboundGitHubRepositoryResources(input.resources).length === 0) {
    return passthrough();
  }
  let lookup = input.lookup;
  if (!lookup) {
    // Without App signing credentials no installation token could be minted
    // for a resolved id anyway, so a bare repository stays anonymous.
    if (githubAppMissingSettings(input.settings).length > 0) {
      return passthrough();
    }
    const live = createGitHubAppInstallationRepositoryLookup(input.settings);
    lookup = async (request) => {
      const repository = await live(request);
      return repository ? { id: repository.id } : null;
    };
  }
  const candidates = await (input.listCandidates ?? listGitHubRepositoryBindingCandidates)(
    input.db,
    input.workspaceId,
  );
  if (candidates.length === 0) {
    return passthrough();
  }
  const resolved = await resolveGitHubRepositoryBindings({
    resources: input.resources,
    candidates,
    lookup,
  });
  return {
    resources: resolved.resources,
    bindings: resolved.bindings,
    resolutions: resolved.resolutions,
    warnings: resolved.resolutions.flatMap(
      (resolution) => gitHubRepositoryBindingWarning(resolution) ?? [],
    ),
    apply: (resources) => applyGitHubRepositoryBindings(resources, resolved.bindings),
  };
}

/**
 * The visible warning for a bound-but-unusable repository. An unbound owner
 * is the ordinary anonymous public clone and produces no warning; a resolved
 * repository needs none.
 */
export function gitHubRepositoryBindingWarning(
  resolution: GitHubRepositoryBindingResolution,
): CredentialAuthNeededPayload | null {
  const repository = `${resolution.owner}/${resolution.name}`;
  switch (resolution.outcome.status) {
    case "resolved":
    case "unbound":
      return null;
    case "not_allowlisted":
      return {
        credentialClass: "run",
        providerDomain: "github.com",
        reason: "insufficient_scope",
        resource: resolution.uri,
        message: `GitHub repository ${repository} is not in the repository allowlist of the workspace's GitHub App installation for ${resolution.owner}. The sandbox clones it anonymously and cannot push or use gh until the repository is added to that installation.`,
      };
    case "ambiguous":
      return {
        credentialClass: "run",
        providerDomain: "github.com",
        reason: "insufficient_scope",
        resource: resolution.uri,
        message: `GitHub repository ${repository} is allowlisted by more than one GitHub App installation in this workspace (${resolution.outcome.installationIds.join(", ")}). Select it with an explicit installation, or unlink the duplicate binding, to receive a scoped token.`,
      };
    case "unavailable":
      return {
        credentialClass: "run",
        providerDomain: "github.com",
        reason: "refresh_failed",
        resource: resolution.uri,
        message: `GitHub repository ${repository} could not be resolved against the workspace's GitHub App installation (${resolution.outcome.message}). The sandbox clones it anonymously for this turn.`,
      };
  }
}
