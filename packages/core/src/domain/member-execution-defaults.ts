import {
  WorkspaceDefaultExecutionTarget,
  type WorkspaceDefaultExecutionTarget as WorkspaceDefaultExecutionTargetValue,
} from "@opengeni/contracts";
import {
  getEnrollment,
  getSandbox,
  getWorkspaceMemberExecutionDefault,
  type Database,
} from "@opengeni/db";

type MemberAccess = { accountId: string; workspaceId: string; subjectId: string };

export type MemberExecutionPlacementSettings = {
  sandboxOwnershipEnabled: boolean;
  sandboxSelfhostedEnabled: boolean;
  sandboxBackend: string;
};

export type MemberExecutionDefault = {
  /** What the person saved, or null when they follow the workspace default. */
  target: WorkspaceDefaultExecutionTargetValue | null;
  /**
   * Whether new chats can start there now. A machine that was removed, revoked
   * or is no longer visible to the person is unusable, and their new chats
   * follow the workspace default until they choose again.
   */
  usable: boolean;
};

/**
 * Whether one person's own default can place their new chats. Any active
 * Connected Machine the person can see qualifies, including their own Only me
 * machine: the scoped lookup returns a personal machine to its owner alone, and
 * chats that start on it still ask for the owner's personal-machine consent.
 */
export async function memberExecutionTargetUsable(
  db: Database,
  settings: MemberExecutionPlacementSettings,
  access: MemberAccess,
  target: WorkspaceDefaultExecutionTargetValue,
): Promise<boolean> {
  if (target.kind === "managed") {
    return !["selfhosted", "none"].includes(settings.sandboxBackend);
  }
  if (!settings.sandboxOwnershipEnabled || !settings.sandboxSelfhostedEnabled) return false;
  const machine = await getSandbox(db, access, target.targetSandboxId);
  if (!machine || machine.kind !== "selfhosted" || !machine.enrollmentId) return false;
  const enrollment = await getEnrollment(db, access, machine.enrollmentId);
  return enrollment?.status === "active";
}

/** The person's own default in this workspace and whether it can be used now. */
export async function resolveMemberExecutionDefault(
  db: Database,
  settings: MemberExecutionPlacementSettings,
  access: MemberAccess,
): Promise<MemberExecutionDefault> {
  const row = await getWorkspaceMemberExecutionDefault(db, {
    workspaceId: access.workspaceId,
    subjectId: access.subjectId,
  });
  if (!row) return { target: null, usable: false };
  // A malformed stored value reads as unset: the workspace default applies.
  const parsed = WorkspaceDefaultExecutionTarget.safeParse(row.target);
  if (!parsed.success) return { target: null, usable: false };
  return {
    target: parsed.data,
    usable: await memberExecutionTargetUsable(db, settings, access, parsed.data),
  };
}
