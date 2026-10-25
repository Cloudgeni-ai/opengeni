// Automations: the list, each automation's own page, the New / Edit /
// Duplicate form pages, the templates they can start from, and the event
// sources their triggers listen to. The pages live in components/schedules;
// these route components own the scroll frame and the legacy deep links.
import { Navigate } from "@tanstack/react-router";

import { AutomationTemplatesPage } from "@/components/schedules/automation-templates-page";
import { EventSourceDetailPage } from "@/components/schedules/event-source-detail-page";
import { EventSourceNewPage } from "@/components/schedules/event-source-new-page";
import { EventSourcesPage } from "@/components/schedules/event-sources-page";
import { ScheduleDetailPage } from "@/components/schedules/schedule-detail-page";
import { ScheduleFormPage, type ScheduleFormMode } from "@/components/schedules/schedule-form-page";
import { SchedulesListPage } from "@/components/schedules/schedules-list-page";
import { ContentPage } from "@opengeni/react/ui/content-layout";

/** Detail and form pages draw their own 960px frame, back link and padding. */
const PAGE_FRAME = "max-w-none px-0 py-0 pb-0 sm:px-0 lg:px-0";

export function AutomationsRoute({
  workspaceId,
  sourceSessionId,
  focusTaskId,
  targetSessionId,
}: {
  workspaceId: string;
  /** "Make recurring" from a chat (Slack cards link here): opens New automation. */
  sourceSessionId?: string;
  /** Arrived from a chat an automation started: opens that automation's page. */
  focusTaskId?: string;
  /** Only the automations that post into this chat. */
  targetSessionId?: string;
}) {
  if (sourceSessionId) {
    return (
      <Navigate
        to="/workspaces/$workspaceId/automations/new"
        params={{ workspaceId }}
        search={{ sourceSessionId }}
        replace
      />
    );
  }
  if (focusTaskId) {
    return (
      <Navigate
        to="/workspaces/$workspaceId/automations/$automationId"
        params={{ workspaceId, automationId: focusTaskId }}
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

export function AutomationDetailRoute({
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

export function AutomationFormRoute({
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

export function EventSourcesRoute({ workspaceId }: { workspaceId: string }) {
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <EventSourcesPage workspaceId={workspaceId} />
    </ContentPage>
  );
}

export function AutomationTemplatesRoute({ workspaceId }: { workspaceId: string }) {
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <AutomationTemplatesPage workspaceId={workspaceId} />
    </ContentPage>
  );
}

export function EventSourceNewRoute({
  workspaceId,
  kind,
}: {
  workspaceId: string;
  /** Preselects what is being added, from a link like "Add a GitHub source". */
  kind?: string;
}) {
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <EventSourceNewPage workspaceId={workspaceId} kind={kind} />
    </ContentPage>
  );
}

export function EventSourceDetailRoute({
  workspaceId,
  sourceId,
}: {
  workspaceId: string;
  sourceId: string;
}) {
  return (
    <ContentPage width="standard" className={PAGE_FRAME}>
      <EventSourceDetailPage key={sourceId} workspaceId={workspaceId} sourceId={sourceId} />
    </ContentPage>
  );
}
