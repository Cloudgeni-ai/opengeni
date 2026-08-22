import {
  COMPANY_PROFILE_ENTRY_MAX_CHARS,
  COMPANY_PROFILE_ENTRY_MAX_COUNT,
  COMPANY_PROFILE_REASON_MAX_CHARS,
  COMPANY_PROFILE_SCALAR_MAX_CHARS,
  COMPANY_PROFILE_STABLE_KEY_MAX_CHARS,
  type CompanyProfileAgentAttempt,
} from "@opengeni/contracts";
import {
  CompanyProfileAgentAdminError,
  createCompanyProfileAgentAdminRouter,
} from "@opengeni/core";
import type { Database } from "@opengeni/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

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

const entry = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(COMPANY_PROFILE_STABLE_KEY_MAX_CHARS)
    .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
  content: z.string().trim().min(1).max(COMPANY_PROFILE_ENTRY_MAX_CHARS),
});
const profile = z.object({
  identity: z.string().trim().min(1).max(COMPANY_PROFILE_SCALAR_MAX_CHARS).nullable(),
  mission: z.string().trim().min(1).max(COMPANY_PROFILE_SCALAR_MAX_CHARS).nullable(),
  products: z.array(entry).max(COMPANY_PROFILE_ENTRY_MAX_COUNT),
  customers: z.array(entry).max(COMPANY_PROFILE_ENTRY_MAX_COUNT),
  goals: z.array(entry).max(COMPANY_PROFILE_ENTRY_MAX_COUNT),
  constraints: z.array(entry).max(COMPANY_PROFILE_ENTRY_MAX_COUNT),
});

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
        "Prepare one complete organization company profile covering identity, mission, products, customers, strategic goals, and critical constraints. This creates only an immutable inactive proposal for the exact live turn of an organization owner/admin and does not use workspace learning policy. Show the proposed profile to the user first. The receipt returns the exact `humanInput` payload; call `request_human_input` with it verbatim, then call `company_profile_confirm` with the returned requestId.",
      inputSchema: {
        operationId: z.string().uuid(),
        profile,
        reason: z.string().trim().min(1).max(COMPANY_PROFILE_REASON_MAX_CHARS),
      },
    },
    async (request) => {
      await input.authorize();
      try {
        return input.json(await router.propose({ attempt: input.attempt, request }));
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
