import { describe, expect, test } from "bun:test";
import {
  ConfigureOrganizationRecoveryPolicyRequest,
  OrganizationRecoveryOverview,
  OrganizationRecoveryOperationCommandRequest,
} from "../src/organization-recovery";

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;

describe("organization recovery contracts", () => {
  test("requires exactly three distinct custodian memberships and strict bodies", () => {
    expect(
      ConfigureOrganizationRecoveryPolicyRequest.safeParse({
        custodianMembershipIds: ids,
        expectedPolicyRevision: 0,
        operationId: "00000000-0000-4000-8000-000000000004",
      }).success,
    ).toBe(true);
    expect(
      ConfigureOrganizationRecoveryPolicyRequest.safeParse({
        custodianMembershipIds: [ids[0], ids[0], ids[2]],
        expectedPolicyRevision: 0,
        operationId: "00000000-0000-4000-8000-000000000004",
      }).success,
    ).toBe(false);
    expect(
      OrganizationRecoveryOperationCommandRequest.safeParse({
        expectedOperationRevision: 1,
        operationId: "00000000-0000-4000-8000-000000000004",
        accountId: ids[0],
      }).success,
    ).toBe(false);
  });

  test("keeps unavailable recovery explicit and capabilities server-owned", () => {
    expect(
      OrganizationRecoveryOverview.parse({
        organizationId: ids[0],
        availability: "recovery_unavailable",
        unavailableReason: "no_policy",
        recentReauthenticationAt: null,
        eligibleMembers: [],
        policy: null,
        operation: null,
        capabilities: {
          configure: true,
          accept: false,
          disable: false,
          start: false,
          approve: false,
          cancel: false,
          execute: false,
        },
      }).availability,
    ).toBe("recovery_unavailable");
  });
});
