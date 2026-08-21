import { describe, expect, test } from "bun:test";
import { OrganizationInvitation } from "../src";

describe("organization membership lifecycle contracts", () => {
  test("projects pre-0313 invitation receipts with registered defaults", () => {
    expect(
      OrganizationInvitation.parse({
        id: "00000000-0000-4000-8000-000000000001",
        organizationId: "00000000-0000-4000-8000-000000000002",
        targetEmail: "existing@example.test",
        role: "member",
        status: "pending",
        revision: 1,
        expiresAt: "2026-08-22T12:00:00.000Z",
        acceptedMembershipId: null,
        createdAt: "2026-08-21T12:00:00.000Z",
        updatedAt: "2026-08-21T12:00:00.000Z",
      }),
    ).toMatchObject({
      targetName: null,
      targetRegistrationStatus: "registered",
      initialWorkspaceIds: [],
    });
  });
});
