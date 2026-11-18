/**
 * Names for creators frozen without one, read when a row is drawn.
 *
 * Chats started outside the app (Slack, Teams, an API call for someone)
 * before their creator's label was frozen at creation carry only a subject
 * id. The sidebar never shows an id fragment, so such a person is named here:
 * the signed-in person from their own access context (the label the app
 * freezes for them), anyone else from the workspace's members. One members
 * read per workspace is shared by every row. Display only.
 */
import { useEffect, useState } from "react";
import type { WorkspaceMember } from "@opengeni/sdk";

import { useOptionalAppContext } from "../app-context";
import { creatorType, type CreatorRef } from "./creator-initials";

type MembersClient = { listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> };

type MemberLabels = ReadonlyMap<string, string>;

// One read per workspace, shared by every row; an entry belongs to the
// client that read it, so another account or access key reads again.
const memberLabelCache = new Map<string, { client: object; pending: Promise<MemberLabels> }>();

/** Forget cached member names (tests; a later read fetches them again). */
export function forgetCreatorLabels(): void {
  memberLabelCache.clear();
}

function memberLabels(client: MembersClient, workspaceId: string): Promise<MemberLabels> {
  const cached = memberLabelCache.get(workspaceId);
  if (cached && cached.client === client) return cached.pending;
  const pending = client.listWorkspaceMembers(workspaceId).then(
    (members) => {
      const labels = new Map<string, string>();
      for (const member of members) {
        const label = member.subjectLabel?.trim();
        if (label) labels.set(member.subjectId, label);
      }
      return labels as MemberLabels;
    },
    () => {
      // Unreadable now: no names, and ask again next time.
      if (memberLabelCache.get(workspaceId)?.pending === pending) {
        memberLabelCache.delete(workspaceId);
      }
      return new Map() as MemberLabels;
    },
  );
  memberLabelCache.set(workspaceId, { client, pending });
  return pending;
}

/** Whether a creator is a person the app has no frozen name for. */
export function creatorNeedsLabel(createdBy: CreatorRef | null | undefined): boolean {
  return Boolean(
    createdBy &&
    createdBy.kind === "subject" &&
    creatorType(createdBy) === "person" &&
    !createdBy.label?.trim(),
  );
}

/**
 * The creator with a name filled in when it was frozen without one: the
 * signed-in person's own label, else the member's name once members load.
 * Unchanged otherwise, and unchanged while no name is known.
 */
export function resolveCreatorLabel(
  createdBy: CreatorRef | null,
  self: { subjectId: string; subjectLabel?: string | undefined } | null,
  members: MemberLabels | null,
): CreatorRef | null {
  if (!createdBy || !creatorNeedsLabel(createdBy)) return createdBy;
  const own =
    self && self.subjectId === createdBy.subjectId ? self.subjectLabel?.trim() || null : null;
  const label = own ?? members?.get(createdBy.subjectId) ?? null;
  return label ? { ...createdBy, label } : createdBy;
}

/** {@link resolveCreatorLabel} for a row in a workspace, reading members only when needed. */
export function useResolvedCreator(
  workspaceId: string,
  createdBy: CreatorRef | null,
): CreatorRef | null {
  const context = useOptionalAppContext();
  const self = context?.accessContext ?? null;
  const ownMatch =
    createdBy !== null &&
    self !== null &&
    self.subjectId === createdBy.subjectId &&
    Boolean(self.subjectLabel?.trim());
  const needsMembers = creatorNeedsLabel(createdBy) && !ownMatch;
  const client = needsMembers ? (context?.client ?? null) : null;
  const [loaded, setLoaded] = useState<{ workspaceId: string; labels: MemberLabels } | null>(null);
  useEffect(() => {
    if (!client || typeof client.listWorkspaceMembers !== "function") return;
    let live = true;
    void memberLabels(client, workspaceId).then((labels) => {
      if (live) setLoaded({ workspaceId, labels });
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  const members = loaded?.workspaceId === workspaceId ? loaded.labels : null;
  return resolveCreatorLabel(createdBy, self, members);
}
