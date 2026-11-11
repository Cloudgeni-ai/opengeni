import {
  resourceMountPath,
  resourceMountPathCollisionKey,
  type AccessGrant,
  type GitHubRepository,
  type RepositoryResourceRef,
} from "@opengeni/contracts";
import { hasPermission, type ApiRouteDeps } from "@opengeni/core";
import { githubRepositoryResourceRef, listWorkspaceGitHubRepositories } from "../github-access";

/**
 * A Slack task starts with at most this many repositories. Each one is a
 * shallow, blob-filtered fetch before the first command, so the set stays
 * small even when the person's new-chat form holds many.
 */
export const SLACK_SESSION_REPOSITORY_LIMIT = 5;

function githubUriKey(uri: string): string | null {
  try {
    const url = new URL(uri);
    const path = url.pathname
      .replace(/^\/+|\/+$/gu, "")
      .replace(/\.git$/iu, "")
      .toLowerCase();
    return path ? `${url.host.toLowerCase()}/${path}` : null;
  } catch {
    return null;
  }
}

function positiveRepositoryId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9]\d{0,15}$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Pick a Slack task's repositories: the repositories in the person's new-chat
 * form, in form order, that the workspace GitHub App catalog offers them.
 *
 * `form` is a selection signal only. A repository reaches the task only
 * through its current catalog entry (the same catalog and `github:use`
 * permission as the website picker), on its default branch, so a Slack task
 * never reaches a repository the person could not attach on the website today.
 * Archived and empty repositories are skipped when GitHub reported that,
 * because a clone of an empty repository has nothing to check out. Every
 * returned resource is best effort (`optional`): one failed clone warns instead
 * of failing setup.
 */
export function selectFormRepositoryResources(
  form: readonly RepositoryResourceRef[],
  catalog: readonly GitHubRepository[],
  limit = SLACK_SESSION_REPOSITORY_LIMIT,
): RepositoryResourceRef[] {
  const byId = new Map<number, GitHubRepository[]>();
  const byUri = new Map<string, GitHubRepository>();
  const ordered = [...catalog].sort(
    (left, right) => left.installationId - right.installationId || left.id - right.id,
  );
  for (const repository of ordered) {
    byId.set(repository.id, [...(byId.get(repository.id) ?? []), repository]);
    const key = githubUriKey(repository.cloneUrl);
    if (key && !byUri.has(key)) byUri.set(key, repository);
  }
  const chosen = new Set<string>();
  const mountKeys = new Set<string>();
  const resources: RepositoryResourceRef[] = [];
  for (const selected of form) {
    if (resources.length >= limit) break;
    const repositoryId = positiveRepositoryId(
      selected.githubRepositoryId ??
        (selected.provider === "github" ? selected.repositoryId : undefined),
    );
    const installationId = positiveRepositoryId(
      selected.githubInstallationId ??
        (selected.provider === "github" ? selected.installationId : undefined),
    );
    const candidates = repositoryId !== null ? (byId.get(repositoryId) ?? []) : [];
    const uriKey = githubUriKey(selected.uri);
    const match =
      candidates.find((candidate) => candidate.installationId === installationId) ??
      candidates[0] ??
      (uriKey ? byUri.get(uriKey) : undefined);
    if (!match) continue;
    const identity = `${match.installationId}:${match.id}`;
    if (chosen.has(identity)) continue;
    chosen.add(identity);
    if (match.archived === true || match.sizeKb === 0) continue;
    let resource: RepositoryResourceRef;
    try {
      resource = { ...githubRepositoryResourceRef(match), optional: true };
    } catch {
      // A malformed provider URL is one unusable repository, not a failed task.
      continue;
    }
    const mountKey = resourceMountPathCollisionKey(resourceMountPath(resource));
    if (mountKeys.has(mountKey)) continue;
    mountKeys.add(mountKey);
    resources.push(resource);
  }
  return resources;
}

