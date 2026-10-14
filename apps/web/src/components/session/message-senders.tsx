import { MessageSenderLabel, type RenderMessageSender } from "@opengeni/react";
import type { WorkspaceMember } from "@opengeni/sdk";
import { useCallback, useEffect, useState } from "react";

type MembersClient = { listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> };

/**
 * Names the person behind each message someone else sent in this workspace.
 * Your own messages stay unlabeled, so a chat only you write in looks as it
 * always has. A sender is named from the workspace's members, falling back to
 * the label frozen with the message.
 */
export function useMessageSenderRenderer(
  client: MembersClient,
  workspaceId: string,
  viewerSubjectId: string,
): RenderMessageSender {
  const [names, setNames] = useState<{ workspaceId: string; byId: Map<string, string> } | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    client
      .listWorkspaceMembers(workspaceId)
      .then((members) => {
        if (!active) return;
        const byId = new Map<string, string>();
        for (const member of members) {
          const label = member.subjectLabel?.trim();
          if (label) byId.set(member.subjectId, label);
        }
        setNames({ workspaceId, byId });
      })
      // Members are only a nicer name; the frozen label still identifies them.
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, workspaceId]);
  const byId = names?.workspaceId === workspaceId ? names.byId : null;
  return useCallback<RenderMessageSender>(
    (sender) => {
      if (sender.subjectId === viewerSubjectId) return null;
      const name = byId?.get(sender.subjectId) ?? sender.label;
      return name ? <MessageSenderLabel name={name} /> : null;
    },
    [byId, viewerSubjectId],
  );
}
