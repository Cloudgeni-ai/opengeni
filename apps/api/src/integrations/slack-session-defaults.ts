import {
  resourceMountPath,
  resourceMountPathCollisionKey,
  type AccessGrant,
  type GitHubRepository,
  type McpConnectionAccountBinding,
  type McpPersonalConnectionDelegation,
  type RepositoryResourceRef,
  type ResourceRef,
  type SessionToolPolicy,
  type ToolRef,
} from "@opengeni/contracts";
import type { McpServerConfig } from "@opengeni/config";
import {
  getRig,
  getSessionFirstTurnConnectionAuthority,
  getWorkspace,
  listRecentSessionRepositoryResources,
} from "@opengeni/db";
import {
  hasPermission,
  resolveSessionToolPolicy,
  settingsWithEnabledCapabilityMcpServers,
  workspaceSessionToolPolicyDefaultServerIdsFor,
  type ApiRouteDeps,
} from "@opengeni/core";
import { githubRepositoryResourceRef, listWorkspaceGitHubRepositories } from "../github-access";
import { escapeSlackMrkdwn } from "./slack-app-home";

/**
 * A Slack task starts with at most this many repositories. Each one is a
 * shallow, blob-filtered fetch before the first command, so the set stays
 * small: the person's own most recently used repositories, not a catalog.
 */
export const SLACK_SESSION_RECENT_REPOSITORY_LIMIT = 5;

/** How far back the person's own sessions count as recent use. */
export const SLACK_SESSION_RECENT_REPOSITORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Connectors every session carries; naming them in Slack is noise. */
const ALWAYS_ATTACHED_SERVER_IDS: ReadonlySet<string> = new Set(["opengeni", "files", "docs"]);

const MAX_NAMED_ITEMS = 5;
const MAX_NAME_CHARS = 48;
/** UTF-8 bytes. The column allows 1024; stay well inside it. */
const MAX_LINE_BYTES = 480;

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
 * it, with a log line so the acknowledgement's "repos: none" is explainable.
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

export type SlackSessionDefaultsSummary = {
  /** Connector display names, excluding the ones every session carries. */
  connectors: readonly string[];
  /** Repository labels (`name`, or `owner/name` when names collide). */
  repositories: readonly string[];
  /** Sandbox Environment name, or null when the session has none. */
  environment: string | null;
};

/** One display name on one line, cut at a code point boundary. */
function boundedName(value: string): string {
  const points = Array.from(value.replace(/\s+/gu, " ").trim());
  return points.length > MAX_NAME_CHARS
    ? `${points.slice(0, MAX_NAME_CHARS - 1).join("")}…`
    : points.join("");
}

/**
 * Cut an escaped line to the byte budget at a code point boundary, never
 * inside an escaped entity such as `&amp;`.
 */
function boundedLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= MAX_LINE_BYTES) return line;
  const budget = MAX_LINE_BYTES - Buffer.byteLength("…", "utf8");
  let kept = "";
  let bytes = 0;
  for (const point of line) {
    const size = Buffer.byteLength(point, "utf8");
    if (bytes + size > budget) break;
    kept += point;
    bytes += size;
  }
  return `${kept.replace(/&[a-z]*$/u, "")}…`;
}

