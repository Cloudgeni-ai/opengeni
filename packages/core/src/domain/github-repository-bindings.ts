import type { RepositoryResourceRef, ResourceRef } from "@opengeni/contracts";
import {
  hasAuditableGitHubInstallationAuthority,
  listGitHubInstallationAccessForWorkspace,
  type Database,
} from "@opengeni/db";

/**
 * GitHub App repository-binding resolution for bare repository resources.
 *
 * A repository resource that names a GitHub repository by URI alone (no
 * `githubInstallationId`/`githubRepositoryId`) never mints an installation
 * token, so the sandbox clones it anonymously and cannot push or use `gh`.
 * The workspace allowlist (`github_installation_repositories`) stores only
 * numeric repository ids, so resolving a URI needs the installation's owner
 * login from the durable binding plus one provider read for the repository id.
 * This module owns the pure parts: URI parsing, candidate selection under the
 * workspace's auditable bindings, and the exactly-one-match stamping rule. The
 * provider read is injected so the worker can supply the live GitHub lookup
 * while tests stay deterministic.
 */

export type GitHubRepositoryCoordinates = { owner: string; name: string };

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const GITHUB_SCP_LIKE_PATTERN = /^git@(?:www\.)?github\.com:(.+)$/iu;

function coordinatesFromPath(path: string): GitHubRepositoryCoordinates | null {
  const segments = path.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const owner = segments[0]!;
  const name = segments[1]!.replace(/\.git$/u, "");
  if (!GITHUB_OWNER_PATTERN.test(owner) || !name || !GITHUB_NAME_PATTERN.test(name)) {
    return null;
  }
  return { owner, name };
}

/**
 * Parse a GitHub repository reference into owner/name, else null. Accepts
 * `https://github.com/<owner>/<repo>[.git][/]`, `www.github.com`,
 * `ssh://git@github.com/<owner>/<repo>[.git]`, and the scp-like
 * `git@github.com:<owner>/<repo>[.git]`.
 */
export function parseGitHubRepositoryCoordinates(uri: string): GitHubRepositoryCoordinates | null {
  const trimmed = uri.trim();
  const scpLike = GITHUB_SCP_LIKE_PATTERN.exec(trimmed);
  if (scpLike) {
    return coordinatesFromPath(scpLike[1]!);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase()) || url.search || url.hash) {
    return null;
  }
  if (url.protocol === "https:" || url.protocol === "http:") {
    if (url.username || url.password) return null;
  } else if (url.protocol === "ssh:") {
    if (url.password || (url.username && url.username !== "git")) return null;
  } else {
    return null;
  }
  return coordinatesFromPath(url.pathname);
}

export type UnboundGitHubRepositoryResource = {
  resource: RepositoryResourceRef;
  owner: string;
  name: string;
};

/**
 * Repository resources that name a github.com repository without any
 * platform identity: no GitHub App ids, no credential binding, no personal
 * connection, and either the explicit `github` provider or no provider at all.
 * Resources that already carry ids, legacy provider ids, a binding, or a
 * connection are someone else's authority and are never rewritten here.
 */
export function unboundGitHubRepositoryResources(
  resources: readonly ResourceRef[],
): UnboundGitHubRepositoryResource[] {
  const out: UnboundGitHubRepositoryResource[] = [];
  for (const resource of resources) {
    if (resource.kind !== "repository") continue;
    if (resource.provider !== undefined && resource.provider !== "github") continue;
    if (
      resource.githubInstallationId !== undefined ||
      resource.githubRepositoryId !== undefined ||
      resource.installationId !== undefined ||
      resource.repositoryId !== undefined ||
      resource.credentialBindingId !== undefined ||
      resource.connectionId !== undefined ||
      resource.connectionType !== undefined
    ) {
      continue;
    }
    const coordinates = parseGitHubRepositoryCoordinates(resource.uri);
    if (!coordinates) continue;
    out.push({ resource, ...coordinates });
  }
  return out;
}

export type GitHubRepositoryBindingCandidate = {
  installationId: number;
  accountLogin: string;
  repositoryIds: number[];
};

/**
 * The workspace's auditable GitHub App bindings, under workspace RLS. Only
 * bindings that could authorize a token mint are candidates; legacy
 * `unverified` rows never resolve a URI.
 */
export async function listGitHubRepositoryBindingCandidates(
  db: Database,
  workspaceId: string,
): Promise<GitHubRepositoryBindingCandidate[]> {
  const installations = await listGitHubInstallationAccessForWorkspace(db, workspaceId);
  return installations
    .filter((installation) => hasAuditableGitHubInstallationAuthority(installation))
    .map((installation) => ({
      installationId: installation.installationId,
      accountLogin: installation.accountLogin ?? "",
      repositoryIds: [...installation.repositoryIds],
    }))
    .filter((candidate) => candidate.accountLogin.length > 0);
}

export type GitHubRepositoryBindingLookup = (input: {
  installationId: number;
  owner: string;
  name: string;
}) => Promise<{ id: number } | null>;

export type GitHubRepositoryBinding = { installationId: number; repositoryId: number };

