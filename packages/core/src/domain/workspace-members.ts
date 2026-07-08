// Pure, HTTP-shaped guard helpers for the workspace member + workspace delete
// routes. Kept out of the route bodies so the don't-orphan rules (never remove
// the last admin, never delete an account's last workspace or one with a live
// session) are unit-testable without a database.
import type { Permission, WorkspaceMember } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";

/** The membership permission that grants member-management (admin is the wildcard). */
const MEMBER_ADMIN_PERMISSIONS: Permission[] = ["workspace:admin", "members:manage"];

/** A member can manage other members (directly or via the admin wildcard). */
export function memberCanAdminister(member: Pick<WorkspaceMember, "permissions">): boolean {
  return member.permissions.some((permission) => MEMBER_ADMIN_PERMISSIONS.includes(permission));
}

/** Only `user:` subjects are people; `api_key:` subjects belong to API keys. */
export function isUserMember(member: Pick<WorkspaceMember, "subjectId">): boolean {
  return member.subjectId.startsWith("user:");
}

/**
 * Turn an email lookup result into the membership subject id. A null id means
 * no registered user matched the email — email invites for not-yet-registered
 * users are deferred, so that is a 404 (not a 400) at the API surface.
 */
export function resolveMemberSubjectId(userId: string | null): string {
  if (!userId) {
    throw new HTTPException(404, { message: "user is not registered" });
  }
  return `user:${userId}`;
}

/**
 * Guard the member-remove path. Refuses (409) to remove the caller's own
 * membership and refuses to remove the last member that still holds an admin
 * permission, so a workspace can never be orphaned with no one able to manage
 * it. `members` is the full roster (every subject, including api_key ones —
 * an api_key with workspace:admin still counts as an administering subject).
 */
export function assertWorkspaceMemberRemovable(input: {
  members: WorkspaceMember[];
  subjectId: string;
  callerSubjectId: string;
}): void {
  const { members, subjectId, callerSubjectId } = input;
  if (subjectId === callerSubjectId) {
    throw new HTTPException(409, { message: "you cannot remove your own membership" });
  }
  const target = members.find((member) => member.subjectId === subjectId);
  if (!target) {
    throw new HTTPException(404, { message: "member not found" });
  }
  if (memberCanAdminister(target)) {
    const remainingAdmins = members.filter(
      (member) => member.subjectId !== subjectId && memberCanAdminister(member),
    );
    if (remainingAdmins.length === 0) {
      throw new HTTPException(409, {
        message: "cannot remove the last member who can manage this workspace",
      });
    }
  }
}

/**
 * Guard the workspace-delete path before any external/DB mutation. Refuses
 * (409) to delete the account's last workspace, and refuses while any session
 * could still be running in Temporal (there is no clean per-session terminate
 * to call first, so we will not orphan a workflow — the operator must stop the
 * sessions first).
 */
export function assertWorkspaceDeletable(input: {
  workspaceCountForAccount: number;
  activeSessionCount: number;
}): void {
  if (input.workspaceCountForAccount <= 1) {
    throw new HTTPException(409, { message: "cannot delete the account's only workspace" });
  }
  if (input.activeSessionCount > 0) {
    throw new HTTPException(409, {
      message: "stop the workspace's running sessions before deleting it",
    });
  }
}
