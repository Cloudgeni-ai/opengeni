// The workspace's meeting recorder, with the console's routes for where a
// desktop call notification's choice opens.
import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { MeetingRecorderProvider } from "@opengeni/react/meetings";

export function ConsoleMeetingRecorderProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <MeetingRecorderProvider
      workspaceId={workspaceId}
      onOpenMeetings={() =>
        void navigate({ to: "/workspaces/$workspaceId/meetings", params: { workspaceId } })
      }
      onOpenMeeting={(recordingId) =>
        void navigate({
          to: "/workspaces/$workspaceId/meetings/$recordingId",
          params: { workspaceId, recordingId },
        })
      }
    >
      {children}
    </MeetingRecorderProvider>
  );
}
