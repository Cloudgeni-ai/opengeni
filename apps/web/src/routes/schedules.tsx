// Schedules: the list, each schedule's own page, and the New / Edit /
// Duplicate form pages. The pages live in components/schedules; these route
// components own the scroll frame and the legacy deep links.
import { Navigate } from "@tanstack/react-router";

import { ScheduleDetailPage } from "@/components/schedules/schedule-detail-page";
import { ScheduleFormPage, type ScheduleFormMode } from "@/components/schedules/schedule-form-page";
import { SchedulesListPage } from "@/components/schedules/schedules-list-page";
import { ContentPage } from "@/components/ui/content-layout";

/** Detail and form pages draw their own 960px frame, back link and padding. */
const PAGE_FRAME = "max-w-none px-0 py-0 pb-0 sm:px-0 lg:px-0";

export function SchedulesRoute({
  workspaceId,
  sourceSessionId,
  focusTaskId,
  targetSessionId,
}: {
  workspaceId: string;
  /** "Make recurring" from a chat (Slack cards link here): opens New schedule. */
  sourceSessionId?: string;
  /** Arrived from a chat a schedule started: opens that schedule's page. */
  focusTaskId?: string;
  /** Only the schedules that post into this chat. */
  targetSessionId?: string;
}) {
  if (sourceSessionId) {
    return (
      <Navigate
        to="/workspaces/$workspaceId/schedules/new"
        params={{ workspaceId }}
        search={{ sourceSessionId }}
        replace
      />
    );
  }
  if (focusTaskId) {
    return (
      <Navigate
        to="/workspaces/$workspaceId/schedules/$scheduleId"
        params={{ workspaceId, scheduleId: focusTaskId }}
        replace
      />
    );
  }
  return (
    <ContentPage width="standard" className="pt-6">
      <SchedulesListPage
        key={targetSessionId ?? "all"}
        workspaceId={workspaceId}
        targetSessionId={targetSessionId}
      />
    </ContentPage>
  );
}

export function ScheduleDetailRoute({
  workspaceId,
  scheduleId,
}: {
  workspaceId: string;
  scheduleId: string;
}) {
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <ScheduleDetailPage key={scheduleId} workspaceId={workspaceId} scheduleId={scheduleId} />
    </ContentPage>
  );
}

export function ScheduleFormRoute({
  workspaceId,
  mode,
}: {
  workspaceId: string;
  mode: ScheduleFormMode;
}) {
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <ScheduleFormPage workspaceId={workspaceId} mode={mode} />
    </ContentPage>
  );
}
