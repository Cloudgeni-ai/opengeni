import { describe, expect, test } from "bun:test";
import { COMPANY_PROFILE_STABLE_KEY_MAX_CHARS } from "@opengeni/contracts";
import { CompanyProfileAgentAdminError } from "@opengeni/core";
import type { Database } from "@opengeni/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  deriveCompanyProfileStableKey,
  registerCompanyProfileAgentAdminTools,
  resolveCompanyProfileEntries,
} from "../src/mcp/company-profile-agent-admin";

const ATTEMPT = {
  accountId: "00000000-0000-4000-8000-000000000101",
  workspaceId: "00000000-0000-4000-8000-000000000102",
  sessionId: "00000000-0000-4000-8000-000000000103",
  turnId: "00000000-0000-4000-8000-000000000104",
  attemptId: "00000000-0000-4000-8000-000000000105",
  executionGeneration: 2,
  agentSubjectId: "worker:company-profile-agent",
};
const PROPOSE_OPERATION_ID = "00000000-0000-4000-8000-000000000109";
const CONFIRM_OPERATION_ID = "00000000-0000-4000-8000-000000000110";
const PROPOSAL_RECEIPT_ID = "00000000-0000-4000-8000-000000000111";
const HUMAN_INPUT_ID = "00000000-0000-4000-8000-000000000112";

type Handler = (input: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
}>;

function harness(options: { automatic?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const proposals: unknown[] = [];
  const confirmations: unknown[] = [];
  let authorizations = 0;
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerCompanyProfileAgentAdminTools({
    server,
    db: {} as Database,
    attempt: ATTEMPT,
    async authorize() {
      authorizations += 1;
    },
    json: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
    router: {
      async propose(input) {
        proposals.push(input);
        const request = input.request as { profile: ReturnType<typeof profile> };
        if (options.automatic) {
          return {
            status: "activated",
            operationId: PROPOSE_OPERATION_ID,
            proposalReceiptId: PROPOSAL_RECEIPT_ID,
            automaticActivationReceiptId: "00000000-0000-4000-8000-000000000114",
            policyMode: "automatic",
            mutation: {
              revision: null,
              head: null,
              event: null,
            },
            replayed: false,
          };
        }
        return {
          status: "confirmation_required",
          operationId: PROPOSE_OPERATION_ID,
          proposalReceiptId: PROPOSAL_RECEIPT_ID,
          policyMode: "suggest",
          revision: {
            id: "00000000-0000-4000-8000-000000000113",
            operationId: PROPOSE_OPERATION_ID,
            accountId: ATTEMPT.accountId,
            revision: 1,
            intent: "proposal",
            profile: request.profile,
            contentHash: "0".repeat(64),
            provenance: {
              source: "agent_admin",
              sourceId: `agent-admin-proposal:${PROPOSAL_RECEIPT_ID}`,
            },
            supersedesRevisionId: null,
            createdBySubjectId: ATTEMPT.agentSubjectId,
            createdAt: "2026-08-22T09:00:00.000Z",
          },
          humanInput: {
            questions: [
              {
                id: "company-profile:00000000-0000-4000-8000-000000000113",
                kind: "single_select",
                prompt: "Activate this organization identity and mission?",
                options: [
                  { id: "activate", label: "Activate" },
                  { id: "skip", label: "Do not activate" },
                ],
                required: true,
                allowOther: true,
              },
            ],
            allowSkip: false,
          },
          confirmWith: "company_profile_confirm",
          replayed: false,
        };
      },
      async confirm(input) {
        confirmations.push(input);
        throw new CompanyProfileAgentAdminError(
          "confirmation_unavailable",
          "The bound organization-owner confirmation is unavailable or no longer valid.",
        );
      },
    },
  });
  return { handlers, proposals, confirmations, authorizations: () => authorizations };
}

function profile() {
  return {
    identity: "Acme builds logistics software.",
    mission: "Make supply chains predictable.",
    products: [],
    customers: [],
    goals: [],
    constraints: [],
  };
}

describe("company-profile agent administration MCP tools", () => {
  test("bind the host attempt and expose the explicit two-step organization path", async () => {
    const h = harness();
    expect([...h.handlers.keys()]).toEqual(["company_profile_propose", "company_profile_confirm"]);
    const result = await h.handlers.get("company_profile_propose")!({
      operationId: PROPOSE_OPERATION_ID,
      identity: profile().identity,
      mission: profile().mission,
      reason: "The owner explicitly requested this organization profile.",
    });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "confirmation_required",
      proposalReceiptId: PROPOSAL_RECEIPT_ID,
      policyMode: "suggest",
      confirmWith: "company_profile_confirm",
    });
    expect(h.proposals).toEqual([
      {
        attempt: ATTEMPT,
        request: {
          operationId: PROPOSE_OPERATION_ID,
          profile: profile(),
          reason: "The owner explicitly requested this organization profile.",
        },
      },
    ]);
    expect(h.authorizations()).toBe(1);
  });

  test("returns a bounded denial when bound human confirmation is unavailable", async () => {
    const h = harness();
    const result = await h.handlers.get("company_profile_confirm")!({
      operationId: CONFIRM_OPERATION_ID,
      proposalReceiptId: PROPOSAL_RECEIPT_ID,
      humanInputRequestId: HUMAN_INPUT_ID,
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      status: "not_confirmed",
      code: "confirmation_unavailable",
      message: "The bound organization-owner confirmation is unavailable or no longer valid.",
    });
    expect(h.confirmations).toEqual([
      {
        attempt: ATTEMPT,
        request: {
          operationId: CONFIRM_OPERATION_ID,
          proposalReceiptId: PROPOSAL_RECEIPT_ID,
          humanInputRequestId: HUMAN_INPUT_ID,
        },
      },
    ]);
    expect(h.authorizations()).toBe(1);
  });

  test("returns an autonomous activation without manufacturing a confirmation step", async () => {
    const h = harness({ automatic: true });
    const result = await h.handlers.get("company_profile_propose")!({
      operationId: PROPOSE_OPERATION_ID,
      identity: profile().identity,
      mission: profile().mission,
    });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      status: "activated",
      proposalReceiptId: PROPOSAL_RECEIPT_ID,
      policyMode: "automatic",
    });
    expect(h.confirmations).toHaveLength(0);
    expect(h.authorizations()).toBe(1);
  });

  test("derived keys stay inside the stable-key alphabet and bound", () => {
    expect(deriveCompanyProfileStableKey("  Ship  the Agent Brain: simple & useful, fast!  ")).toBe(
      "ship-the-agent-brain-simple-useful",
    );
    expect(deriveCompanyProfileStableKey("!!! ???")).toBe("entry");
    const long = deriveCompanyProfileStableKey(`${"a".repeat(200)} b`);
    expect(long.length).toBeLessThanOrEqual(COMPANY_PROFILE_STABLE_KEY_MAX_CHARS);
    expect(
      resolveCompanyProfileEntries([
        { key: "Core", content: "one" },
        { content: "Core" },
        { content: "core" },
      ]).map((entry) => entry.key),
    ).toEqual(["core", "core-2", "core-3"]);
  });
});
