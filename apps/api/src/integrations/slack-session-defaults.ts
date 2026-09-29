import {
  resourceMountPath,
  resourceMountPathCollisionKey,
  type AccessGrant,
  type GitHubRepository,
  type RepositoryResourceRef,
} from "@opengeni/contracts";
import { listRecentSessionRepositoryResources } from "@opengeni/db";
import { hasPermission, type ApiRouteDeps } from "@opengeni/core";
import { githubRepositoryResourceRef, listWorkspaceGitHubRepositories } from "../github-access";

/**
 * A Slack task starts with at most this many repositories. Each one is a
 * shallow, blob-filtered fetch before the first command, so the set stays
 * small: the person's own most recently used repositories, not a catalog.
 */
export const SLACK_SESSION_RECENT_REPOSITORY_LIMIT = 5;

/** How far back the person's own sessions count as recent use. */
export const SLACK_SESSION_RECENT_REPOSITORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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
 * Pick a Slack task's repositories: the person's recently used repositories,
 * in recency order, that the workspace GitHub App catalog still offers them.
 *
 * `recent` is a usage signal only, and only repositories the person attached
 * themselves count: an automatically attached (`optional`) one never does. A
 * repository reaches the task only through its current catalog entry (the
 * same catalog and `github:use` permission as the website picker), on its
 * default branch, so a Slack task never reaches a repository the person could
 * not attach on the website today. Archived and
 * empty repositories are skipped when GitHub reported that, because a clone of
 * an empty repository has nothing to check out. Every returned resource is
 * best effort (`optional`): one failed clone warns instead of failing setup.
 */
export function selectRecentRepositoryResources(
  recent: readonly RepositoryResourceRef[],
  catalog: readonly GitHubRepository[],
  limit = SLACK_SESSION_RECENT_REPOSITORY_LIMIT,
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
  for (const used of recent) {
    if (resources.length >= limit) break;
    // A repository OpenGeni attached automatically is not a choice the person
    // made; counting it would keep re-attaching it to every later Slack task.
    if (used.optional === true) continue;
    const repositoryId = positiveRepositoryId(
      used.githubRepositoryId ?? (used.provider === "github" ? used.repositoryId : undefined),
    );
    const installationId = positiveRepositoryId(
      used.githubInstallationId ?? (used.provider === "github" ? used.installationId : undefined),
    );
    const candidates = repositoryId !== null ? (byId.get(repositoryId) ?? []) : [];
    const uriKey = githubUriKey(used.uri);
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
 * The repositories a new Slack task starts with: the person's own recently
 * used repositories in this workspace (their own top-level sessions active in
 * the last 30 days, most recent first, at most five), limited to what the
 * workspace GitHub App catalog offers them now. None when they have none; the
 * agent can still find and clone repositories through its GitHub tools.
 *
 * GitHub is asked only when there is something to look up. A GitHub outage or
 * an unconfigured App starts the task without repositories instead of failing
 * it, with a log line for diagnosis.
 */
export async function slackRecentRepositoryResources(
  deps: ApiRouteDeps,
  grant: Pick<AccessGrant, "permissions" | "subjectId">,
  workspaceId: string,
  now: Date = new Date(),
): Promise<RepositoryResourceRef[]> {
  if (!hasPermission(grant.permissions, "github:use")) return [];
  const recent = await listRecentSessionRepositoryResources(deps.db, {
    workspaceId,
    subjectId: grant.subjectId,
    since: new Date(now.getTime() - SLACK_SESSION_RECENT_REPOSITORY_WINDOW_MS),
  });
  if (!recent.some((resource) => resource.optional !== true)) return [];
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
  return selectRecentRepositoryResources(recent, catalog);
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
 * OpenGeni workspace or session links in `text` that point at a sibling
 * deployment of this one (for example staging versus production).
 *
 * A sibling is a different host under the same parent domain as this
 * deployment's web origin, carrying OpenGeni's own route shape. Anything else
 * is left alone: an unrelated product's URL must never be described as
 * another OpenGeni.
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
 * Model context for links to another OpenGeni deployment. A session id from
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
    `Links to a different OpenGeni deployment (this one is ${ownHost}):`,
    ...links.map((link) => `- ${link.url} is on ${link.host}.`),
    `Workspaces, sessions and files from another deployment do not exist here, so looking up their ids in this deployment always fails as not found. Tell the user the link is for ${[...new Set(links.map((link) => link.host))].join(" and ")}, not ${ownHost}, instead of reporting the session as missing or asking for access to it.`,
  ].join("\n");
}
