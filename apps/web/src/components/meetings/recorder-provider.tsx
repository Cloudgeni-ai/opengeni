// The console's one meeting recorder, mounted above the workspace shell so a
// recording keeps going while the person moves between pages and between
// workspaces, and while a dropped connection or an update reconnects. It ends
// at once when they sign out or someone else signs in. With the console's
// routes for where a desktop call notification's choice opens.
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

// The light entry: the capture code loads only when Meetings is first opened.
import {
  MeetingRecorderProvider,
  recordingOwnerKey,
  useMeetingRecorderLostTrack,
  type MeetingRecorderLostTrack,
} from "@opengeni/react/meetings-recorder";

/**
 * Who is signed in, for the recorder: their id, null when nobody is, or
 * undefined while that is being read again (a reconnect, an update, the start
 * of a sign-in change). Undefined keeps the last person known, so only a real
 * sign-out or another person ends a recording.
 */
export function useRecorderPerson(person: string | null | undefined): string | null {
  const [known, setKnown] = useState<string | null>(person ?? null);
  if (person !== undefined && person !== known) setKnown(person);
  return person === undefined ? known : person;
}

export function ConsoleMeetingRecorderProvider({
  workspaceId,
  person,
  owner,
  fallbackWorkspaceId,
  client,
  children,
}: {
  /** The workspace shown; null outside a workspace or while it loads. */
  workspaceId: string | null;
  /** Who is signed in; null when nobody is, undefined while it is being read. */
  person: string | null | undefined;
  /**
   * Their sign-in email, which their recordings on this device are kept
   * under; null when there is none, undefined while it is being read.
   */
  owner?: string | null | undefined;
  /** Where a desktop call notification opens Meetings outside a workspace. */
  fallbackWorkspaceId: string | null;
  /** The console's SDK client: no <OpenGeniProvider> is mounted this high. */
  client: object;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const scope = useRecorderPerson(person);
  const ownerId = recordingOwnerKey(useRecorderPerson(owner));
  const meetingsWorkspaceId = scope === null ? null : (workspaceId ?? fallbackWorkspaceId);
  return (
    <MeetingRecorderProvider
      workspaceId={workspaceId}
      scope={scope}
      ownerId={ownerId}
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
      <LostTrackTabTitle />
    </MeetingRecorderProvider>
  );
}

/** What the tab's title starts with while a track records nothing. */
export function lostTrackTitlePrefix(lost: MeetingRecorderLostTrack): string {
  if (lost.source === "microphone") return "Microphone off · ";
  return lost.systemAudioKind === "desktop" ? "Computer audio off · " : "Tab audio off · ";
}

/**
 * Marks the tab's title while a recording has lost a source, since during a
 * call the person is usually looking at the call's tab, not this one. Pages
 * set their own titles, so the mark is put back when one does.
 */
export function LostTrackTabTitle() {
  const lost = useMeetingRecorderLostTrack();
  const prefix = lost ? lostTrackTitlePrefix(lost) : null;
  useEffect(() => {
    if (!prefix) return;
    const mark = () => {
      // Another mark (a chat that needs attention) may sit in front of it.
      if (!document.title.includes(prefix)) document.title = `${prefix}${document.title}`;
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      document.title = document.title.replace(prefix, "");
    };
  }, [prefix]);
  return null;
}
