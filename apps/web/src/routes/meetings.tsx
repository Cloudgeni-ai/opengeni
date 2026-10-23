// Meetings: the list with the recorder, and each meeting's own page. The pages
// live in components/meetings; these route components own navigation.
import { useNavigate } from "@tanstack/react-router";

import { MeetingDetailPage } from "@/components/meetings/meeting-detail-page";
import { MeetingsListPage } from "@/components/meetings/meetings-list-page";
import { useAppContext } from "@opengeni/react/app/app-context";
import { ContentPage } from "@opengeni/react/ui/content-layout";

/** The detail page draws its own 960px frame, back link and padding. */
const PAGE_FRAME = "max-w-none px-0 py-0 pb-0 sm:px-0 lg:px-0";

function meetingPath(workspaceId: string, recordingId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/meetings/${encodeURIComponent(recordingId)}`;
}

export function MeetingsRoute({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  return (
    <ContentPage width="standard" className="pt-6">
      <MeetingsListPage
        workspaceId={workspaceId}
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
  const { accessContext } = useAppContext();
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <MeetingDetailPage
        key={recordingId}
        workspaceId={workspaceId}
        recordingId={recordingId}
        viewerSubjectId={accessContext.subjectId}
        onBack={() =>
          void navigate({ to: "/workspaces/$workspaceId/meetings", params: { workspaceId } })
        }
      />
    </ContentPage>
  );
}
