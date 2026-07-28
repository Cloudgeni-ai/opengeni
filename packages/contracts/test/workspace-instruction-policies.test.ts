import { describe, expect, test } from "bun:test";
import {
  CreateWorkspaceInstructionPolicyDraftRequest,
  WorkspaceInstructionPolicyActivationEvent,
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

  test("requires complete immutable activation audit evidence", () => {
    const event = WorkspaceInstructionPolicyActivationEvent.parse({
      id: "00000000-0000-4000-8000-000000000001",
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
    expect(event.oldRevision?.revision).toBe(11);
    expect(event.newRevision.revision).toBe(7);
  });
});
