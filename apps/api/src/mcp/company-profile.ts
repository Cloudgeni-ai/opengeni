import {
  COMPANY_PROFILE_ENTRY_MAX_CHARS,
  COMPANY_PROFILE_ENTRY_MAX_COUNT,
  COMPANY_PROFILE_REASON_MAX_CHARS,
  COMPANY_PROFILE_SCALAR_MAX_CHARS,
  COMPANY_PROFILE_STABLE_KEY_MAX_CHARS,
  CompanyProfileContent,
  normalizeCompanyProfileStableKey,
  type CompanyBrainGovernedWriteAttempt,
  type CompanyProfileEntry,
} from "@opengeni/contracts";
import {
  CompanyProfileOperationReuseError,
  proposeCompanyProfile,
  type CompanyProfileProposalResult,
  type Database,
} from "@opengeni/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

type JsonResult = (value: unknown) => {
  content: { type: "text"; text: string }[];
};

export type CompanyProfileProposeInput = {
  operationId: string;
  accountId: string;
  workspaceId: string;
  profile: CompanyProfileContent;
  actorSubjectId: string;
  sourceId: string;
};

export type RegisterCompanyProfileToolsInput = {
  server: McpServer;
  db: Database;
  attempt: CompanyBrainGovernedWriteAttempt;
  /** Subject recorded as the proposal creator; the worker-signed attempt grant subject. */
  actorSubjectId: string;
  authorize: () => Promise<void>;
  json: JsonResult;
  propose?: (input: CompanyProfileProposeInput) => Promise<CompanyProfileProposalResult>;
};

export const COMPANY_PROFILE_PROPOSE_NEXT_ACTION =
  "An organization owner or admin can review and activate this proposal under Company Brain → Company profile & goals.";

const STABLE_KEY_WORDS = 6;

const scalar = z.string().trim().min(1).max(COMPANY_PROFILE_SCALAR_MAX_CHARS).nullable();
const entry = z.object({
  key: z.string().trim().min(1).max(COMPANY_PROFILE_STABLE_KEY_MAX_CHARS).optional(),
  content: z.string().trim().min(1).max(COMPANY_PROFILE_ENTRY_MAX_CHARS),
});
const entries = z.array(entry).max(COMPANY_PROFILE_ENTRY_MAX_COUNT);

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
 * Agent-facing company-profile proposal. The exact worker-signed attempt owns
 * tenant authority; tool input carries only the proposed full profile. The
 * tool records one inactive proposal revision and never activates it.
 */
export function registerCompanyProfileTools(input: RegisterCompanyProfileToolsInput): void {
  const propose = input.propose ?? ((request) => proposeCompanyProfile(input.db, request));
  input.server.registerTool(
    "company_profile_propose",
    {
      description:
        "Record an inactive proposal for the organization-wide company profile (identity, mission, products, customers, goals, critical constraints). It never activates itself: an organization owner or admin reviews and activates the proposal in Company Brain → Company profile & goals. Send the complete profile, not a delta; omitted list keys are derived from the content. Use it only after the user confirmed the proposed profile. Do not save company context as Memory, Documents, workspace policy, or a preference.",
      inputSchema: {
        operationId: z.string().uuid(),
        identity: scalar,
        mission: scalar,
        products: entries,
        customers: entries,
        goals: entries,
        constraints: entries,
        reason: z.string().trim().min(1).max(COMPANY_PROFILE_REASON_MAX_CHARS),
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
        const result = await propose({
          operationId: request.operationId,
          accountId: input.attempt.accountId,
          workspaceId: input.attempt.workspaceId,
          profile: parsed.data,
          actorSubjectId: input.actorSubjectId,
          sourceId: `agent-attempt:${input.attempt.attemptId}`,
        });
        return input.json({
          status: "proposed",
          operationId: request.operationId,
          revisionId: result.revision.id,
          revision: result.revision.revision,
          nextAction: COMPANY_PROFILE_PROPOSE_NEXT_ACTION,
        });
      } catch (error) {
        if (error instanceof CompanyProfileOperationReuseError) {
          return input.json({
            status: "not_proposed",
            code: "operation_reused",
            message: error.message,
          });
        }
        throw error;
      }
    },
  );
}
