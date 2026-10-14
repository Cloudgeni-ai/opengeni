import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UpsertSitePublicationRequest, type AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { getSitePublication } from "@opengeni/db";
import * as z4 from "zod/v4";
import { ApiHttpError } from "../http/api-error";
import { contractToolInput } from "./contract-input";
import {
  requireSiteManager,
  requireSitesDomain,
  resolveSiteManagement,
  runSitePublishing,
  siteHostnameAvailability,
  sitePublicationView,
  sitePublishingError,
  upsertSitePublicationForManager,
} from "../site-publishing/service";

type JsonResult = (value: unknown) => {
  content: Array<{ type: "text"; text: string }>;
};

const SiteIdInput = z4.string().uuid().describe("The Site (published artifact) id.");

/**
 * First-party tools for publishing a Site on its own hostname. They act with
 * the agent's own authority: only a Site's managers (its owner, a workspace
 * admin, or an agent acting for one) read or change its publication, and
 * only a workspace admin changes its limits. Takedown stays with people.
 */
export function registerSitePublicationTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  authorize: () => Promise<void>,
  json: JsonResult,
): void {
  const call =
    <A>(fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      await authorize();
      try {
        return json(await runSitePublishing(() => fn(args)));
      } catch (error) {
        if (!(error instanceof ApiHttpError)) throw error;
        const envelope = {
          error: { code: error.code, message: error.message, details: error.details ?? {} },
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
          structuredContent: envelope,
          isError: true as const,
        };
      }
    };

  server.registerTool(
    "site_publication_get",
    {
      description:
        "Read how a Site is published on its own hostname: its URL, access (members, invited, public), status, embedded agent, limits, open abuse reports and usage. Returns published: false for a Site that has never been published. Only the Site's managers can use it.",
      inputSchema: { siteId: SiteIdInput },
    },
    call(async ({ siteId }: { siteId: string }) => {
      requireSitesDomain(deps.settings);
      const management = await resolveSiteManagement(deps, grant, siteId);
      requireSiteManager(management);
      const publication = await getSitePublication(deps.db, management.scope, management.record.id);
      return publication
        ? {
            published: true,
            publication: await sitePublicationView(deps, management.scope, publication),
          }
        : { published: false, siteId };
    }),
  );

  server.registerTool(
    "site_publication_update",
    {
      description:
        'Publish a Site on its own hostname (https://<label>.<sites domain>/), or change its publication. The Site must be shared with the workspace. access: members (workspace members sign in), invited (members and invitedEmails), public (anyone; may be off on this deployment). status: "unpublished" stops serving it and keeps its hostname. The embedded agent runs as the Site with its own budget. Changing limitProfile, giving the agent tools (agent.tools) or letting everyone who is not a workspace member or invited use them (agent.guestTools) needs a workspace admin. Public puts the Site on the internet; make a Site public only when the person asked for it.',
      inputSchema: contractToolInput(
        z4.object({ siteId: SiteIdInput, ...UpsertSitePublicationRequest.shape }),
      ),
    },
    call(async ({ siteId, ...rest }: { siteId: string } & Record<string, unknown>) => {
      const request = UpsertSitePublicationRequest.safeParse(rest);
      if (!request.success)
        throw sitePublishingError(
          400,
          "validation_failed",
          "site_invalid_request",
          request.error.issues
            .slice(0, 3)
            .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
            .join("; "),
        );
      // An agent started from a Site page (or acting in a turn one sent) is refused.
      const management = await resolveSiteManagement(deps, grant, siteId, { mutate: true });
      return (await upsertSitePublicationForManager(deps, grant, management, request.data))
        .publication;
    }),
  );

  server.registerTool(
    "site_hostname_check",
    {
      description:
        "Check whether a hostname label is valid and free for a Site (labels are unique across all workspaces; a released label is held for 30 days).",
      inputSchema: {
        label: z4.string().min(1).max(63).describe("Hostname label, e.g. team-crm."),
        siteId: SiteIdInput.optional().describe(
          "The Site that would use it (its own label is free).",
        ),
      },
    },
    call(async ({ label, siteId }: { label: string; siteId?: string | undefined }) => {
      requireSitesDomain(deps.settings);
      return await siteHostnameAvailability(
        deps,
        { accountId: grant.accountId, workspaceId: grant.workspaceId },
        label.toLowerCase(),
        siteId ?? null,
      );
    }),
  );
}
