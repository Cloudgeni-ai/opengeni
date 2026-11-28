/**
 * Who can open a meeting, decided once for the meeting page's Share menu and
 * for agents (meeting_update), so both send the same PATCH request to
 * `…/recordings/:recordingId` and refuse the same choices.
 *
 * A meeting is Only me, or shared with one workspace. One that a team
 * workspace stores is shared only there. One stored in its owner's Personal
 * workspace, where nobody else sees it, is shared with one of their team
 * workspaces where they may start work.
 */

/** One of the person's own workspaces of the organization. */
export type MeetingSharingWorkspace = {
  id: string;
  /** Their Personal workspace. */
  personal?: boolean | undefined;
  /** False where they can't start work, so can't share a meeting with it. */
  shareable?: boolean | undefined;
};

/** The meeting, as far as sharing it goes. */
export type MeetingSharingMeeting = {
  /** The workspace that stores it. */
  workspaceId: string;
  visibility: "private" | "workspace";
  /** The team workspace a Personal-workspace meeting is shared with, if any. */
  sharedWorkspaceId?: string | null | undefined;
  /** Where an Only me meeting works; null for everywhere, undefined when unknown. */
  reachWorkspaceIds?: readonly string[] | null | undefined;
};

/**
 * The workspaces a meeting can be shared with, and the one it is shared with
 * now (null for Only me, or shared where nobody else sees it). `workspaces`
 * is undefined when the host doesn't know the person's workspaces.
 */
export function meetingSharingTargets(
  meeting: MeetingSharingMeeting,
  workspaces: readonly MeetingSharingWorkspace[] | undefined,
): { targets: string[]; current: string | null; personal: boolean } {
  const storing = meeting.workspaceId;
  const personal = workspaces?.find((workspace) => workspace.id === storing)?.personal === true;
  const targets = personal
    ? (workspaces ?? [])
        .filter(
          (workspace) =>
            workspace.personal !== true &&
            // Where it is shared stays listed, so the menu says so.
            (workspace.shareable !== false || workspace.id === meeting.sharedWorkspaceId),
        )
        .map((workspace) => workspace.id)
    : [storing];
  // Shared in the Personal workspace that stores it, or with a workspace its
  // owner has left, nobody else sees it.
  const sharedWith = meeting.sharedWorkspaceId ?? (personal ? null : storing);
  const current =
    meeting.visibility !== "private" && sharedWith !== null && targets.includes(sharedWith)
      ? sharedWith
      : null;
  return { targets, current, personal };
}

/** The body of the recording's PATCH that makes the change. */
export type MeetingSharingRequest = {
  visibility: "workspace" | "private";
  sharedWorkspaceId?: string;
  reachWorkspaceIds?: string[];
};

export type MeetingSharingDecision =
  | {
      ok: true;
      request: MeetingSharingRequest;
      /** Shared with another workspace, it shows there and no longer where it is viewed. */
      leavesHere: boolean;
    }
  | {
      ok: false;
      /**
       * not_shareable: it can't be shared with that workspace (`because` says
       * why); not_allowed: the person can't share meetings with it.
       */
      code: "not_shareable" | "not_allowed";
      because?: "personal_workspace" | "other_workspace";
    };

/**
 * The request that shares a meeting with `target`, or makes it Only me when
 * `target` is null, as seen from `viewingWorkspaceId`; or why it can't.
 */
export function meetingSharingDecision(input: {
  target: string | null;
  meeting: MeetingSharingMeeting;
  viewingWorkspaceId: string;
  workspaces: readonly MeetingSharingWorkspace[] | undefined;
}): MeetingSharingDecision {
  const { target, meeting, viewingWorkspaceId: viewing, workspaces } = input;
  const storing = meeting.workspaceId;
  if (target === null) {
    // Only me again: it keeps working where the owner is looking from.
    const reach = meeting.reachWorkspaceIds;
    const keepHere =
      viewing !== storing &&
      Array.isArray(reach) &&
      !reach.includes(viewing) &&
      workspaces?.find((workspace) => workspace.id === viewing)?.personal !== true;
    return {
      ok: true,
      request: {
        visibility: "private",
        ...(keepHere && reach ? { reachWorkspaceIds: [...reach, viewing] } : {}),
      },
      leavesHere: false,
    };
  }
  const { targets, personal } = meetingSharingTargets(meeting, workspaces);
  if (!targets.includes(target)) {
    if (!personal && target !== storing) {
      return { ok: false, code: "not_shareable", because: "other_workspace" };
    }
    const workspace = workspaces?.find((candidate) => candidate.id === target);
    // A team workspace where the person can't start work, or not theirs.
    if (personal && target !== storing && workspace?.personal !== true) {
      return { ok: false, code: "not_allowed" };
    }
    return { ok: false, code: "not_shareable", because: "personal_workspace" };
  }
  return {
    ok: true,
    request:
      target === storing && viewing === storing
        ? { visibility: "workspace" }
        : { visibility: "workspace", sharedWorkspaceId: target },
    leavesHere: viewing !== storing && target !== viewing,
  };
}
