import { describe, expect, test } from "bun:test";
import type { WorkspaceMember } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import {
  assertWorkspaceDeletable,
  assertWorkspaceMemberRemovable,
  isUserMember,
  memberCanAdminister,
  resolveMemberSubjectId,
} from "@opengeni/core";

function member(overrides: Partial<WorkspaceMember> & Pick<WorkspaceMember, "subjectId">): WorkspaceMember {
  return {
    subjectLabel: null,
    role: "member",
    permissions: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function statusOf(fn: () => void): number | "no-throw" {
  try {
    fn();
    return "no-throw";
  } catch (error) {
    if (error instanceof HTTPException) {
      return error.status;
    }
    throw error;
  }
}

describe("workspace member helpers", () => {
  test("isUserMember keeps only user: subjects", () => {
    expect(isUserMember(member({ subjectId: "user:u1" }))).toBe(true);
    expect(isUserMember(member({ subjectId: "api_key:k1" }))).toBe(false);
  });

  test("memberCanAdminister recognizes admin and members:manage (admin is the wildcard)", () => {
    expect(memberCanAdminister(member({ subjectId: "user:a", permissions: ["workspace:admin"] }))).toBe(true);
    expect(memberCanAdminister(member({ subjectId: "user:b", permissions: ["members:manage"] }))).toBe(true);
    expect(memberCanAdminister(member({ subjectId: "user:c", permissions: ["sessions:read"] }))).toBe(false);
  });

  test("resolveMemberSubjectId returns subjectId for a known user and 404s for an unknown email", () => {
    expect(resolveMemberSubjectId("u1")).toBe("user:u1");
    expect(statusOf(() => resolveMemberSubjectId(null))).toBe(404);
  });
});

describe("assertWorkspaceMemberRemovable", () => {
  const owner = member({ subjectId: "user:owner", permissions: ["workspace:admin"] });
  const collaborator = member({ subjectId: "user:collab", permissions: ["sessions:read"] });

  test("refuses (409) to remove your own membership", () => {
    expect(statusOf(() => assertWorkspaceMemberRemovable({
      members: [owner, collaborator],
      subjectId: "user:owner",
      callerSubjectId: "user:owner",
    }))).toBe(409);
  });

  test("refuses (409) to remove the last administering member", () => {
    expect(statusOf(() => assertWorkspaceMemberRemovable({
      members: [owner, collaborator],
      subjectId: "user:owner",
      callerSubjectId: "user:collab",
    }))).toBe(409);
  });

  test("allows removing an admin when another admin remains", () => {
    const secondAdmin = member({ subjectId: "user:admin2", permissions: ["members:manage"] });
    expect(statusOf(() => assertWorkspaceMemberRemovable({
      members: [owner, secondAdmin, collaborator],
      subjectId: "user:owner",
      callerSubjectId: "user:admin2",
    }))).toBe("no-throw");
  });

  test("allows removing a non-admin member", () => {
    expect(statusOf(() => assertWorkspaceMemberRemovable({
      members: [owner, collaborator],
      subjectId: "user:collab",
      callerSubjectId: "user:owner",
    }))).toBe("no-throw");
  });

  test("404s when the target is not a member", () => {
    expect(statusOf(() => assertWorkspaceMemberRemovable({
      members: [owner],
      subjectId: "user:ghost",
      callerSubjectId: "user:owner",
    }))).toBe(404);
  });
});

describe("assertWorkspaceDeletable", () => {
  test("refuses (409) to delete the account's only workspace", () => {
    expect(statusOf(() => assertWorkspaceDeletable({ workspaceCountForAccount: 1, activeSessionCount: 0 }))).toBe(409);
  });

  test("refuses (409) while a session is still active", () => {
    expect(statusOf(() => assertWorkspaceDeletable({ workspaceCountForAccount: 3, activeSessionCount: 2 }))).toBe(409);
  });

  test("allows deletion when another workspace exists and no session is active", () => {
    expect(statusOf(() => assertWorkspaceDeletable({ workspaceCountForAccount: 2, activeSessionCount: 0 }))).toBe("no-throw");
  });
});
