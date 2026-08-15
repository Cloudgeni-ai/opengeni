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
    request.kind === "propose_instruction_policy" ||
    request.kind === "promote_task_note_instruction_policy"
      ? "instruction_policy"
      : request.kind === "propose_preference" || request.kind === "promote_task_note_preference"
        ? "preference"
        : "knowledge";
  const taskNotePromotion =
    request.kind === "promote_task_note_knowledge" ||
    request.kind === "promote_task_note_instruction_policy" ||
    request.kind === "promote_task_note_preference";
  return {
    operationId: request.operationId,
    inputHash: "a".repeat(64),
    workspaceId: WORKSPACE_ID,
    destination,
    outcome: "proposed",
    claimId: taskNotePromotion ? "00000000-0000-4000-8000-000000000118" : request.claimId,
    evidenceId: taskNotePromotion ? "00000000-0000-4000-8000-000000000119" : request.evidenceId,
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
        kind: "promote_task_note_knowledge",
        operationId: "00000000-0000-4000-8000-000000000120",
        noteId: "00000000-0000-4000-8000-000000000121",
        expectedNoteVersion: 1,
        entityType: "company",
        normalizedKey: "acme",
        displayName: "Acme",
        predicateKey: "company.fact",
        confidenceBps: 8_000,
        reason: "Promote the rooted task finding as proposed workspace Knowledge.",
      },
      {
        kind: "promote_task_note_instruction_policy",
        operationId: "00000000-0000-4000-8000-000000000122",
        noteId: "00000000-0000-4000-8000-000000000123",
        expectedNoteVersion: 1,
        entityType: "working_method",
        normalizedKey: "support-escalation",
        displayName: "Support escalation",
        predicateKey: "ways.instruction",
        confidenceBps: 8_000,
        target: { kind: "policy", scope: "role", roleKey: "support" },
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
        reason: "Promote the exact rooted note into an inactive mandatory-rule draft.",
      },
      {
        kind: "promote_task_note_preference",
        operationId: "00000000-0000-4000-8000-000000000124",
        noteId: "00000000-0000-4000-8000-000000000125",
        expectedNoteVersion: 1,
        entityType: "working_method",
        normalizedKey: "support-tone",
        displayName: "Support tone",
        predicateKey: "ways.preference",
        confidenceBps: 8_000,
        stableKey: "support.escalation-tone",
        title: "Support escalation tone",
        description: "Suggested communication style during customer-impacting incidents.",
        precedenceRank: 0,
        conflictStrategy: "override",
        conflictsWith: [],
        expiresAt: null,
        reason: "Promote the exact rooted note into an inactive preference proposal.",
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

    for (const candidate of requests) {
      const result = await router.write({ attempt, request: candidate });
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
      "promote_task_note_knowledge",
      "promote_task_note_instruction_policy",
      "promote_task_note_preference",
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
      {
        kind: "promote_task_note_preference",
        operationId: OPERATION_ID,
        noteId: "00000000-0000-4000-8000-000000000125",
        expectedNoteVersion: 1,
        entityType: "working_method",
        normalizedKey: "support-tone",
        displayName: "Support tone",
        predicateKey: "ways.preference",
        confidenceBps: 8_000,
        stableKey: "support.tone",
        title: "Support tone",
        description: "Suggested support tone.",
        content: "Caller-supplied replacement bytes must be rejected.",
        reason: "The note must own the content.",
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

  test("Task-note promotion derives its policy source from the exact note id", async () => {
    const noteId = "00000000-0000-4000-8000-000000000298";
    const promotion: CompanyBrainGovernedWriteRequest = {
      kind: "promote_task_note_knowledge",
      operationId: "00000000-0000-4000-8000-000000000297",
      noteId,
      expectedNoteVersion: 1,
      entityType: "company",
      normalizedKey: "acme",
      displayName: "Acme",
      predicateKey: "company.fact",
      confidenceBps: 8_000,
      reason: "Promote the rooted finding for review.",
    };
    const router = createCompanyBrainLearningPolicyRouter({
      db: {} as Database,
      async learningPolicySnapshot() {
        return policySnapshot("automatic", [{ kind: "task-note", id: noteId, mode: "off" }]);
      },
      async authority() {
        throw new Error("note-specific off override must prevent a write");
      },
    });
    const result = await router.write({ attempt, request: promotion });
    expect(result.decision).toBe("blocked");
    expect(result.effectivePolicy.source).toEqual({ kind: "task-note", id: noteId });
  });

  test("both Task-note Ways destinations use the note source and remain policy-blockable", async () => {
    const noteId = "00000000-0000-4000-8000-000000000288";
    const base = {
      operationId: "00000000-0000-4000-8000-000000000287",
      noteId,
      expectedNoteVersion: 1 as const,
      entityType: "working_method",
      normalizedKey: "support-tone",
      displayName: "Support tone",
      predicateKey: "ways.preference",
      confidenceBps: 8_000,
      reason: "Promote the exact note for review.",
    };
    const requests: CompanyBrainGovernedWriteRequest[] = [
      {
        kind: "promote_task_note_instruction_policy",
        ...base,
        target: { kind: "policy", scope: "global", roleKey: null },
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
      },
      {
        kind: "promote_task_note_preference",
        ...base,
        operationId: "00000000-0000-4000-8000-000000000286",
        stableKey: "support.tone",
        title: "Support tone",
        description: "Suggested tone for support replies.",
        precedenceRank: 0,
        conflictStrategy: "override",
        conflictsWith: [],
        expiresAt: null,
      },
    ];
    for (const candidate of requests) {
      const router = createCompanyBrainLearningPolicyRouter({
        db: {} as Database,
        async learningPolicySnapshot() {
          return policySnapshot("automatic", [{ kind: "task-note", id: noteId, mode: "off" }]);
        },
        async authority() {
          throw new Error("note-specific off override must prevent a Ways write");
        },
      });
      const result = await router.write({ attempt, request: candidate });
      expect(result.decision).toBe("blocked");
      expect(result.effectivePolicy.source).toEqual({ kind: "task-note", id: noteId });
    }
  });
});
