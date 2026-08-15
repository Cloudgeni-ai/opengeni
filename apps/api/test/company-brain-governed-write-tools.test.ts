import { describe, expect, test } from "bun:test";
import type { CompanyBrainLearningPolicyRouteReceipt } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCompanyBrainGovernedWriteTools } from "../src/mcp/company-brain-governed-writes";

const ATTEMPT = {
  accountId: "00000000-0000-4000-8000-000000000101",
  workspaceId: "00000000-0000-4000-8000-000000000102",
  sessionId: "00000000-0000-4000-8000-000000000103",
  turnId: "00000000-0000-4000-8000-000000000104",
  attemptId: "00000000-0000-4000-8000-000000000105",
  executionGeneration: 2,
};
const CLAIM_ID = "00000000-0000-4000-8000-000000000106";
const EVIDENCE_ID = "00000000-0000-4000-8000-000000000107";

type Handler = (input: Record<string, unknown>) => Promise<unknown>;

function receipt(operationId: string): CompanyBrainLearningPolicyRouteReceipt {
  return {
    operationId,
    workspaceId: ATTEMPT.workspaceId,
    effectivePolicy: {
      mode: "suggest",
      inherited: true,
      source: { kind: "scoped-knowledge-evidence", id: EVIDENCE_ID },
      policyRevision: null,
      activationVersion: 0,
      snapshotId: "00000000-0000-4000-8000-000000000108",
      revisionId: "workspace-learning-policy:default-off:v1",
      snapshotHash: "a".repeat(64),
    },
    decision: "proposal_created",
    write: null,
    activation: { requested: false, activated: false, boundary: "human_review" },
  };
}

describe("Company Brain governed write tools", () => {
  test("register explicit proposal tools and bind the host attempt", async () => {
    const handlers = new Map<string, Handler>();
    let authorizations = 0;
    const writes: unknown[] = [];
    const server = {
      registerTool(name: string, _config: unknown, handler: Handler) {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;
    registerCompanyBrainGovernedWriteTools({
      server,
      db: {} as Database,
      attempt: ATTEMPT,
      async authorize() {
        authorizations += 1;
      },
      json: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
      router: {
        async write(input) {
          writes.push(input);
          const request = input.request as { operationId: string };
          return receipt(request.operationId);
        },
      },
    });

    expect([...handlers.keys()]).toEqual([
      "knowledge_propose",
      "knowledge_correct",
      "task_note_promote_knowledge",
      "task_note_promote_instruction_policy",
      "task_note_promote_preference",
      "instruction_policy_propose",
      "preference_propose",
    ]);
    const operationId = "00000000-0000-4000-8000-000000000109";
    await handlers.get("knowledge_propose")!({
      operationId,
      claimId: CLAIM_ID,
      evidenceId: EVIDENCE_ID,
      reason: "Propose this evidence-backed fact.",
    });
    const taskNoteOperationId = "00000000-0000-4000-8000-000000000112";
    await handlers.get("task_note_promote_preference")!({
      operationId: taskNoteOperationId,
      noteId: "00000000-0000-4000-8000-000000000113",
      expectedNoteVersion: 1,
      entityType: "working_method",
      normalizedKey: "support-tone",
      displayName: "Support tone",
      predicateKey: "ways.preference",
      confidenceBps: 8_000,
      stableKey: "support.tone",
      title: "Support tone",
      description: "Suggested tone for support replies.",
      precedenceRank: 0,
      conflictStrategy: "override",
      conflictsWith: [],
      expiresAt: null,
      reason: "Promote the exact note into an inactive preference.",
    });
    expect(authorizations).toBe(2);
    expect(writes).toEqual([
      {
        attempt: ATTEMPT,
        request: {
          kind: "propose_knowledge",
          operationId,
          claimId: CLAIM_ID,
          evidenceId: EVIDENCE_ID,
          reason: "Propose this evidence-backed fact.",
        },
      },
      {
        attempt: ATTEMPT,
        request: {
          kind: "promote_task_note_preference",
          operationId: taskNoteOperationId,
          noteId: "00000000-0000-4000-8000-000000000113",
          expectedNoteVersion: 1,
          entityType: "working_method",
          normalizedKey: "support-tone",
          displayName: "Support tone",
          predicateKey: "ways.preference",
          confidenceBps: 8_000,
          stableKey: "support.tone",
          title: "Support tone",
          description: "Suggested tone for support replies.",
          precedenceRank: 0,
          conflictStrategy: "override",
          conflictsWith: [],
          expiresAt: null,
          reason: "Promote the exact note into an inactive preference.",
        },
      },
    ]);
  });

  test("authorization runs before any router write", async () => {
    let writes = 0;
    const handlers = new Map<string, Handler>();
    registerCompanyBrainGovernedWriteTools({
      server: {
        registerTool(name: string, _config: unknown, handler: Handler) {
          handlers.set(name, handler);
        },
      } as unknown as McpServer,
      db: {} as Database,
      attempt: ATTEMPT,
      async authorize() {
        throw new Error("denied");
      },
      json: (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] }),
      router: {
        async write(input) {
          writes += 1;
          return receipt((input.request as { operationId: string }).operationId);
        },
      },
    });
    await expect(
      handlers.get("knowledge_correct")!({
        operationId: "00000000-0000-4000-8000-000000000110",
        claimId: CLAIM_ID,
        evidenceId: EVIDENCE_ID,
        replacesClaimId: "00000000-0000-4000-8000-000000000111",
        reason: "Replace the stale claim.",
      }),
    ).rejects.toThrow("denied");
    expect(writes).toBe(0);
  });
});
