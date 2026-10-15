import {
  requireAccessGrant,
  siteAgentClamp,
  siteClampedAgentMessage,
  type ApiRouteDeps,
  type SiteClampedResource,
} from "@opengeni/core";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  SITE_AGENT_EDITABLE_ARTIFACT_RESOURCE,
  siteAgentMayEditArtifacts,
} from "./mcp/site-agent-clamp-tools";
import { requireSiteAgentMayChangeArtifact, sitePublishingError } from "./site-publishing/service";

/** Document, spreadsheet and presentation writes: open only when the Site declares them. */
const EDITABLE_ARTIFACT_WRITES = /^\/editable-artifacts(?:\/.*)?$/u;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A workspace route's path after `/v1/workspaces/:workspaceId` ("" for the workspace itself). */
const WORKSPACE_PATH = /^\/v1\/workspaces\/[^/]+(\/.*)?$/u;

/** Session routes a Site-started agent works in: `/sessions/:sessionId/<operation>`. */
const SESSION_WORK = [
  "events",
  "steer",
  "control",
  "queue",
  "composer-draft",
  "retry",
  "context",
  "goal",
  "artifacts",
  "fs",
  "git",
  "terminal",
  "background-commands",
  "archive",
].join("|");

/**
 * The only writes (any method but `GET`, `HEAD` and `OPTIONS`) a
 * Site-started agent may send under `/v1/workspaces/:workspaceId`, matched
 * on the path after the workspace id. Every other write is refused, so a
 * route family added later starts closed to it.
 */
export const SITE_AGENT_WRITES: readonly RegExp[] = [
  // Its tools: the first-party MCP endpoint and its docs and files servers,
  // Codemode (whose SDK proxy forwards each request back through this guard)
  // and the tool gateway. Each tool checks the clamp itself.
  /^\/mcp(?:\/docs|\/files)?\/?$/u,
  /^\/codemode\/(?:calls\/?|sdk\/.*)$/u,
  /^\/tools\/(?:calls|invoke|resolve|manifest)\/?$/u,
  // Conversations: starting one (it becomes a child of the agent's own
  // session, and so stays clamped), renaming or deleting one it reaches, and
  // working in one. A session's agent, tools, servers, credentials, variable
  // sets, vaults, Skills, usage limit, model accounts, admin access, sandbox,
  // visibility and channel stay closed.
  /^\/sessions\/?$/u,
  /^\/sessions\/[^/]+\/?$/u,
  new RegExp(`^/sessions/[^/]+/(?:${SESSION_WORK})(?:/.*)?$`, "u"),
  // Files and content. Site Data and a Site's files keep their own clamp
  // (only the Site the agent was started from); a Site's versions, rollback,
  // status and audience follow `requireSiteAgentMayChangeArtifact`.
  /^\/files\/(?:uploads|uploads\/[^/]+\/complete|[^/]+\/download-url)\/?$/u,
  /^\/artifacts\/[^/]+\/playback-source\/?$/u,
  /^\/published-artifacts(?:\/uploads)?\/?$/u,
  /^\/published-artifacts\/[^/]+\/(?:data|files)(?:\/.*)?$/u,
  // Reads sent as POST: searches, download links and a dry run.
  /^\/knowledge\/(?:search|entries\/search|entries\/prepare-save|entries\/[^/]+\/file\/download-url)\/?$/u,
  /^\/company-brain\/knowledge\/(?:browse|search)\/?$/u,
  /^\/document-bases\/[^/]+\/search\/?$/u,
  /^\/documents\/[^/]+\/original-file\/download-url\/?$/u,
  /^\/machines\/[^/]+\/audience\/preview\/?$/u,
  /^\/feedback\/?$/u,
];

/**
 * Writes open to a Site-started agent for one method only, where the same
 * path also manages something. A Site's named query runs with `POST`
 * (exactly what its page may call, under the query's audience; Site SQL's
 * own clamp limits it to the Site the agent was started from), while `PUT`
 * and `DELETE` on that path define and delete the query and stay closed, as
 * does every other Site SQL route (settings, migrations, ad hoc statements,
 * import and reset).
 */
export const SITE_AGENT_METHOD_WRITES: readonly { method: string; pattern: RegExp }[] = [
  { method: "POST", pattern: /^\/published-artifacts\/[^/]+\/sql\/queries\/[^/]+\/?$/u },
];

/** A published Site's content: versions, rollback, status and audience. */
const SITE_CONTENT_CHANGE =
  /^\/published-artifacts\/([0-9a-f-]{36})\/(?:versions|rollback|status|visibility)\/?$/iu;

/** Route families that are Site publications (refused with `site_agent_forbidden`). */
const SITE_PUBLICATION_FAMILIES = new Set(["published-artifacts", "site-limit-profile"]);

const SETTINGS = "workspace members, connections or settings" satisfies SiteClampedResource;

