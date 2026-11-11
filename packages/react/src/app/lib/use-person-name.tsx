import { useCallback, useEffect, useState } from "react";

import { useAppContext } from "../app-context";

/**
 * Who a subject (`user:<id>`) is, for "Version 3 · by Ada": "you" for the
 * signed-in person, else the workspace member's name. Null until known, or
 * when they aren't a member here; callers then say "a person" or similar.
 */
export function usePersonName(
  workspaceId: string,
  enabled = true,
): (subjectId: string) => string | null {
  const context = useAppContext();
  const selfSubjectId = context.accessContext.subjectId;
  const [names, setNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void context.client
      .listWorkspaceMembers(workspaceId)
      .then((members) => {
        if (!active) return;
        setNames(
          new Map(
            members.map((member) => [
              member.subjectId,
              member.subjectLabel?.trim() || member.subjectId.replace(/^(user|service):/, ""),
            ]),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [context.client, workspaceId, enabled]);
  return useCallback(
    (subjectId: string) => (subjectId === selfSubjectId ? "you" : (names.get(subjectId) ?? null)),
    [names, selfSubjectId],
  );
}