export type GitHubRepositoryBindingOutcome =
  | { status: "resolved"; binding: GitHubRepositoryBinding }
  /** No workspace binding owns this repository's account: anonymous, as before. */
  | { status: "unbound" }
  /** The account is bound, but no installation's allowlist holds this repository. */
  | { status: "not_allowlisted"; installationIds: number[] }
  /** More than one bound installation's allowlist holds this repository. */
  | { status: "ambiguous"; installationIds: number[] }
  /** The provider lookup failed (suspended/deleted installation, outage). */
  | { status: "unavailable"; installationIds: number[]; message: string };

export type GitHubRepositoryBindingResolution = {
  uri: string;
  owner: string;
  name: string;
  outcome: GitHubRepositoryBindingOutcome;
};

export type GitHubRepositoryBindingResolutionResult = {
  resources: ResourceRef[];
  bindings: Map<string, GitHubRepositoryBinding>;
  resolutions: GitHubRepositoryBindingResolution[];
};

/**
 * Resolve every bare github.com repository resource against the workspace's
 * auditable bindings. A resource is stamped only when exactly one bound
 * installation's allowlist contains the repository id GitHub reports for that
 * URI through that installation. Every other case leaves the resource bare
 * and reports why, so the caller can surface a warning without ever failing
 * the turn or the session. Distinct URIs resolve concurrently, as do the
 * candidate installations of one owner.
 */
export async function resolveGitHubRepositoryBindings(input: {
  resources: readonly ResourceRef[];
  candidates: readonly GitHubRepositoryBindingCandidate[];
  lookup: GitHubRepositoryBindingLookup;
}): Promise<GitHubRepositoryBindingResolutionResult> {
  const unbound = unboundGitHubRepositoryResources(input.resources);
  const bindings = new Map<string, GitHubRepositoryBinding>();
  if (unbound.length === 0) {
    return { resources: [...input.resources], bindings, resolutions: [] };
  }
  const candidatesByLogin = new Map<string, GitHubRepositoryBindingCandidate[]>();
  for (const candidate of input.candidates) {
    const key = candidate.accountLogin.toLowerCase();
    const list = candidatesByLogin.get(key) ?? [];
    list.push(candidate);
    candidatesByLogin.set(key, list);
  }
  const distinct = new Map<string, UnboundGitHubRepositoryResource>();
  for (const entry of unbound) {
    if (!distinct.has(entry.resource.uri)) distinct.set(entry.resource.uri, entry);
  }
  const resolutions = await Promise.all(
    [...distinct.values()].map(async (entry) => ({
      uri: entry.resource.uri,
      owner: entry.owner,
      name: entry.name,
      outcome: await resolveOne(
        entry,
        candidatesByLogin.get(entry.owner.toLowerCase()) ?? [],
        input.lookup,
      ),
    })),
  );
  for (const resolution of resolutions) {
    if (resolution.outcome.status === "resolved") {
      bindings.set(resolution.uri, resolution.outcome.binding);
    }
  }
  return {
    resources: applyGitHubRepositoryBindings(input.resources, bindings),
    bindings,
    resolutions,
  };
}

async function resolveOne(
  entry: UnboundGitHubRepositoryResource,
  installations: readonly GitHubRepositoryBindingCandidate[],
  lookup: GitHubRepositoryBindingLookup,
): Promise<GitHubRepositoryBindingOutcome> {
  if (installations.length === 0) {
    return { status: "unbound" };
  }
  const installationIds = installations.map((installation) => installation.installationId);
  const results = await Promise.allSettled(
    installations.map(async (installation) => {
      const found = await lookup({
        installationId: installation.installationId,
        owner: entry.owner,
        name: entry.name,
      });
      return found &&
        Number.isSafeInteger(found.id) &&
        found.id > 0 &&
        installation.repositoryIds.includes(found.id)
        ? { installationId: installation.installationId, repositoryId: found.id }
        : null;
    }),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) {
    return {
      status: "unavailable",
      installationIds,
      message: failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
    };
  }
  const matches = results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );
  if (matches.length === 1) {
    return { status: "resolved", binding: matches[0]! };
  }
  if (matches.length === 0) {
    return { status: "not_allowlisted", installationIds };
  }
  return {
    status: "ambiguous",
    installationIds: matches.map((match) => match.installationId),
  };
}

/**
 * Stamp resolved GitHub App ids onto the matching bare resources of any
 * resource list (turn resources and runtime resources must agree, because the
 * credential binding id and token filename derive from the installation id).
 */
export function applyGitHubRepositoryBindings(
  resources: readonly ResourceRef[],
  bindings: ReadonlyMap<string, GitHubRepositoryBinding>,
): ResourceRef[] {
  if (bindings.size === 0) return [...resources];
  const stampable = new Set(
    unboundGitHubRepositoryResources(resources).map((entry) => entry.resource),
  );
  return resources.map((resource) => {
    if (resource.kind !== "repository" || !stampable.has(resource)) return resource;
    const binding = bindings.get(resource.uri);
    if (!binding) return resource;
    return {
      ...resource,
      provider: "github",
      githubInstallationId: binding.installationId,
      githubRepositoryId: binding.repositoryId,
    };
  });
}
