import { describe, expect, test } from "bun:test";
import {
  AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS,
  agentAuthoredDurableTextTooLongMessage,
} from "@opengeni/contracts";
import { RememberError } from "@opengeni/core";
import { PreferenceRegistryStableKeyConflictError, type Database } from "@opengeni/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRememberTools } from "../src/mcp/remember";

const ATTEMPT = {
  accountId: "00000000-0000-4000-8000-000000000101",
  workspaceId: "00000000-0000-4000-8000-000000000102",
  sessionId: "00000000-0000-4000-8000-000000000103",
  turnId: "00000000-0000-4000-8000-000000000104",
  attemptId: "00000000-0000-4000-8000-000000000105",
  executionGeneration: 2,
};
const OPERATION_ID = "00000000-0000-4000-8000-000000000109";
const PROPOSAL_ID = "00000000-0000-4000-8000-000000000110";
const DECISION_ID = "00000000-0000-4000-8000-000000000111";
const HUMAN_INPUT_ID = "00000000-0000-4000-8000-000000000112";

type Handler = (input: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
}>;

function harness(options: { rememberError?: Error } = {}) {
  const handlers = new Map<string, Handler>();
  const configs = new Map<string, { description?: string }>();
  const remembers: unknown[] = [];
  const confirms: unknown[] = [];
  let authorizations = 0;
  const server = {
    registerTool(name: string, config: { description?: string }, handler: Handler) {
      handlers.set(name, handler);
      configs.set(name, config);
    },
  } as unknown as McpServer;
  registerRememberTools({
    server,
    db: {} as Database,
    attempt: ATTEMPT,
    async authorize() {
      authorizations += 1;
    },
    json: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
    router: {
      async remember(input) {
        remembers.push(input);
        if (options.rememberError) throw options.rememberError;
        return {
          status: "blocked",
          operationId: OPERATION_ID,
          lane: "preference",
          scope: "workspace",
          reason: "learning_policy_off",
        };
      },
      async confirm(input) {
        confirms.push(input);
        const request = input.request as { target: string; proposalId?: string; claimId?: string };
        if (request.target === "knowledge_claim") {
          return {
            status: "activated",
            operationId: OPERATION_ID,
            proposalId: null,
            claimId: request.claimId!,
            decisionReceiptId: null,
            activation: {
              destination: "knowledge",
              receiptId: "00000000-0000-4000-8000-000000000114",
              claimId: request.claimId!,
              memoryId: "00000000-0000-4000-8000-000000000117",
              approvalReviewId: "00000000-0000-4000-8000-000000000115",
              effectiveAt: null,
              authorityKind: "human_confirmed",
              undo: "memory_management",
            },
          };
        }
        if (request.proposalId !== PROPOSAL_ID) {
          throw new RememberError("proposal_unavailable", "The remember proposal is not available");
        }
        return {
          status: "activated",
          operationId: OPERATION_ID,
          proposalId: PROPOSAL_ID,
          claimId: "00000000-0000-4000-8000-000000000116",
          decisionReceiptId: DECISION_ID,
          activation: {
            receiptId: "00000000-0000-4000-8000-000000000113",
            destination: "preference",
            destinationRevisionId: null,
            effectiveAt: null,
            authorityKind: "human_confirmed",
            undo: "learning_history",
          },
        };
      },
    },
  });
  return { handlers, configs, remembers, confirms, authorizations: () => authorizations };
}

