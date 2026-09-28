import {
  resourceMountPath,
  resourceMountPathCollisionKey,
  type AccessGrant,
  type RepositoryResourceRef,
  type ResourceRef,
  type SessionToolPolicy,
  type ToolRef,
} from "@opengeni/contracts";
import { getRig, getWorkspace } from "@opengeni/db";
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
 * A Slack task starts with the workspace's GitHub App repositories. Clones are
 * shallow and blob-filtered, but every repository is still one fetch before
 * the first command, so a workspace that granted the App a very large
 * selection gets the first ones by name rather than all of them.
 */
export const SLACK_SESSION_DEFAULT_REPOSITORY_LIMIT = 20;

/** Connectors every session carries; naming them in Slack is noise. */
const ALWAYS_ATTACHED_SERVER_IDS: ReadonlySet<string> = new Set(["opengeni", "files", "docs"]);

const MAX_NAMED_ITEMS = 5;
const MAX_NAME_CHARS = 48;
/** UTF-8 bytes. The column allows 1024; stay well inside it. */
const MAX_LINE_BYTES = 480;

/**
 * The workspace GitHub App repositories a Slack task starts with.
 *
 * This is the same catalog the website offers (`GET /github/repositories`),
 * gated by the same `github:use` permission, so a Slack task never reaches a
 * repository the person could not attach on the website. Every returned
 * resource is revalidated against the workspace's installation grant when
 * the session is created.
 *
 * A GitHub outage or an unconfigured App starts the task without
 * repositories instead of failing it; the acknowledgement then says so.
 */
export async function slackWorkspaceRepositoryResources(
  deps: ApiRouteDeps,
  grant: Pick<AccessGrant, "permissions">,
  workspaceId: string,
): Promise<RepositoryResourceRef[]> {
  if (!hasPermission(grant.permissions, "github:use")) return [];
  let repositories: Awaited<ReturnType<typeof listWorkspaceGitHubRepositories>>;
  try {
    repositories = await listWorkspaceGitHubRepositories(deps, workspaceId);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const resources: RepositoryResourceRef[] = [];
  for (const repository of [...repositories].sort(
    (left, right) =>
      left.fullName.localeCompare(right.fullName) ||
      left.installationId - right.installationId ||
      left.id - right.id,
  )) {
    if (resources.length >= SLACK_SESSION_DEFAULT_REPOSITORY_LIMIT) break;
    let resource: RepositoryResourceRef;
    try {
      resource = githubRepositoryResourceRef(repository);
    } catch {
      // A malformed provider URL is one unusable repository, not a failed task.
      continue;
    }
    const key = resourceMountPathCollisionKey(resourceMountPath(resource));
    if (seen.has(key)) continue;
    seen.add(key);
    resources.push(resource);
  }
  return resources;
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

/**
 * Summarize a just-created Slack session from its durable row: the connectors
 * its tool policy resolves to today, its repositories, and its Sandbox
 * Environment. The same resolver the worker and the website use decides the
 * connectors, so the line never claims a connector the session cannot reach.
 */
export async function summarizeSlackSessionDefaults(
  deps: ApiRouteDeps,
  grant: Pick<AccessGrant, "accountId" | "subjectId">,
  workspaceId: string,
  session: {
    toolPolicy: SessionToolPolicy;
    tools: ToolRef[];
    resources: ResourceRef[];
    rigId?: string | null;
  },
): Promise<SlackSessionDefaultsSummary> {
  const [runtime, workspace, rig] = await Promise.all([
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
  const names = new Map(runtime.mcpServers.map((server) => [server.id, server.name ?? server.id]));
  const connectors = [
    ...new Set(
      resolved.toolRefs
        .filter((tool) => !ALWAYS_ATTACHED_SERVER_IDS.has(tool.id))
        .map((tool) => boundedName(names.get(tool.id) ?? tool.id)),
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