/**
 * The repositories a new Slack task starts with: those in the person's
 * new-chat form for this workspace (`form`, what a new chat in the app would
 * start with now), in form order and at most five, limited to what the
 * workspace GitHub App catalog offers them now. None when the form has none.
 *
 * GitHub is asked only when the form has a repository. A GitHub outage or
 * an unconfigured App starts the task without repositories instead of failing
 * it, with a log line for diagnosis.
 */
export async function slackFormRepositoryResources(
  deps: ApiRouteDeps,
  grant: Pick<AccessGrant, "permissions">,
  workspaceId: string,
  form: readonly RepositoryResourceRef[],
): Promise<RepositoryResourceRef[]> {
  if (!hasPermission(grant.permissions, "github:use")) return [];
  if (form.length === 0) return [];
  let catalog: GitHubRepository[];
  try {
    catalog = await listWorkspaceGitHubRepositories(deps, workspaceId);
  } catch (error) {
    console.error("[slack-interactions] workspace repositories unavailable", {
      workspaceId,
      errorCode: (error instanceof Error ? error.name : "unknown")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/gu, "_")
        .slice(0, 128),
    });
    return [];
  }
  return selectFormRepositoryResources(form, catalog);
}

const OPEN_GENI_LINK_PATTERN =
  /https?:\/\/([^\s/<>|?#]+)(\/workspaces\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)/giu;

const MAX_OTHER_DEPLOYMENT_LINKS = 5;

export type OtherDeploymentLink = { url: string; host: string };

function siteOf(hostname: string): string | null {
  if (/^[\d.]+$/u.test(hostname) || hostname.includes(":")) return null;
  const labels = hostname.split(".").filter(Boolean);
  return labels.length >= 2 ? labels.slice(-2).join(".") : null;
}

/**
 * Opengeni workspace or session links in `text` that point at a sibling
 * deployment of this one (for example staging versus production).
 *
 * A sibling is a different host under the same parent domain as this
 * deployment's web origin, carrying Opengeni's own route shape. Anything else
 * is left alone: an unrelated product's URL must never be described as
 * another Opengeni.
 */
export function otherDeploymentLinks(
  text: string,
  webBaseUrl: string | null | undefined,
): OtherDeploymentLink[] {
  if (!webBaseUrl) return [];
  let own: URL;
  try {
    own = new URL(webBaseUrl);
  } catch {
    return [];
  }
  const ownSite = siteOf(own.hostname.toLowerCase());
  if (!ownSite) return [];
  const found = new Map<string, OtherDeploymentLink>();
  for (const match of text.matchAll(OPEN_GENI_LINK_PATTERN)) {
    let url: URL;
    try {
      url = new URL(`https://${match[1]}${match[2]}`);
    } catch {
      continue;
    }
    const host = url.host.toLowerCase();
    if (host === own.host.toLowerCase()) continue;
    if (siteOf(url.hostname.toLowerCase()) !== ownSite) continue;
    const canonical = `${match[0].split("://", 1)[0]!.toLowerCase()}://${host}${match[2]!.toLowerCase()}`;
    if (!found.has(canonical)) found.set(canonical, { url: canonical, host });
    if (found.size >= MAX_OTHER_DEPLOYMENT_LINKS) break;
  }
  return [...found.values()];
}

/**
 * Model context for links to another Opengeni deployment. A session id from
 * one deployment does not exist in another, so without this the agent reports
 * "Session not found or access denied" and asks for access that no grant in
 * this deployment can give.
 */
export function otherDeploymentLinkContext(
  text: string,
  webBaseUrl: string | null | undefined,
): string | null {
  const links = otherDeploymentLinks(text, webBaseUrl);
  if (links.length === 0 || !webBaseUrl) return null;
  const ownHost = new URL(webBaseUrl).host.toLowerCase();
  return [
    `Links to a different Opengeni deployment (this one is ${ownHost}):`,
    ...links.map((link) => `- ${link.url} is on ${link.host}.`),
    `Workspaces, sessions and files from another deployment do not exist here, so looking up their ids in this deployment always fails as not found. Tell the user the link is for ${[...new Set(links.map((link) => link.host))].join(" and ")}, not ${ownHost}, instead of reporting the session as missing or asking for access to it.`,
  ].join("\n");
}