/** What a refusal names, by first path segment; anything else is "workspace settings". */
const RESOURCES: ReadonlyMap<string, SiteClampedResource> = new Map([
  ["scheduled-tasks", "schedules"],
  ["automations", "automations"],
  ["instruction-policies", "workspace instructions"],
  ["agent-learning", "workspace instructions"],
  ["learning", "workspace instructions"],
  ["preferences", "workspace instructions"],
  ["skills", "Skills"],
  ["plugins", "Skills"],
  ["knowledge", "Knowledge"],
  ["company-brain", "Knowledge"],
  ["documents", "Knowledge"],
  ["document-bases", "Knowledge"],
  ["document-default-collection-backfills", "Knowledge"],
  ["vaults", "secrets"],
  ["credential-provider", "secrets"],
  ["api-keys", "secrets"],
  ["browser-identities", "secrets"],
  ["variable-sets", "secrets"],
  ["members", SETTINGS],
  ["external-members", SETTINGS],
  ["access", SETTINGS],
  ["allowance", SETTINGS],
  ["user-resource-authorities", SETTINGS],
  ["connections", SETTINGS],
  ["connect", SETTINGS],
  ["integrations", SETTINGS],
  ["inherited-integrations", SETTINGS],
  ["identity-links", SETTINGS],
  ["capabilities", SETTINGS],
  ["mcp", SETTINGS],
  ["github", SETTINGS],
  ["social", SETTINGS],
  ["channels", SETTINGS],
  ["site-auth-connections", SETTINGS],
  ["settings", SETTINGS],
  ["model-policy", SETTINGS],
  ["model-account-settings", SETTINGS],
  ["session-mcp-tool-permissions", SETTINGS],
  ["webhooks", SETTINGS],
  ["network-routes", SETTINGS],
  ["company-profile", "the organization profile"],
  ["enrollments", "Connected Machines"],
  ["machines", "Connected Machines"],
  ["rigs", "sandbox environments"],
  ["default-rig", "sandbox environments"],
  ["environments", "sandbox environments"],
  ["sandbox-images", "sandbox environments"],
  // Browsers and screens, the viewer's own Chrome and machines among them.
  ["browser-sessions", "browser or computer sessions"],
  ["computer-sessions", "browser or computer sessions"],
  ["attached-browsers", "browser or computer sessions"],
  ["interaction-interventions", "browser or computer sessions"],
]);

/** The path after the workspace id, or null when `path` is not a workspace route. */
function workspaceRoute(path: string): string | null {
  const match = WORKSPACE_PATH.exec(path);
  return match ? (match[1] ?? "") : null;
}

/**
 * Whether a Site-started agent may send a `method` write to `path` (before
 * the Site content rule). Without a method only the path-wide allowlist
 * applies.
 */
export function siteAgentMayWrite(path: string, method?: string): boolean {
  const route = workspaceRoute(path);
  if (route === null) return false;
  if (SITE_AGENT_WRITES.some((pattern) => pattern.test(route))) return true;
  const upper = method?.toUpperCase();
  return SITE_AGENT_METHOD_WRITES.some(
    (entry) => entry.method === upper && entry.pattern.test(route),
  );
}

/** What a refused write to `path` names. */
export function siteAgentWriteResource(path: string): SiteClampedResource {
  const route = workspaceRoute(path) ?? "";
  const segment = route.split("/")[1] ?? "";
  if (segment === "") return SETTINGS;
  if (SITE_PUBLICATION_FAMILIES.has(segment)) return "Site publications";
  return RESOURCES.get(segment) ?? "workspace settings";
}

/**
 * Server-side boundary for agents started from a Site page (a published
 * Site, or a console frame). Such an agent acts with the page's reach: it
 * does not learn and cannot widen anyone's access. Under
 * `/v1/workspaces/:workspaceId` it may send only the writes in
 * `SITE_AGENT_WRITES` (its tools, its conversations, files and content, and
 * reads sent as POST) and `SITE_AGENT_METHOD_WRITES` (running a Site's named
 * SQL queries); any other write, including `PATCH` or `DELETE` on the
 * workspace itself and browser or computer sessions (which can drive the
 * viewer's Chrome or screen), is refused with 403 before the route runs. It also
 * changes a published Site's content only for a Site it was started from.
 * Reads are unaffected, and so is every caller that is not a Site-clamped
 * agent. The first-party tools that write workspace state (`knowledge_save`,
 * `instruction_policy_save`, `secret_save`, `skill_save`,
 * `company_profile_propose`, the Connected Machine, sandbox environment and
 * fleet tools (`run_on`, `sandbox_attach`, `sandbox_swap`,
 * `sandbox_provision`), the artifact tools and their siblings) check the
 * same clamp themselves.
 *
 * Paths are matched as Hono routes them (`c.req.path`, percent-decoded), so
 * an encoded segment cannot reach a route this guard did not recognize.
 */
export function siteClampedAgentGuard(deps: ApiRouteDeps) {
  return async (c: Context, next: Next) => {
    if (READ_METHODS.has(c.req.method)) {
      await next();
      return;
    }
    const path = c.req.path;
    const siteContent =
      SITE_CONTENT_CHANGE.exec(workspaceRoute(path) ?? "")?.[1]?.toLowerCase() ?? null;
    if (!siteContent && siteAgentMayWrite(path, c.req.method)) {
      await next();
      return;
    }
    // The route authenticates again (from the request's access cache) and
    // answers a request that cannot be authorized with its own error.
    const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId") ?? "").catch(
      () => null,
    );
    if (!grant) {
      await next();
      return;
    }
    if (siteContent) {
      await requireSiteAgentMayChangeArtifact(deps, grant, siteContent);
      await next();
      return;
    }
    const clamp = await siteAgentClamp(deps.db, grant);
    if (clamp?.clamped && EDITABLE_ARTIFACT_WRITES.test(workspaceRoute(path) ?? "")) {
      if (await siteAgentMayEditArtifacts(deps, grant, clamp)) {
        await next();
        return;
      }
      throw new HTTPException(403, {
        message: siteClampedAgentMessage(SITE_AGENT_EDITABLE_ARTIFACT_RESOURCE),
      });
    }
    if (clamp?.clamped) {
      const what = siteAgentWriteResource(path);
      if (what === "Site publications")
        throw sitePublishingError(
          403,
          "forbidden",
          "site_agent_forbidden",
          "An agent started from a Site page cannot change Site publications",
        );
      throw new HTTPException(403, { message: siteClampedAgentMessage(what) });
    }
    await next();
  };
}
