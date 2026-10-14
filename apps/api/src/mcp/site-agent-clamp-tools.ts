import type { AccessGrant } from "@opengeni/contracts";
import {
  SITE_AGENT_COMPUTE_MESSAGE,
  siteAgentClamp,
  siteClampedAgentMessage,
  type ApiRouteDeps,
  type SiteClampedResource,
} from "@opengeni/core";

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
