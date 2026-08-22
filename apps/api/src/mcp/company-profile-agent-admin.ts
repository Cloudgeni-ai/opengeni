import {
  COMPANY_PROFILE_ENTRY_MAX_CHARS,
  COMPANY_PROFILE_ENTRY_MAX_COUNT,
  COMPANY_PROFILE_REASON_MAX_CHARS,
  COMPANY_PROFILE_SCALAR_MAX_CHARS,
  COMPANY_PROFILE_STABLE_KEY_MAX_CHARS,
  CompanyProfileContent,
  type CompanyProfileAgentAttempt,
} from "@opengeni/contracts";
import {
  CompanyProfileAgentAdminError,
  createCompanyProfileAgentAdminRouter,
} from "@opengeni/core";
import type { Database } from "@opengeni/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { resolveCompanyProfileEntries } from "./company-profile";

type JsonResult = (value: unknown) => {
  content: { type: "text"; text: string }[];
};

export type RegisterCompanyProfileAgentAdminToolsInput = {
  server: McpServer;
  db: Database;
  attempt: CompanyProfileAgentAttempt;
  authorize: () => Promise<void>;
  json: JsonResult;
  router?: Pick<ReturnType<typeof createCompanyProfileAgentAdminRouter>, "propose" | "confirm">;
};

const scalar = z.string().trim().min(1).max(COMPANY_PROFILE_SCALAR_MAX_CHARS).nullable();
const entry = z.object({
  key: z.string().trim().min(1).max(COMPANY_PROFILE_STABLE_KEY_MAX_CHARS).optional(),
  content: z.string().trim().min(1).max(COMPANY_PROFILE_ENTRY_MAX_CHARS),
});
const entries = z.array(entry).max(COMPANY_PROFILE_ENTRY_MAX_COUNT);
const DEFAULT_PROPOSAL_REASON = "Activate agent-proposed organization company profile";

function boundedIssueMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`)
    .join("; ")
    .slice(0, 1_024);
}

/**
 * Register the explicit owner/admin-confirmed organization profile path. This
 * is administration, not derived learning: workspace learning mode is never
 * consulted, and the proposal cannot become active without the exact bound
 * human-input response returned by the first call.
 */
export function registerCompanyProfileAgentAdminTools(
  input: RegisterCompanyProfileAgentAdminToolsInput,
): void {
  const router = input.router ?? createCompanyProfileAgentAdminRouter({ db: input.db });
  input.server.registerTool(
    "company_profile_propose",
    {
      description:
        "Prepare one complete organization company profile covering identity, mission, products, customers, strategic goals, and critical constraints. Omitted list keys are derived from content. This creates only an immutable inactive proposal for the exact live turn of an organization owner/admin and does not use workspace learning policy. The receipt returns the exact `humanInput` payload; call `request_human_input` with it verbatim, then call `company_profile_confirm` with the returned requestId.",
      inputSchema: {
        operationId: z.string().uuid(),
        identity: scalar,
        mission: scalar,
        products: entries,
        customers: entries,
        goals: entries,
        constraints: entries,
        reason: z.string().trim().min(1).max(COMPANY_PROFILE_REASON_MAX_CHARS).optional(),
      },
    },
    async (request) => {
      await input.authorize();
      const parsed = CompanyProfileContent.safeParse({
        identity: request.identity,
        mission: request.mission,
        products: resolveCompanyProfileEntries(request.products),
        customers: resolveCompanyProfileEntries(request.customers),
        goals: resolveCompanyProfileEntries(request.goals),
        constraints: resolveCompanyProfileEntries(request.constraints),
      });
      if (!parsed.success) {
        return input.json({
          status: "not_proposed",
          code: "invalid_profile",
          message: boundedIssueMessage(parsed.error),
        });
      }
      try {
        return input.json(
          await router.propose({
            attempt: input.attempt,
            request: {
              operationId: request.operationId,
              profile: parsed.data,
              reason: request.reason ?? DEFAULT_PROPOSAL_REASON,
            },
          }),
        );
      } catch (error) {
        if (error instanceof CompanyProfileAgentAdminError) {
          return input.json({ status: "not_proposed", code: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  input.server.registerTool(
    "company_profile_confirm",
    {
      description:
        "Activate a `company_profile_propose` receipt only after the exact initiating organization owner/admin answered Activate on the returned `request_human_input` prompt. Pass the proposalReceiptId and requestId unchanged. Confirmation revalidates the live turn, organization role, proposal hash, and unchanged active-profile baseline, then returns the immutable activation receipt.",
      inputSchema: {
        operationId: z.string().uuid(),
        proposalReceiptId: z.string().uuid(),
        humanInputRequestId: z.string().uuid(),
      },
    },
    async (request) => {
      await input.authorize();
      try {
        return input.json(await router.confirm({ attempt: input.attempt, request }));
      } catch (error) {
        if (error instanceof CompanyProfileAgentAdminError) {
          return input.json({ status: "not_confirmed", code: error.code, message: error.message });
        }
        throw error;
      }
    },
  );
}
