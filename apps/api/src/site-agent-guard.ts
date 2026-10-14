import {
  requireAccessGrant,
  siteAgentClamp,
  siteClampedAgentMessage,
  type ApiRouteDeps,
  type SiteClampedResource,
} from "@opengeni/core";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";

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
]);

/** Writes under a clamped family that only read (searches and dry runs). */
const READ_ONLY_WRITES = [
  /^\/v1\/workspaces\/[^/]+\/knowledge\/search$/u,
  /^\/v1\/workspaces\/[^/]+\/knowledge\/entries\/search$/u,
  /^\/v1\/workspaces\/[^/]+\/knowledge\/entries\/prepare-save$/u,
  /^\/v1\/workspaces\/[^/]+\/knowledge\/entries\/[^/]+\/file\/download-url$/u,
];

/**
 * Server-side boundary for agents started from a Site page (a published
 * Site, or a console frame), on every workspace route family that changes
 * what the workspace knows or can reach: workspace instructions and
 * learning settings, Skills and plugins, Knowledge, vaults and other
 * credentials, members, connections, integrations and settings. Such an
 * agent acts with the page's reach, so it does not learn and cannot widen
 * anyone's access; a write from it is refused with 403 before the route
 * runs. Reads are unaffected, and so is every caller that is not a
 * Site-clamped agent. The first-party tools that write the same things
 * (`knowledge_save`, `instruction_policy_save`, `secret_save`, `skill_save`
 * and their siblings) check the same clamp themselves.
 */
export function siteClampedAgentGuard(deps: ApiRouteDeps) {
  return async (c: Context, next: Next) => {
    if (READ_METHODS.has(c.req.method)) {
      await next();
      return;
    }
    const pathname = new URL(c.req.url).pathname;
    const segment = /^\/v1\/workspaces\/[^/]+\/([^/]+)/u.exec(pathname)?.[1] ?? "";
    const what = CLAMPED_SEGMENTS.get(segment);
    if (!what || READ_ONLY_WRITES.some((pattern) => pattern.test(pathname))) {
      await next();
      return;
    }
    // The route authenticates again (from the request's access cache) and
    // answers a request that cannot be authorized with its own error.
    const grant = await requireAccessGrant(c, deps, c.req.param("workspaceId") ?? "").catch(
      () => null,
    );
    const clamp = grant ? await siteAgentClamp(deps.db, grant) : null;
    if (clamp?.clamped) throw new HTTPException(403, { message: siteClampedAgentMessage(what) });
    await next();
  };
}
