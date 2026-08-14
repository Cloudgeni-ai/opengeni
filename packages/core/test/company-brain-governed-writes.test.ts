import { describe, expect, test } from "bun:test";
import type {
  CompanyBrainGovernedWriteReceipt,
  CompanyBrainGovernedWriteRequest,
} from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { createCompanyBrainGovernedWriteRouter } from "../src/domain/company-brain-governed-writes";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000101";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000102";
const SESSION_ID = "00000000-0000-4000-8000-000000000103";
const TURN_ID = "00000000-0000-4000-8000-000000000104";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000105";
const OPERATION_ID = "00000000-0000-4000-8000-000000000106";
const CLAIM_ID = "00000000-0000-4000-8000-000000000107";
const EVIDENCE_ID = "00000000-0000-4000-8000-000000000108";

const attempt = {
  accountId: ACCOUNT_ID,
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  turnId: TURN_ID,
  attemptId: ATTEMPT_ID,
  executionGeneration: 3,
};

function receiptFor(request: CompanyBrainGovernedWriteRequest): CompanyBrainGovernedWriteReceipt {
  const destination =
    request.kind === "propose_instruction_policy"
      ? "instruction_policy"
      : request.kind === "propose_preference"
        ? "preference"
        : "knowledge";
  return {
    operationId: request.operationId,
    inputHash: "a".repeat(64),
    workspaceId: WORKSPACE_ID,
    destination,
    outcome: "proposed",
    claimId: request.claimId,
    evidenceId: request.evidenceId,
    relationId:
      request.kind === "correct_knowledge" ? "00000000-0000-4000-8000-000000000109" : null,
    reviewId: "00000000-0000-4000-8000-000000000110",
    knowledgeChangeProposalId:
      destination === "knowledge" ? null : "00000000-0000-4000-8000-000000000111",
    destinationProposalId:
      destination === "knowledge" ? null : "00000000-0000-4000-8000-000000000112",
    destinationRevisionId:
      destination === "knowledge" ? null : "00000000-0000-4000-8000-000000000113",
    effectiveBoundary: "human_review_required",
    rollback: { supported: false, mechanism: "not_applicable_proposal_only" },
  };
}

describe("Company Brain governed write router", () => {
  test("accepts only explicit workspace-local proposal destinations", async () => {
    const captured: CompanyBrainGovernedWriteRequest[] = [];
    const router = createCompanyBrainGovernedWriteRouter({
      db: {} as Database,
      async authority(_db, input) {
        captured.push(input.request);
        return receiptFor(input.request);
      },
    });
    const requests: CompanyBrainGovernedWriteRequest[] = [
      {
        kind: "propose_knowledge",
        operationId: OPERATION_ID,
        claimId: CLAIM_ID,
        evidenceId: EVIDENCE_ID,
        reason: "Put the evidence-backed claim before a human reviewer.",
      },
      {
        kind: "correct_knowledge",
        operationId: "00000000-0000-4000-8000-000000000114",
        claimId: CLAIM_ID,
        evidenceId: EVIDENCE_ID,
        replacesClaimId: "00000000-0000-4000-8000-000000000115",
        reason: "Propose the replacement while preserving the old claim in the audit graph.",
      },
      {
        kind: "propose_instruction_policy",
        operationId: "00000000-0000-4000-8000-000000000116",
        claimId: CLAIM_ID,
        evidenceId: EVIDENCE_ID,
        target: { kind: "policy", scope: "role", roleKey: "support" },
        content: "Escalate customer-impacting incidents immediately.",
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
        reason: "Materialize an inactive draft for human review.",
      },
      {
        kind: "propose_preference",
        operationId: "00000000-0000-4000-8000-000000000117",
        claimId: CLAIM_ID,
        evidenceId: EVIDENCE_ID,
        stableKey: "support.escalation-tone",
        title: "Support escalation tone",
        description: "Suggested communication style during customer-impacting incidents.",
        content: "Use concise, direct status updates.",
        precedenceRank: 0,
        conflictStrategy: "override",
        conflictsWith: [],
        expiresAt: null,
        reason: "Materialize an inactive workspace preference for human review.",
      },
    ];

    for (const request of requests) {
      const result = await router.write({ attempt, request });
      expect(result.outcome).toBe("proposed");
      expect(result.effectiveBoundary).toBe("human_review_required");
      expect(result.rollback).toEqual({
        supported: false,
        mechanism: "not_applicable_proposal_only",
      });
    }
    expect(captured.map((request) => request.kind)).toEqual([
      "propose_knowledge",
      "correct_knowledge",
      "propose_instruction_policy",
      "propose_preference",
    ]);
  });

  test("fails closed for generic memory, active authority, and caller-selected scope", async () => {
    const router = createCompanyBrainGovernedWriteRouter({
      db: {} as Database,
      async authority() {
        throw new Error("authority must not be called");
      },
    });
    for (const request of [
      {
        kind: "remember",
        operationId: OPERATION_ID,
        claimId: CLAIM_ID,
        evidenceId: EVIDENCE_ID,
        reason: "Remember this.",
      },
      {
        kind: "propose_preference",
        operationId: OPERATION_ID,
        claimId: CLAIM_ID,
        evidenceId: EVIDENCE_ID,
        stableKey: "support.tone",
        title: "Support tone",
        description: "Suggested support tone.",
        content: "Be concise.",
        reason: "Propose only.",
        authority: "active",
      },
      {
        kind: "propose_knowledge",
        operationId: OPERATION_ID,
        claimId: CLAIM_ID,
        evidenceId: EVIDENCE_ID,
        reason: "Wrong scope.",
        scope: "personal",
      },
    ]) {
      await expect(router.write({ attempt, request })).rejects.toThrow();
    }
  });
});
