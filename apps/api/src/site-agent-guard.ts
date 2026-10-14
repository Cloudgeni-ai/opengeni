import {
  requireAccessGrant,
  siteAgentClamp,
  siteClampedAgentMessage,
  type ApiRouteDeps,
  type SiteClampedResource,
} from "@opengeni/core";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireSiteAgentMayChangeArtifact } from "./site-publishing/service";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Workspace route families a Site-clamped agent may not change, by first path segment. */
const CLAMPED_SEGMENTS: ReadonlyMap<string, SiteClampedResource> = new Map([
  ["instruction-policies", "workspace instructions"],
  ["agent-learning", "workspace instructions"],
  ["learning", "workspace instructions"],
  ["skills", "Skills"],
  ["plugins", "Skills"],
  ["knowledge", "Knowledge"],
  ["vaults", "secrets"],
  ["credential-provider", "secrets"],
  ["api-keys", "secrets"],
  ["members", "workspace members, connections or settings"],
  ["external-members", "workspace members, connections or settings"],
  ["connections", "workspace members, connections or settings"],
  ["integrations", "workspace members, connections or settings"],
  ["capabilities", "workspace members, connections or settings"],
  ["site-auth-connections", "workspace members, connections or settings"],
  ["settings", "workspace members, connections or settings"],
  ["model-policy", "workspace members, connections or settings"],
  ["model-account-settings", "workspace members, connections or settings"],
  ["session-mcp-tool-permissions", "workspace members, connections or settings"],
  ["webhooks", "workspace members, connections or settings"],
  ["network-routes", "workspace members, connections or settings"],
  ["browser-identities", "secrets"],
  ["company-profile", "the organization profile"],
  ["enrollments", "Connected Machines"],
  ["machines", "Connected Machines"],
  ["rigs", "sandbox environments"],
  ["default-rig", "sandbox environments"],
]);

/** Writes to the workspace itself (`PATCH` or `DELETE /v1/workspaces/:id`). */
const WORKSPACE_ROOT = /^\/v1\/workspaces\/[^/]+\/?$/u;

/**
 * Changes to a Site's content: a Site-started agent may make them only to
 * a Site no publication serves, or to a Site it was started from
 * (`requireSiteAgentMayChangeArtifact`).
 */
const SITE_CONTENT_CHANGE =
  /^\/v1\/workspaces\/[^/]+\/published-artifacts\/([0-9a-f-]{36})\/(?:versions|rollback|status|visibility)\/?$/iu;

/** Writes under a clamped family that only read (searches and dry runs). */
const READ_ONLY_WRITES = [
  /^\/v1\/workspaces\/[^/]+\/knowledge\/search$/u,
  /^\/v1\/workspaces\/[^/]+\/knowledge\/entries\/search$/u,
  /^\/v1\/workspaces\/[^/]+\/knowledge\/entries\/prepare-save$/u,
  /^\/v1\/workspaces\/[^/]+\/knowledge\/entries\/[^/]+\/file\/download-url$/u,
  /^\/v1\/workspaces\/[^/]+\/machines\/[^/]+\/audience\/preview$/u,
];

/**
 * Server-side boundary for agents started from a Site page (a published
 * Site, or a console frame), on every workspace route family that changes
 * what the workspace knows or can reach: the workspace itself, workspace
 * instructions and learning settings, Skills and plugins, Knowledge, vaults
 * and other credentials, members, connections, integrations, webhooks,
 * network routes and settings, the organization profile, Connected Machines
 * and sandbox environments. Such an agent acts with the page's reach, so it
 * does not learn and cannot widen anyone's access; a write from it is
 * refused with 403 before the route runs. It also changes a published Site's
 * content only for a Site it was started from. Reads are unaffected, and so
 * is every caller that is not a Site-clamped agent. The first-party tools
 * that write the same things (`knowledge_save`, `instruction_policy_save`,
 * `secret_save`, `skill_save`, `company_profile_propose`, the Connected
 * Machine and sandbox environment tools, the artifact tools and their
 * siblings) check the same clamp themselves.
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
    const segment = /^\/v1\/workspaces\/[^/]+\/([^/]+)/u.exec(path)?.[1] ?? "";
    const what: SiteClampedResource | undefined = WORKSPACE_ROOT.test(path)
      ? "workspace members, connections or settings"
      : CLAMPED_SEGMENTS.get(segment);
    const siteContent = SITE_CONTENT_CHANGE.exec(path)?.[1]?.toLowerCase() ?? null;
    if ((!what && !siteContent) || READ_ONLY_WRITES.some((pattern) => pattern.test(path))) {
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
    if (clamp?.clamped && what)
      throw new HTTPException(403, { message: siteClampedAgentMessage(what) });
    await next();
  };
}
