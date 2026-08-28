import {
  AGENT_AUTHORED_COMPANY_PROFILE_ENTRY_MAX_CHARS,
  AGENT_AUTHORED_COMPANY_PROFILE_SCALAR_MAX_CHARS,
  AGENT_AUTHORED_COMPANY_PROFILE_TOO_LONG_MESSAGE,
  AgentAuthoredCompanyProfileContent,
  COMPANY_PROFILE_REASON_MAX_CHARS,
  COMPANY_PROFILE_STABLE_KEY_MAX_CHARS,
  normalizeCompanyProfileStableKey,
  type CompanyProfileAgentAttempt,
  type CompanyProfileEntry,
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

// Agent-only bounds. The human `account:admin` API keeps the wider historical
// `COMPANY_PROFILE_*` limits; the current agent tool authors only the two
// always-on identity fields and therefore gets a much smaller budget.
const scalar = z
  .string()
  .trim()
  .min(1)
  .max(
    AGENT_AUTHORED_COMPANY_PROFILE_SCALAR_MAX_CHARS,
    AGENT_AUTHORED_COMPANY_PROFILE_TOO_LONG_MESSAGE,
  )
  .nullable();
const entry = z.object({
  key: z.string().trim().min(1).max(COMPANY_PROFILE_STABLE_KEY_MAX_CHARS).optional(),
  content: z
    .string()
    .trim()
    .min(1)
    .max(
      AGENT_AUTHORED_COMPANY_PROFILE_ENTRY_MAX_CHARS,
      AGENT_AUTHORED_COMPANY_PROFILE_TOO_LONG_MESSAGE,
    ),
});
const DEFAULT_PROPOSAL_REASON = "Activate agent-proposed organization identity";
const STABLE_KEY_WORDS = 6;

type EntryInput = z.infer<typeof entry>;

/**
 * Derive a stable key from entry content: the first few words, normalized into
 * the company-profile key alphabet and bounded to the stable-key length.
 */
export function deriveCompanyProfileStableKey(content: string): string {
  const words = content
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._-]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, STABLE_KEY_WORDS)
    .join(" ");
  const normalized = normalizeCompanyProfileStableKey(words)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, COMPANY_PROFILE_STABLE_KEY_MAX_CHARS)
    .replace(/^[._-]+|[._-]+$/g, "");
  return normalized.length > 0 ? normalized : "entry";
}

/**
 * Resolve explicit or derived keys for one list and de-duplicate by suffixing
 * `-2`, `-3`, ... so the profile passes the unique-key contract.
 */
export function resolveCompanyProfileEntries(input: readonly EntryInput[]): CompanyProfileEntry[] {
  const used = new Set<string>();
  return input.map(({ key, content }) => {
    const base = key
      ? normalizeCompanyProfileStableKey(key)
      : deriveCompanyProfileStableKey(content);
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix += 1) {
      const tail = `-${suffix}`;
      candidate = `${base.slice(0, COMPANY_PROFILE_STABLE_KEY_MAX_CHARS - tail.length)}${tail}`;
    }
    used.add(candidate);
    return { key: candidate, content };
  });
}

function boundedIssueMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`)
    .join("; ")
    .slice(0, 1_024);
}

/**
 * Register the explicit owner-confirmed organization profile path. This is
 * administration, not derived learning: workspace learning mode is never
 * consulted, the initiating human must be the organization's active owner (the
 * same authority as the manual `account:admin` route), and the proposal cannot
 * become active without the exact bound human-input response returned by the
 * first call.
 */
export function registerCompanyProfileAgentAdminTools(
  input: RegisterCompanyProfileAgentAdminToolsInput,
): void {
  const router = input.router ?? createCompanyProfileAgentAdminRouter({ db: input.db });
  input.server.registerTool(
    "company_profile_propose",
    {
      description:
        "Prepare the organization's small, stable identity: identity says who the organization is, and mission says why it exists. " +
        "Once activated, both fields are mandatory prompt context in every root session for the whole organization, so use one plain descriptive statement per field with no products, customers, goals, constraints, procedures, or marketing copy. Those details belong in organization-scoped Documents and are retrieved only when relevant. " +
        `Each field is bounded to ${AGENT_AUTHORED_COMPANY_PROFILE_SCALAR_MAX_CHARS} characters for agent-authored proposals. ` +
        "This creates only an immutable inactive proposal for the exact live turn initiated by the organization owner and does not use workspace learning policy. The receipt returns the exact `humanInput` payload; call `request_human_input` with it verbatim, then call `company_profile_confirm` with the returned requestId.",
      inputSchema: {
        operationId: z.string().uuid(),
        identity: scalar,
        mission: scalar,
        reason: z.string().trim().min(1).max(COMPANY_PROFILE_REASON_MAX_CHARS).optional(),
      },
    },
    async (request) => {
      await input.authorize();
      const parsed = AgentAuthoredCompanyProfileContent.safeParse({
        identity: request.identity,
        mission: request.mission,
        products: [],
        customers: [],
        goals: [],
        constraints: [],
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
        "Activate a `company_profile_propose` receipt only after the exact initiating organization owner answered Activate on the returned `request_human_input` prompt. Pass the proposalReceiptId and requestId unchanged. Confirmation revalidates the live turn, organization role, proposal hash, and unchanged active-profile baseline, then returns the immutable activation receipt.",
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
