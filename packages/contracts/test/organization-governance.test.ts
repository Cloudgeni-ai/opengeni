import { describe, expect, test } from "bun:test";
import {
  ApproveOrganizationRecoveryRequest,
  OrganizationRecoveryOperation,
  SetOrganizationRecoveryPolicyRequest,
} from "../src/index";

describe("organization governance contracts", () => {
  test("requires distinct custodians and a satisfiable quorum", () => {
    expect(
      SetOrganizationRecoveryPolicyRequest.safeParse({
        expectedGovernanceRevision: 0,
        quorum: 2,
        custodians: [{ subjectId: "user:a" }, { subjectId: "user:a" }],
        idempotencyKey: "policy-1",
      }).success,
    ).toBe(false);
    expect(
      SetOrganizationRecoveryPolicyRequest.safeParse({
        expectedGovernanceRevision: 0,
        quorum: 3,
        custodians: [{ subjectId: "user:a" }, { subjectId: "user:b" }],
        idempotencyKey: "policy-1",
      }).success,
    ).toBe(false);
  });

  test("bounds sensitive evidence by UTF-8 bytes", () => {
    expect(
      ApproveOrganizationRecoveryRequest.safeParse({
        evidence: "é".repeat(2_049),
        idempotencyKey: "approval-1",
      }).success,
    ).toBe(false);
  });

  test("operation projections cannot expose ciphertext or plaintext evidence", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000001",
      accountId: "00000000-0000-4000-8000-000000000002",
      state: "pending",
      governanceRevision: 2,
      policyRevision: 1,
      quorum: 1,
      approvalCount: 1,
      approvals: [
        {
          subjectId: "user:a",
          evidenceExpiresAt: new Date().toISOString(),
          revokedAt: null,
          consumedAt: null,
          createdAt: new Date().toISOString(),
          evidenceCiphertext: "must-not-leak",
        },
      ],
      expiresAt: new Date().toISOString(),
      finalizedAt: null,
      cancelledAt: null,
      createdAt: new Date().toISOString(),
    };
    expect(OrganizationRecoveryOperation.safeParse(base).success).toBe(false);
  });
});
