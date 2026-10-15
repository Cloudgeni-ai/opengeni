import type { AccessGrant } from "@opengeni/contracts";
import {
  SITE_AGENT_COMPUTE_MESSAGE,
  siteAgentClamp,
  siteClampedAgentMessage,
  type ApiRouteDeps,
  type SiteAgentClamp,
  type SiteClampedResource,
} from "@opengeni/core";
import { getPublishedSite, getPublishedSiteVersion } from "@opengeni/db";

/** A refused write by an agent started from a Site page, as first-party tools return it. */
export function siteAgentClampedToolResult(message: string) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code: "site_agent_clamped", message } }),
      },
    ],
  };
}

export type SiteAgentClampedToolResult = ReturnType<typeof siteAgentClampedToolResult>;

/**
 * Null, or the refusal when `grant` is an agent started from a Site page
 * (the Site clamp): such an agent cannot create or change `what`.
 */
export async function siteAgentClampRefusal(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
  what: SiteClampedResource,
): Promise<SiteAgentClampedToolResult | null> {
  return (await siteAgentClamp(deps.db, grant))?.clamped
    ? siteAgentClampedToolResult(siteClampedAgentMessage(what))
    : null;
}

/**
 * Null, or the refusal when `grant` is an agent started from a Site page:
 * such an agent cannot run on, attach, swap or provision sandboxes or
 * Connected Machines (the viewer's machines among them).
 */
export async function siteAgentComputeRefusal(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
): Promise<SiteAgentClampedToolResult | null> {
  return (await siteAgentClamp(deps.db, grant))?.clamped
    ? siteAgentClampedToolResult(SITE_AGENT_COMPUTE_MESSAGE)
    : null;
}

/** The first-party tools that write documents, spreadsheets and presentations. */
export const SITE_AGENT_EDITABLE_ARTIFACT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "editable_artifact_create",
  "editable_artifact_import",
  "editable_artifact_apply",
]);

export const SITE_AGENT_EDITABLE_ARTIFACT_RESOURCE =
  "documents, spreadsheets or presentations the Site did not declare" as const;

/**
 * Whether a Site-clamped agent may write documents, spreadsheets and
 * presentations: only when a published Site it was started from declares a
 * first-party editing tool (`editable_artifact_create`, `_import` or
 * `_apply`) in its current version's requested tools. Console frames (no
 * published Site) and Sites that declare none may not; a read that fails
 * refuses.
 */
export async function siteAgentMayEditArtifacts(
  deps: Pick<ApiRouteDeps, "db">,
  grant: Pick<AccessGrant, "accountId" | "workspaceId">,
  clamp: SiteAgentClamp,
): Promise<boolean> {
  if (!clamp.clamped) return true;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  for (const siteId of clamp.originSiteIds) {
    const site = await getPublishedSite(deps.db, scope, siteId).catch(() => null);
    if (!site?.currentVersionId) continue;
    const version = await getPublishedSiteVersion(
      deps.db,
      scope,
      siteId,
      site.currentVersionId,
    ).catch(() => null);
    if (
      version?.requestedTools.some(
        (tool) =>
          tool.serverId === "opengeni" && SITE_AGENT_EDITABLE_ARTIFACT_WRITE_TOOLS.has(tool.toolName),
      )
    )
      return true;
  }
  return false;
}

/** Null, or the refusal of an undeclared document, spreadsheet or presentation write. */
export async function siteAgentEditableArtifactRefusal(
  deps: Pick<ApiRouteDeps, "db">,
  grant: AccessGrant,
): Promise<SiteAgentClampedToolResult | null> {
  const clamp = await siteAgentClamp(deps.db, grant);
  if (!clamp?.clamped || (await siteAgentMayEditArtifacts(deps, grant, clamp))) return null;
  return siteAgentClampedToolResult(siteClampedAgentMessage(SITE_AGENT_EDITABLE_ARTIFACT_RESOURCE));
}
