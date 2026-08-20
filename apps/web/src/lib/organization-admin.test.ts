import { describe, expect, test } from "bun:test";

import {
  beginOrganizationAdminOperation,
  canInviteOrganizationRole,
  maskedOrganizationSubject,
  organizationMemberCapabilities,
  ownsOrganizationAdminOperation,
  retentionPolicySummary,
  validRetentionDays,
  type OrganizationAdminIdentity,
} from "./organization-admin";

const identityA: OrganizationAdminIdentity = {
  principalGeneration: 4,
  subjectId: "user:actor-a",
  organizationId: "org-a",
  workspaceId: "workspace-a",
};

describe("organization administration authority", () => {
  test("mirrors the owner/admin/member action matrix", () => {
    expect(organizationMemberCapabilities("owner", { role: "admin", status: "active" })).toEqual({
      canChangeRole: true,
      allowedRoles: ["owner", "admin", "member"],
      canSuspend: true,
      canReactivate: false,
      canOffboard: true,
    });
    expect(organizationMemberCapabilities("admin", { role: "admin", status: "active" })).toEqual({
      canChangeRole: false,
      allowedRoles: [],
      canSuspend: false,
      canReactivate: false,
      canOffboard: false,
    });
    expect(
      organizationMemberCapabilities("admin", { role: "member", status: "suspended" }),
    ).toMatchObject({ canReactivate: true, canOffboard: true, canSuspend: false });
    expect(
      organizationMemberCapabilities("member", { role: "member", status: "active" }),
    ).toMatchObject({
      canChangeRole: false,
      canSuspend: false,
      canReactivate: false,
      canOffboard: false,
    });
    expect(canInviteOrganizationRole("admin", "member")).toBe(true);
    expect(canInviteOrganizationRole("admin", "owner")).toBe(false);
    expect(canInviteOrganizationRole("owner", "admin")).toBe(true);
  });

  test("fences A to B transitions and overlapping operations independently", () => {
    const first = beginOrganizationAdminOperation({
      identity: identityA,
      resource: "members",
      previousSequence: 0,
    });
    const second = beginOrganizationAdminOperation({
      identity: identityA,
      resource: "members",
      previousSequence: first.sequence,
    });
    const identityB = { ...identityA, organizationId: "org-b", workspaceId: "workspace-b" };
    expect(
      ownsOrganizationAdminOperation({
        currentIdentity: identityA,
        currentOperation: second,
        accepted: first,
      }),
    ).toBe(false);
    expect(
      ownsOrganizationAdminOperation({
        currentIdentity: identityB,
        currentOperation: second,
        accepted: second,
      }),
    ).toBe(false);
    const invitations = beginOrganizationAdminOperation({
      identity: identityA,
      resource: "admin-invitations",
      previousSequence: 0,
    });
    expect(
      ownsOrganizationAdminOperation({
        currentIdentity: identityA,
        currentOperation: invitations,
        accepted: invitations,
      }),
    ).toBe(true);
  });

  test("uses a stable masked identifier and validates retention bounds", () => {
    expect(maskedOrganizationSubject("user:one")).toBe(maskedOrganizationSubject("user:one"));
    expect(maskedOrganizationSubject("user:one")).not.toContain("user:one");
    expect(maskedOrganizationSubject("user:one")).not.toBe(maskedOrganizationSubject("user:two"));
    expect(validRetentionDays(30)).toBe(true);
    expect(validRetentionDays(90)).toBe(true);
    expect(validRetentionDays(29)).toBe(false);
    expect(validRetentionDays(91)).toBe(false);
    expect(retentionPolicySummary({ mode: "retain", retentionDays: null })).toContain(
      "indefinitely",
    );
    expect(retentionPolicySummary({ mode: "delete_after", retentionDays: 45 })).toContain(
      "operator cleanup after 45 days",
    );
  });
});
