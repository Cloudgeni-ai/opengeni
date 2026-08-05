import { describe, expect, test } from "bun:test";
import {
  CreateWorkspaceInstructionPolicyDraftRequest,
  CreateWorkspaceInstructionPolicyOnboardingProposalRequest,
  WorkspaceInstructionPolicyActivationEvent,
  WorkspaceInstructionPolicyOnboardingProposal,
  WorkspaceInstructionPolicyTarget,
  normalizeWorkspaceInstructionPolicyRoleKey,
} from "../src";

describe("workspace instruction-policy contracts", () => {
  test("normalizes role keys and rejects invalid kind/scope combinations", () => {
    expect(normalizeWorkspaceInstructionPolicyRoleKey("  Incident   RESPONDER  ")).toBe(
      "incident-responder",
    );
    expect(
      CreateWorkspaceInstructionPolicyDraftRequest.parse({
        kind: "policy",
        scope: "role",
        roleKey: "  Incident   RESPONDER  ",
        content: "Escalate production-impacting incidents.",
        provenanceSource: "knowledge_proposal",
      }),
    ).toMatchObject({ roleKey: "incident-responder", provenanceSourceId: null });

    expect(
      WorkspaceInstructionPolicyTarget.safeParse({
        kind: "charter",
        scope: "role",
        roleKey: "operator",
      }).success,
    ).toBe(false);
    expect(
      WorkspaceInstructionPolicyTarget.safeParse({
        kind: "policy",
        scope: "global",
        roleKey: "operator",
      }).success,
    ).toBe(false);
    expect(
      WorkspaceInstructionPolicyTarget.safeParse({
        kind: "policy",
        scope: "role",
        roleKey: null,
      }).success,
    ).toBe(false);
    expect(
      CreateWorkspaceInstructionPolicyDraftRequest.safeParse({
        kind: "charter",
        scope: "global",
        roleKey: null,
        content: "Caller-labeled legacy content",
        provenanceSource: "legacy_import",
      }).success,
    ).toBe(false);
  });

  test("normalizes onboarding provenance while preserving typed content validation", () => {
    const request = CreateWorkspaceInstructionPolicyOnboardingProposalRequest.parse({
      operationId: "00000000-0000-4000-8000-000000000010",
      kind: "policy",
      scope: "role",
      roleKey: " Incident   Commander ",
      content: "",
      sourceId: " guided-onboarding ",
      sourceVersion: " 2026-08-03 ",
      confidenceBps: 9_250,
      expectedCurrentRevisionId: null,
      expectedActivationVersion: 0,
    });
    expect(request).toMatchObject({
      roleKey: "incident-commander",
      content: "",
      sourceId: "guided-onboarding",
      sourceVersion: "2026-08-03",
      confidenceBps: 9_250,
    });

    const proposal = WorkspaceInstructionPolicyOnboardingProposal.parse({
      id: "00000000-0000-4000-8000-000000000011",
      operationId: request.operationId,
      accountId: "00000000-0000-4000-8000-000000000012",
      workspaceId: "00000000-0000-4000-8000-000000000013",
      kind: "policy",
      scope: "role",
      roleKey: request.roleKey,
      source: { id: request.sourceId, version: request.sourceVersion, confidenceBps: 9_250 },
      baseline: null,
      draft: {
        id: "00000000-0000-4000-8000-000000000014",
        operationId: request.operationId,
        accountId: "00000000-0000-4000-8000-000000000012",
        workspaceId: "00000000-0000-4000-8000-000000000013",
        kind: "policy",
        scope: "role",
        roleKey: request.roleKey,
        revision: 17,
        content: "Escalate production-impacting incidents.",
        contentHash: "c".repeat(64),
        provenance: {
          source: "onboarding",
          sourceId: "00000000-0000-4000-8000-000000000011",
        },
        supersedesRevisionId: null,
        createdBySubjectId: "user:admin",
        createdAt: "2026-08-03T20:00:00.000Z",
      },
      status: "proposed",
      createdBySubjectId: "user:admin",
      createdAt: "2026-08-03T20:00:00.000Z",
    });
    expect(proposal.status).toBe("proposed");
    expect(proposal.draft.provenance.source).toBe("onboarding");
    expect(proposal.baseline).toBeNull();
  });

  test("requires complete immutable activation audit evidence", () => {
    const event = WorkspaceInstructionPolicyActivationEvent.parse({
      id: "00000000-0000-4000-8000-000000000001",
      operationId: "00000000-0000-4000-8000-000000000006",
      accountId: "00000000-0000-4000-8000-000000000002",
      workspaceId: "00000000-0000-4000-8000-000000000003",
      kind: "policy",
      scope: "global",
      roleKey: null,
      type: "rollback",
      activationVersion: 3,
      oldRevision: {
        id: "00000000-0000-4000-8000-000000000004",
        revision: 11,
        contentHash: "a".repeat(64),
      },
      newRevision: {
        id: "00000000-0000-4000-8000-000000000005",
        revision: 7,
        contentHash: "b".repeat(64),
      },
      actorSubjectId: "user:admin",
      reason: "Restore the last known-good policy",
      createdAt: "2026-07-28T12:00:00.000Z",
    });
    expect(event.type).toBe("rollback");
    expect(event.operationId).toBe("00000000-0000-4000-8000-000000000006");
    expect(event.oldRevision?.revision).toBe(11);
    expect(event.newRevision.revision).toBe(7);
  });
});