describe("remember MCP tools", () => {
  test("bind the host attempt, default lane-specific fields, and never accept a wider scope", async () => {
    const h = harness();
    expect([...h.handlers.keys()]).toEqual(["remember", "remember_confirm"]);
    await h.handlers.get("remember")!({
      lane: "preference",
      operationId: OPERATION_ID,
      content: "Always deploy staging from main.",
      reason: "The user asked to remember it.",
      scope: "organization",
    });
    expect(h.authorizations()).toBe(1);
    expect(h.remembers).toEqual([
      {
        attempt: ATTEMPT,
        request: {
          operationId: OPERATION_ID,
          content: "Always deploy staging from main.",
          reason: "The user asked to remember it.",
          scope: "workspace",
          lane: "preference",
          stableKey: `remember.${OPERATION_ID.replaceAll("-", "")}`,
          title: "Always deploy staging from main.",
          description: "Always deploy staging from main.",
        },
      },
    ]);
    await h.handlers.get("remember")!({
      lane: "instruction_policy",
      operationId: OPERATION_ID,
      content: "Never push directly to main.",
      reason: "Hard rule from the user.",
    });
    expect(h.remembers[1]).toMatchObject({
      request: { lane: "instruction_policy", target: undefined },
    });
    await h.handlers.get("remember")!({
      lane: "knowledge",
      operationId: OPERATION_ID,
      content: "Acme's largest customer is Globex.",
      reason: "Stated by the user.",
      subject: "Acme",
    });
    expect(h.remembers[2]).toMatchObject({ request: { lane: "knowledge", subject: "Acme" } });
  });

  test("the tool description separates autonomous Memory from governed durable changes", () => {
    const description = harness().configs.get("remember")?.description ?? "";
    expect(description).toContain("use it instead for ordinary durable facts");
    expect(description).toContain("independent of Learning mode");
    expect(description).toContain(
      "lane=knowledge only when memory_save is unavailable and the user explicitly requests reviewed workspace knowledge",
    );
    expect(description).toContain("lane=preference creates a Skill");
    expect(description).toContain("lane=instruction_policy is only for a universal");
    expect(description).toContain(
      `at most ${AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS} characters`,
    );
    expect(description).toContain("normally 1-3 imperative sentences");
    expect(description).toContain("no numbered steps");
    expect(description).toContain(
      `Keep a Skill under ${AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS} characters`,
    );
    expect(description).toContain("one-sentence descriptor");
    expect(description).toContain(
      "eligible Skill or workspace instruction may activate immediately",
    );
    expect(description).toContain("Under Review first, it remains inactive");
    expect(description).toContain("Off creates no governed change");
    expect(description).toContain("materializes its exact approved text into Memory");
    expect(description).toContain("`memory_search` retrieval");
  });

  test("an over-budget prompt-composed lane is refused before anything durable is written", async () => {
    const h = harness();
    const essay = "x".repeat(AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS + 1);
    const refused = await h.handlers.get("remember")!({
      lane: "instruction_policy",
      operationId: OPERATION_ID,
      content: essay,
      reason: "The user asked to remember it.",
    });
    expect(JSON.parse(refused.content[0]!.text)).toEqual({
      status: "not_remembered",
      code: "content_too_long",
      message: agentAuthoredDurableTextTooLongMessage({
        kind: "instruction_policy",
        actualChars: essay.length,
      }),
    });
    expect(h.remembers).toEqual([]);

    const preference = "y".repeat(AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS + 1);
    const refusedPreference = await h.handlers.get("remember")!({
      lane: "preference",
      operationId: OPERATION_ID,
      content: preference,
      reason: "The user asked to remember it.",
    });
    expect(JSON.parse(refusedPreference.content[0]!.text)).toMatchObject({
      status: "not_remembered",
      code: "content_too_long",
    });
    expect(h.remembers).toEqual([]);

    // The Knowledge lane is retrieval evidence, so it keeps the wider ceiling.
    await h.handlers.get("remember")!({
      lane: "knowledge",
      operationId: OPERATION_ID,
      content: "z".repeat(AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS + 1),
      reason: "Stated by the user.",
      subject: "Acme",
    });
    expect(h.remembers).toHaveLength(1);
  });

  test("remember returns a bounded stable-key conflict instead of throwing persistence details", async () => {
    const h = harness({
      rememberError: new PreferenceRegistryStableKeyConflictError(
        "A preference with this stable key already exists for the workspace",
      ),
    });
    const result = await h.handlers.get("remember")!({
      lane: "preference",
      operationId: OPERATION_ID,
      content: "Use a concise, direct tone for support replies.",
      stableKey: "support.tone",
      title: "Support tone",
      description: "Suggested tone for support replies.",
      reason: "The user asked to remember it.",
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      status: "not_remembered",
      code: "preference_stable_key_conflict",
      message: "A preference with this stable key already exists for the workspace",
    });
  });

  test("remember_confirm returns a bounded not_confirmed result instead of throwing on remember errors", async () => {
    const h = harness();
    const ok = await h.handlers.get("remember_confirm")!({
      operationId: OPERATION_ID,
      proposalId: PROPOSAL_ID,
      decisionReceiptId: DECISION_ID,
      humanInputRequestId: HUMAN_INPUT_ID,
    });
    expect(JSON.parse(ok.content[0]!.text)).toMatchObject({
      status: "activated",
      activation: { authorityKind: "human_confirmed" },
    });
    const missing = await h.handlers.get("remember_confirm")!({
      operationId: OPERATION_ID,
      proposalId: "00000000-0000-4000-8000-000000000999",
      decisionReceiptId: DECISION_ID,
      humanInputRequestId: HUMAN_INPUT_ID,
    });
    expect(JSON.parse(missing.content[0]!.text)).toEqual({
      status: "not_confirmed",
      code: "proposal_unavailable",
      message: "The remember proposal is not available",
    });
    const knowledge = await h.handlers.get("remember_confirm")!({
      operationId: OPERATION_ID,
      claimId: "00000000-0000-4000-8000-000000000116",
      humanInputRequestId: HUMAN_INPUT_ID,
    });
    expect(JSON.parse(knowledge.content[0]!.text)).toMatchObject({
      status: "activated",
      activation: { destination: "knowledge", undo: "memory_management" },
    });
    expect(h.confirms[2]).toMatchObject({ request: { target: "knowledge_claim" } });
    const invalid = await h.handlers.get("remember_confirm")!({
      operationId: OPERATION_ID,
      humanInputRequestId: HUMAN_INPUT_ID,
    });
    expect(JSON.parse(invalid.content[0]!.text)).toMatchObject({
      status: "not_confirmed",
      code: "invalid_target",
    });
    expect(h.authorizations()).toBe(4);
  });
});
