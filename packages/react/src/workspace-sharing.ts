// Whether a connection made in a workspace could be shared with anyone. A
// person alone in their workspace has nobody to share with, so connect cards
// connect their own account without asking who may use it.
import type { AccessContext, WorkspaceMember } from "@opengeni/sdk";
import { useEffect, useState } from "react";

export type WorkspaceSharingClient = {
  listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  getAccessContext(): Promise<SharingViewer>;
};

/** Who is looking at the card, as far as sharing is concerned. */
export type SharingViewer = Pick<AccessContext, "subjectId"> &
  Partial<Pick<AccessContext, "mode" | "credential">>;

/** Membership changes rarely while a card is open; reuse one read briefly. */
const CACHE_MS = 60_000;
const cache = new WeakMap<object, Map<string, { at: number; value: Promise<boolean> }>>();

/**
 * True only when the signed-in person is the workspace's only person. Unknown
 * (a failed read, or a principal that is not a person) is false, so the card
 * keeps asking rather than guessing.
 */
export function workspaceHasNobodyToShareWith(
  client: WorkspaceSharingClient,
  workspaceId: string,
  now: () => number = Date.now,
): Promise<boolean> {
  let byWorkspace = cache.get(client);
  if (!byWorkspace) {
    byWorkspace = new Map();
    cache.set(client, byWorkspace);
  }
  const cached = byWorkspace.get(workspaceId);
  if (cached && now() - cached.at < CACHE_MS) return cached.value;
  const value = Promise.resolve()
    .then(() => Promise.all([client.listWorkspaceMembers(workspaceId), client.getAccessContext()]))
    .then(([members, access]) => soleWorkspacePerson(members, access))
    .catch(() => false);
  byWorkspace.set(workspaceId, { at: now(), value });
  return value;
}

/**
 * People are `user:` subjects, and on a local install the one local person
 * signed in without a key. API keys and other principals are not someone to
 * share with.
 */
export function soleWorkspacePerson(
  members: readonly Pick<WorkspaceMember, "subjectId">[],
  viewer: SharingViewer,
): boolean {
  const viewerIsPerson =
    viewer.subjectId.startsWith("user:") || (viewer.mode === "local" && !viewer.credential);
  if (!viewerIsPerson) return false;
  const people = members.filter(
    (member) => member.subjectId === viewer.subjectId || member.subjectId.startsWith("user:"),
  );
  return people.length > 0 && people.every((member) => member.subjectId === viewer.subjectId);
}

/** {@link workspaceHasNobodyToShareWith} for a component; false until known. */
export function useNobodyToShareWith(
  client: WorkspaceSharingClient | null | undefined,
  workspaceId: string,
): boolean {
  const [known, setKnown] = useState<{ workspaceId: string; alone: boolean } | null>(null);
  useEffect(() => {
    if (!client) return;
    let active = true;
    void workspaceHasNobodyToShareWith(client, workspaceId).then((alone) => {
      if (active) setKnown({ workspaceId, alone });
    });
    return () => {
      active = false;
    };
  }, [client, workspaceId]);
  return known?.workspaceId === workspaceId && known.alone;
}
