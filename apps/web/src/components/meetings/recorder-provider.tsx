// The console's one meeting recorder, mounted above the workspace shell so a
// recording keeps going while the person moves between pages and between
// workspaces, and while a dropped connection or an update reconnects. With the
// console's routes for where a desktop call notification's choice opens.
import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

// The light entry: the capture code loads only when Meetings is first opened.
import { MeetingRecorderProvider } from "@opengeni/react/meetings-recorder";

export function ConsoleMeetingRecorderProvider({
  workspaceId,
  fallbackWorkspaceId,
  client,
  children,
}: {
  /** The workspace shown; null outside a workspace or while it loads. */
  workspaceId: string | null;
  /** Where a desktop call notification opens Meetings outside a workspace. */
  fallbackWorkspaceId: string | null;
  /** The console's SDK client: no <OpenGeniProvider> is mounted this high. */
  client: object;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const meetingsWorkspaceId = workspaceId ?? fallbackWorkspaceId;
  return (
    <MeetingRecorderProvider
      workspaceId={workspaceId}
      client={client}
      onOpenMeetings={
        meetingsWorkspaceId
          ? () =>
              void navigate({
                to: "/workspaces/$workspaceId/meetings",
                params: { workspaceId: meetingsWorkspaceId },
              })
          : undefined
      }
      onOpenMeeting={(recordingId, recordingWorkspaceId) =>
        void navigate({
          to: "/workspaces/$workspaceId/meetings/$recordingId",
          params: { workspaceId: recordingWorkspaceId, recordingId },
        })
      }
    >
      {children}
    </MeetingRecorderProvider>
  );
}
