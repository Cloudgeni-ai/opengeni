import { describe, expect, test } from "bun:test";
import { OrganizationInvitation } from "../src";

describe("organization membership lifecycle contracts", () => {
  test("projects invitation receipts without exposing registration state", () => {
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
    ).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-000000000002",
      organizationName: null,
      targetEmail: "existing@example.test",
      targetName: null,
      initialWorkspaceIds: [],
      role: "member",
      status: "pending",
      revision: 1,
      expiresAt: "2026-08-22T12:00:00.000Z",
      acceptedMembershipId: null,
      createdAt: "2026-08-21T12:00:00.000Z",
      updatedAt: "2026-08-21T12:00:00.000Z",
    });
  });
});
