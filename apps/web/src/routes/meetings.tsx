// Meetings: the list with the recorder, and each meeting's own page. The pages
// are @opengeni/react/meetings'; these route components own navigation.
import { useNavigate } from "@tanstack/react-router";

import { resolveWorkspaceRecordingSettings } from "@opengeni/contracts";
import { MeetingDetailPage, MeetingsListPage } from "@opengeni/react/meetings";
import { useRecordingsClient } from "@opengeni/react/recordings";
import { useAppContext } from "@opengeni/react/app/app-context";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { meetingViewerName } from "../components/meetings/viewer-name";

import { meetingQuestionMessage } from "@/lib/meeting-ask";

/** The detail page draws its own 960px frame, back link and padding. */
const PAGE_FRAME = "max-w-none px-0 py-0 pb-0 sm:px-0 lg:px-0";

function meetingPath(workspaceId: string, recordingId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/meetings/${encodeURIComponent(recordingId)}`;
}

export function MeetingsRoute({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const context = useAppContext();
  const { workspaces } = context;
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  const settings = resolveWorkspaceRecordingSettings(workspace?.settings);
  const liveTranscript = settings.liveTranscript === true;
  return (
    <ContentPage width="standard" className="pt-6">
      <MeetingsListPage
        workspaceId={workspaceId}
        liveTranscriptDefault={liveTranscript}
        defaultLanguage={settings.language ?? null}
        viewerName={meetingViewerName(context)}
        meetingHref={(recordingId) => meetingPath(workspaceId, recordingId)}
        onOpen={(recordingId) =>
          void navigate({
            to: "/workspaces/$workspaceId/meetings/$recordingId",
            params: { workspaceId, recordingId },
          })
        }
      />
    </ContentPage>
  );
}

export function MeetingDetailRoute({
  workspaceId,
  recordingId,
}: {
  workspaceId: string;
  recordingId: string;
}) {
  const navigate = useNavigate();
  const context = useAppContext();
  const { accessContext, workspaces, startSession } = context;
  const { client: recordings } = useRecordingsClient({ workspaceId });
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  const voiceRecognition =
    resolveWorkspaceRecordingSettings(workspace?.settings).voiceprints === true;
  // "Ask about this meeting" starts a normal chat on the person's model, with
  // the question first and the meeting attached for meeting_read.
  const canAsk = hasWorkspacePermission(accessContext, workspaceId, "sessions:create");
  const ask = async (meetingId: string, question: string): Promise<boolean> => {
    const meeting = await recordings.getRecording(workspaceId, meetingId).catch(() => null);
    const created = await startSession(workspaceId, {
      text: meetingQuestionMessage(question, { id: meetingId, title: meeting?.title ?? null }),
    });
    // startSession has already said why it couldn't start; keep the question.
    if (!created) return false;
    await navigate({
      to: "/workspaces/$workspaceId/sessions/$sessionId",
      params: { workspaceId, sessionId: created.id },
    });
    return true;
  };
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <MeetingDetailPage
        key={recordingId}
        workspaceId={workspaceId}
        recordingId={recordingId}
        viewerSubjectId={accessContext.subjectId}
        viewerName={meetingViewerName(context) ?? "Me"}
        voiceRecognition={voiceRecognition}
        onBack={() =>
          void navigate({ to: "/workspaces/$workspaceId/meetings", params: { workspaceId } })
        }
        onOpenSettings={() =>
          void navigate({
            to: "/workspaces/$workspaceId/settings",
            params: { workspaceId },
            search: { section: "general" },
          })
        }
        onOpenChat={(sessionId) =>
          void navigate({
            to: "/workspaces/$workspaceId/sessions/$sessionId",
            params: { workspaceId, sessionId },
          })
        }
        onAsk={canAsk ? ask : undefined}
      />
    </ContentPage>
  );
}
