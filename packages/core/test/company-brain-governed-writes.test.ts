import { describe, expect, test } from "bun:test";
import type {
  CompanyBrainGovernedWriteReceipt,
  CompanyBrainGovernedWriteRequest,
  WorkspaceLearningPolicySnapshot,
} from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import {
  createCompanyBrainGovernedWriteRouter,
  createCompanyBrainLearningPolicyRouter,
} from "../src/domain/company-brain-governed-writes";

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

function policySnapshot(
  mode: "off" | "suggest" | "automatic",
  overrides: WorkspaceLearningPolicySnapshot["sourceOverrides"] = [],
): WorkspaceLearningPolicySnapshot {
  return {
    id: "00000000-0000-4000-8000-000000000201",
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    attemptId: ATTEMPT_ID,
    executionGeneration: 3,
    revision: null,
    activationVersion: 0,
    activatedAt: null,
    workspaceMode: mode,
    sourceOverrides: overrides,
    snapshotHash: "b".repeat(64),
    createdAt: "2026-08-15T00:00:00.000Z",
  };
}

describe("Company Brain learning-policy router", () => {
  const request: CompanyBrainGovernedWriteRequest = {
    kind: "propose_knowledge",
    operationId: OPERATION_ID,
    claimId: CLAIM_ID,
    evidenceId: EVIDENCE_ID,
    reason: "Route derived evidence through the frozen workspace policy.",
  };

  test("off prevents durable destination writes", async () => {
    let writes = 0;
    const router = createCompanyBrainLearningPolicyRouter({
      db: {} as Database,
      async learningPolicySnapshot() {
        return policySnapshot("off");
      },
      async authority() {
        writes += 1;
        return receiptFor(request);
      },
    });
    const result = await router.write({ attempt, request });
    expect(result.decision).toBe("blocked");
    expect(result.write).toBeNull();
    expect(result.activation).toEqual({
      requested: false,
      activated: false,
      boundary: "policy_off",
    });
    expect(writes).toBe(0);
  });

  test("suggest creates an inactive proposal for human review", async () => {
    const router = createCompanyBrainLearningPolicyRouter({
      db: {} as Database,
      async learningPolicySnapshot() {
        return policySnapshot("suggest");
      },
      async authority() {
        return receiptFor(request);
      },
    });
    const result = await router.write({ attempt, request });
    expect(result.decision).toBe("proposal_created");
    expect(result.write?.outcome).toBe("proposed");
    expect(result.activation.boundary).toBe("human_review");
  });

  test("automatic requests destination activation without bypassing its lifecycle", async () => {
    const router = createCompanyBrainLearningPolicyRouter({
      db: {} as Database,
      async learningPolicySnapshot() {
        return policySnapshot("automatic");
      },
      async authority() {
        return receiptFor(request);
      },
    });
    const result = await router.write({ attempt, request });
    expect(result.decision).toBe("activation_requested");
    expect(result.activation).toEqual({
      requested: true,
      activated: false,
      boundary: "destination_authority",
    });
    expect(result.write?.effectiveBoundary).toBe("human_review_required");
  });

  test("exact evidence identity owns source overrides", async () => {
    const router = createCompanyBrainLearningPolicyRouter({
      db: {} as Database,
      async learningPolicySnapshot() {
        return policySnapshot("automatic", [
          { kind: "scoped-knowledge-evidence", id: EVIDENCE_ID, mode: "off" },
          {
            kind: "scoped-knowledge-evidence",
            id: "00000000-0000-4000-8000-000000000299",
            mode: "automatic",
          },
        ]);
      },
      async authority() {
        throw new Error("evidence-specific off override must prevent a write");
      },
    });
    const result = await router.write({ attempt, request });
    expect(result.decision).toBe("blocked");
    expect(result.effectivePolicy.source).toEqual({
      kind: "scoped-knowledge-evidence",
      id: EVIDENCE_ID,
    });
  });
});