function namedList(values: readonly string[]): string {
  if (values.length === 0) return "none";
  const shown = values
    .slice(0, MAX_NAMED_ITEMS)
    .map((value) => escapeSlackMrkdwn(boundedName(value)));
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/**
 * The one acknowledgement line naming what a Slack task started with.
 * Pure, bounded and Slack-escaped, so the frozen bytes are safe to post.
 */
export function renderSlackSessionDefaultsLine(summary: SlackSessionDefaultsSummary): string {
  const segments = [
    `connectors: ${namedList(summary.connectors)}`,
    `repos: ${namedList(summary.repositories)}`,
    ...(summary.environment
      ? [`environment: ${escapeSlackMrkdwn(boundedName(summary.environment))}`]
      : []),
  ];
  return boundedLine(`Using ${segments.join("; ")}.`);
}

function repositoryLabels(resources: readonly ResourceRef[]): string[] {
  const paths = resources.flatMap((resource) => {
    if (resource.kind !== "repository") return [];
    try {
      const segments = new URL(resource.uri).pathname
        .replace(/^\/+|\/+$/gu, "")
        .replace(/\.git$/u, "")
        .split("/")
        .filter(Boolean);
      return segments.length > 0 ? [segments] : [];
    } catch {
      return [];
    }
  });
  const nameCounts = new Map<string, number>();
  for (const segments of paths) {
    const name = segments.at(-1)!;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  return paths.map((segments) => {
    const name = segments.at(-1)!;
    return boundedName((nameCounts.get(name) ?? 0) > 1 ? segments.join("/") : name);
  });
}

export type SlackSessionConnectionAuthority = {
  mcpAccountBindings: readonly McpConnectionAccountBinding[] | null;
  personalConnectionDelegations: readonly McpPersonalConnectionDelegation[];
} | null;

/**
 * Whether the first accepted turn's frozen connection authority can reach a
 * connector. A connector without a connection reference needs no account. One
 * with a reference is reachable only through an account frozen on that turn:
 * a workspace connection or the person's own personal connection. A
 * personal-only connector the person never connected, or one only another
 * member connected, is therefore left out of the line.
 */
export function slackConnectorReachable(
  server: Pick<McpServerConfig, "id" | "connectionRef">,
  authority: SlackSessionConnectionAuthority,
): boolean {
  const ref = server.connectionRef;
  if (!ref) return true;
  if (ref.authoritySource === "host" || !authority) return false;
  if (authority.mcpAccountBindings?.some((binding) => binding.canonicalServerId === server.id)) {
    return true;
  }
  if (
    authority.personalConnectionDelegations.some(
      (delegation) => (delegation.canonicalServerId ?? delegation.serverId) === server.id,
    )
  ) {
    return true;
  }
  // A turn from before per-account bindings resolves an exact workspace
  // reference directly; a personal one always needs a frozen delegation.
  return (
    authority.mcpAccountBindings === null && ref.subjectScope !== "subject" && !!ref.connectionId
  );
}

/**
 * Summarize a just-created Slack session from its durable rows: the connectors
 * its tool policy resolves to today that its first turn's frozen connection
 * authority can reach, its repositories, and its Sandbox Environment. The same
 * resolver the worker and the website use decides the connectors, so the line
 * never claims a connector the session cannot reach.
 */
export async function summarizeSlackSessionDefaults(
  deps: ApiRouteDeps,
  grant: Pick<AccessGrant, "accountId" | "subjectId">,
  workspaceId: string,
  session: {
    id: string;
    toolPolicy: SessionToolPolicy;
    tools: ToolRef[];
    resources: ResourceRef[];
    rigId?: string | null;
  },
): Promise<SlackSessionDefaultsSummary> {
  const [runtime, workspace, rig, authority] = await Promise.all([
    settingsWithEnabledCapabilityMcpServers(deps.db, workspaceId, deps.settings, {
      subjectId: grant.subjectId,
    }),
    getWorkspace(deps.db, workspaceId),
    session.rigId
      ? getRig(
          deps.db,
          { accountId: grant.accountId, workspaceId, subjectId: grant.subjectId },
          session.rigId,
        )
      : Promise.resolve(null),
    getSessionFirstTurnConnectionAuthority(deps.db, workspaceId, session.id),
  ]);
  const resolved = resolveSessionToolPolicy({
    toolPolicy: session.toolPolicy,
    sessionTools: session.tools,
    availableMcpServerIds: runtime.mcpServers.map((server) => server.id),
    defaultMcpServerIds: workspaceSessionToolPolicyDefaultServerIdsFor(
      runtime.mcpServers,
      workspace?.settings,
    ),
  });
  const servers = new Map(runtime.mcpServers.map((server) => [server.id, server]));
  const connectors = [
    ...new Set(
      resolved.toolRefs
        .filter((tool) => {
          if (ALWAYS_ATTACHED_SERVER_IDS.has(tool.id)) return false;
          const server = servers.get(tool.id);
          return server ? slackConnectorReachable(server, authority) : true;
        })
        .map((tool) => boundedName(servers.get(tool.id)?.name ?? tool.id)),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return {
    connectors,
    repositories: repositoryLabels(session.resources),
    environment: rig?.name ?? null,
  };
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
