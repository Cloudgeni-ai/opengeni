import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SitePublishWarningFix,
  UpsertSitePublicationRequest,
  type AccessGrant,
  type SitePublication,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { getSitePublication, SiteDataError } from "@opengeni/db";
import * as z4 from "zod/v4";
import { ApiHttpError } from "../http/api-error";
import { contractToolInput } from "./contract-input";
import { siteDataHttpError } from "../routes/site-data";
import { siteSqlHttpError } from "../routes/site-sql";
import { applySitePublishWarningFix, SiteFixTargetMissing } from "../site-publishing/readiness";
import { SiteSqlError } from "../site-sql/service";
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

/** What people outside the workspace may do, stated in every publication answer. */
export const SITE_AUDIENCE_RULES =
  "Workspace members may use everything the Site declares, within what they may do in the workspace, and are never limited by Site limits. People outside the workspace (invited people and public visitors) get only the Site's own data: Site Data (by each collection's access mode, and its guest access for anonymous visitors), Site SQL named queries their audience allows, and the page. They never get workspace tools or subscription-billed models, and their assistant use counts toward the Site limit.";

/** A publication as the agent tools answer it: the audience rules and what to fix next. */
function publicationAnswer(publication: SitePublication) {
  return {
    ...publication,
    audienceRules: SITE_AUDIENCE_RULES,
    ...(publication.warnings.length > 0
      ? {
          nextStep:
            "Fix these readiness warnings before sharing the Site: apply a warning's fix with site_publication_apply_fix, or change the page, collection or query yourself, then read the publication again.",
        }
      : {}),
  };
}

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
        "Read how a Site is published on its own hostname: its URL, access (members, invited, public), status, embedded agent, limits, open abuse reports, usage and readiness warnings (what won't work for its audience, each with a suggestion and an optional safe fix). Returns published: false for a Site that has never been published. Only the Site's managers can use it.",
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
            publication: publicationAnswer(
              await sitePublicationView(deps, management.scope, publication),
            ),
          }
        : { published: false, siteId };
    }),
  );

  server.registerTool(
    "site_publication_update",
    {
      description:
        'Publish a Site on its own hostname (https://<label>.<sites domain>/), or change its publication. The Site must be shared with the workspace. access: members (workspace members sign in), invited (members and invitedEmails), public (anyone; may be off on this deployment). status: "unpublished" stops serving it and keeps its hostname. Audience rules: people outside the workspace (invited and public) get only the Site\'s own data (Site Data, Site SQL named queries and the page), never workspace tools or subscription models; for invited or public Sites build on Site Data, Site SQL and the page, and set collection guest access and query audiences to match. The answer lists readiness warnings: fix them before sharing (site_publication_apply_fix applies a safe fix). The agent\'s use by people outside the workspace counts toward the Site limit ($10 a month by default); members are never limited. Changing limitProfile or giving the agent workspace tools (agent.tools, for members only) needs a workspace admin; agent.guestTools is retired and ignored. Public puts the Site on the internet; make a Site public only when the person asked for it.',
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
      return publicationAnswer(
        (await upsertSitePublicationForManager(deps, grant, management, request.data)).publication,
      );
    }),
  );

  server.registerTool(
    "site_publication_apply_fix",
    {
      description:
        "Apply the safe fix of a Site publication readiness warning (the warning's fix object): set a Site Data collection's guest access, or a Site SQL named query's audience. Everything else about the collection or query stays as it is. Returns the publication with fresh warnings. Only the Site's managers can use it.",
      inputSchema: contractToolInput(
        z4.object({ siteId: SiteIdInput, fix: SitePublishWarningFix }),
      ),
    },
    call(async ({ siteId, fix }: { siteId: string; fix: unknown }) => {
      requireSitesDomain(deps.settings);
      const parsed = SitePublishWarningFix.safeParse(fix);
      if (!parsed.success)
        throw sitePublishingError(400, "validation_failed", "site_invalid_request", "Invalid fix");
      const management = await resolveSiteManagement(deps, grant, siteId, { mutate: true });
      requireSiteManager(management);
      const publication = await getSitePublication(deps.db, management.scope, management.record.id);
      if (!publication)
        throw sitePublishingError(404, "not_found", "site_not_published", "This Site is not published");
      try {
        await applySitePublishWarningFix(
          deps,
          grant,
          management.scope,
          management.record.id,
          parsed.data,
        );
      } catch (error) {
        if (error instanceof SiteFixTargetMissing)
          throw sitePublishingError(404, "not_found", "site_fix_target_missing", error.message);
        if (error instanceof SiteDataError) throw siteDataHttpError(error);
        if (error instanceof SiteSqlError) throw siteSqlHttpError(error);
        throw error;
      }
      return publicationAnswer(await sitePublicationView(deps, management.scope, publication));
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
