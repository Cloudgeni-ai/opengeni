import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { useAppContext } from "../app-context";
import type { CreatorNames } from "./creator-initials";
import { isPersonalWorkspace } from "./managed-self-context";

const EMPTY_CREATOR_NAMES: CreatorNames = new Map();

const CreatorNamesContext = createContext<CreatorNames>(EMPTY_CREATOR_NAMES);

/**
 * Current names for the people and API keys that create chats in this
 * workspace, so the rail, ⌘K and hover cards name a creator the same way.
 * Empty until loaded, in a Personal workspace, or when the member list is
 * unavailable; callers then fall back to the label frozen with the session.
 */
export function useCreatorNames(): CreatorNames {
  return useContext(CreatorNamesContext);
}

export function CreatorNamesProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const context = useAppContext();
  // Only shared workspaces show who created a chat.
  const enabled = !isPersonalWorkspace(
    context.workspaces?.find((workspace) => workspace.id === workspaceId) ?? null,
    null,
  );
  const [names, setNames] = useState<{ workspaceId: string; byId: CreatorNames } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    Promise.resolve()
      .then(() => context.client.listWorkspaceMembers(workspaceId))
      .then((members) => {
        if (!active) return;
        const byId = new Map<string, string>();
        for (const member of members) {
          const label = member.subjectLabel?.trim();
          if (label) byId.set(member.subjectId, label);
        }
        setNames({ workspaceId, byId });
      })
      // Live names only improve on the frozen labels; never block the rail.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [context.client, workspaceId, enabled]);
  const value = enabled && names?.workspaceId === workspaceId ? names.byId : EMPTY_CREATOR_NAMES;
  return <CreatorNamesContext.Provider value={value}>{children}</CreatorNamesContext.Provider>;
}
