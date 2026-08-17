import { describe, expect, test } from "bun:test";
import { RememberError } from "@opengeni/core";
import type { Database } from "@opengeni/db";
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

function harness() {
  const handlers = new Map<string, Handler>();
  const remembers: unknown[] = [];
  const confirms: unknown[] = [];
  let authorizations = 0;
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
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
        const request = input.request as { proposalId: string };
        if (request.proposalId !== PROPOSAL_ID) {
          throw new RememberError("proposal_unavailable", "The remember proposal is not available");
        }
        return {
          status: "activated",
          operationId: OPERATION_ID,
          proposalId: PROPOSAL_ID,
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
  return { handlers, remembers, confirms, authorizations: () => authorizations };
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
    expect(h.authorizations()).toBe(2);
  });
});
