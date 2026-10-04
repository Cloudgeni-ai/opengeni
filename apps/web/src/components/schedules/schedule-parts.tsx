/**
 * Small pieces the Schedules list and the schedule page share: permissions,
 * links, the tile, the Next run / Last run values, the owner and the row menu.
 */
import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  CopyIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { LogoTile } from "@/components/ui/logo-tile";
import { RelativeTime } from "@/components/ui/relative-time";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAppContext } from "@/context";
import { creatorInitials } from "@/lib/creator-initials";
import { hasWorkspacePermission } from "@/lib/permissions";
import { scheduledTaskStateLabel } from "@/lib/scheduled-tasks";
import { cn } from "@/lib/utils";
import type { ScheduledTask, ScheduledTaskRun } from "@/types";

import {
  isKnowledgeSync,
  nextRunOf,
  ownerName,
  ownsSchedule,
  type LastRunState,
} from "./schedule-model";

/* ----------------------------------------------------------------------------
   Permissions.
   -------------------------------------------------------------------------- */

export interface ScheduleAccess {
  viewerSubjectId: string;
  /** Create, edit, pause, resume and delete (your own). */
  canManage: boolean;
  /** Run now (your own). */
  canRun: boolean;
  /** Run rows carry their chat id only with sessions:control. */
  canReadSessionIds: boolean;
  /** Pick an existing chat as the target. */
  canTargetSessions: boolean;
}

export function useScheduleAccess(workspaceId: string): ScheduleAccess {
  const { accessContext } = useAppContext();
  const can = (permission: Parameters<typeof hasWorkspacePermission>[2]) =>
    hasWorkspacePermission(accessContext, workspaceId, permission);
  const canReadSessionIds = can("sessions:control");
  return {
    viewerSubjectId: accessContext.subjectId,
    canManage: can("scheduled_tasks:manage"),
    canRun: can("scheduled_tasks:run"),
    canReadSessionIds,
    canTargetSessions: can("sessions:read") && canReadSessionIds,
  };
}

/** What this viewer can do with one schedule. */
export function schedulePermissions(task: ScheduledTask, access: ScheduleAccess) {
  const own = ownsSchedule(task, access.viewerSubjectId);
  const knowledge = isKnowledgeSync(task);
  const retired = scheduledTaskStateLabel(task).reason === "provider_retired";
  return {
    own,
    canEdit: own && access.canManage && !retired,
    canRun: own && access.canRun && !retired,
    canPauseOrDelete: own && access.canManage,
    /** Knowledge syncs belong to their source; they aren't copied. */
    canDuplicate: access.canManage && !knowledge && !retired,
  };
}

/* ----------------------------------------------------------------------------
   Links.
   -------------------------------------------------------------------------- */

export function schedulesPath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/schedules`;
}

export function schedulePath(workspaceId: string, scheduleId: string): string {
  return `${schedulesPath(workspaceId)}/${encodeURIComponent(scheduleId)}`;
}

export type ScheduleNavigation = ReturnType<typeof useScheduleNavigation>;

export function useScheduleNavigation(workspaceId: string) {
  const navigate = useNavigate();
  return {
    list: () =>
      void navigate({
        to: "/workspaces/$workspaceId/schedules",
        params: { workspaceId },
        search: {},
      }),
    detail: (scheduleId: string, options: { replace?: boolean } = {}) =>
      void navigate({
        to: "/workspaces/$workspaceId/schedules/$scheduleId",
        params: { workspaceId, scheduleId },
        replace: options.replace,
      }),
    edit: (scheduleId: string) =>
      void navigate({
        to: "/workspaces/$workspaceId/schedules/$scheduleId/edit",
        params: { workspaceId, scheduleId },
      }),
    create: (search: { template?: string; from?: string; sourceSessionId?: string } = {}) =>
      void navigate({
        to: "/workspaces/$workspaceId/schedules/new",
        params: { workspaceId },
        search,
      }),
    session: (sessionId: string) =>
      void navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId, sessionId },
      }),
  };
}

export { inAppClick } from "@/lib/in-app-click";

/* ----------------------------------------------------------------------------
   Values.
   -------------------------------------------------------------------------- */

export function ScheduleTile({ task }: { task: ScheduledTask }) {
  const active = scheduledTaskStateLabel(task).active;
  return (
    <LogoTile
      name={task.name}
      icon={
        active ? isKnowledgeSync(task) ? <RefreshCwIcon /> : <CalendarClockIcon /> : <PauseIcon />
      }
    />
  );
}

export function NextRunValue({ task, now }: { task: ScheduledTask; now: Date }) {
  const state = scheduledTaskStateLabel(task);
  if (!state.active) return <span className="text-fg-subtle">{state.label}</span>;
  if (task.schedule.type === "manual") return <span className="text-fg-subtle">On demand</span>;
  const next = nextRunOf(task, now);
  if (!next) return <span className="text-fg-subtle">No runs left</span>;
  return <RelativeTime date={next} format="absolute" />;
}

const RUN_BADGE: Record<
  ScheduledTaskRun["status"],
  { status: "succeeded" | "failed" | "running" | "queued"; label?: string }
> = {
  succeeded: { status: "succeeded" },
  failed: { status: "failed" },
  dispatched: { status: "running" },
  queued: { status: "queued" },
  skipped: { status: "queued", label: "Skipped" },
};

export function RunStatusBadge({ run }: { run: ScheduledTaskRun }) {
  const badge = RUN_BADGE[run.status] ?? { status: "queued" as const, label: run.status };
  return (
    <StatusBadge
      variant="dot"
      status={badge.status}
      className={cn(run.status === "failed" && "text-danger")}
    >
      {badge.label}
    </StatusBadge>
  );
}

export function LastRunValue({ state }: { state: LastRunState }) {
  if (state.kind === "unknown") return <span className="text-fg-subtle">Unknown</span>;
  if (state.kind === "never") return <span className="text-fg-subtle">Never run</span>;
  const { run } = state;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1">
      <RunStatusBadge run={run} />
      <RelativeTime date={run.firedAt} inSentence className="min-w-0 truncate" />
    </span>
  );
}

export function OwnerValue({
  task,
  viewerSubjectId,
  size = "sm",
}: {
  task: ScheduledTask;
  viewerSubjectId: string;
  size?: "sm" | "md";
}): ReactNode {
  if (ownsSchedule(task, viewerSubjectId)) {
    return <span className="text-fg-subtle">You</span>;
  }
  const name = ownerName(task);
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 align-middle">
      <Avatar className={size === "md" ? "size-6" : "size-5"}>
        <AvatarFallback className="bg-surface-3 text-2xs font-semibold text-fg-muted">
          {creatorInitials({
            kind: "subject",
            subjectId: task.ownerSubjectId ?? "",
            label: name,
          }) ?? "?"}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

/* ----------------------------------------------------------------------------
   The row menu.
   -------------------------------------------------------------------------- */

export function ScheduleMenuItems({
  task,
  access,
  busy,
  onRunNow,
  onPause,
  onResume,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  task: ScheduledTask;
  access: ScheduleAccess;
  busy: boolean;
  onRunNow: () => void;
  onPause: () => void;
  onResume: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const perms = schedulePermissions(task, access);
  const paused = task.status === "paused";
  const state = scheduledTaskStateLabel(task);
  const active = state.active;
  const retired = state.reason === "provider_retired";
  return (
    <>
      {perms.own ? null : (
        <>
          <DropdownMenuLabel className="max-w-64 px-2 py-1.5 text-xs leading-4.5 font-normal text-fg-muted">
            {ownerName(task)} owns this schedule. It runs with their connected accounts, so only
            they can change or run it.
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
        </>
      )}
      {perms.canRun && !retired ? (
        <DropdownMenuItem disabled={busy || !active} onSelect={onRunNow}>
          <PlayIcon />
          Run now
        </DropdownMenuItem>
      ) : null}
      {perms.canPauseOrDelete && !retired ? (
        <DropdownMenuItem disabled={busy} onSelect={paused ? onResume : onPause}>
          {paused ? <PlayIcon /> : <PauseIcon />}
          {paused ? "Resume" : "Pause"}
        </DropdownMenuItem>
      ) : null}
      {perms.canEdit ? (
        <DropdownMenuItem disabled={busy} onSelect={onEdit}>
          <PencilIcon />
          Edit
        </DropdownMenuItem>
      ) : null}
      {perms.canDuplicate ? (
        <DropdownMenuItem onSelect={onDuplicate}>
          <CopyIcon />
          Duplicate
        </DropdownMenuItem>
      ) : null}
      {perms.canPauseOrDelete ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={busy} onSelect={onDelete}>
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

/** A schedule the viewer can do nothing with has no ⋯ menu at all. */
export function hasMenuItems(task: ScheduledTask, access: ScheduleAccess): boolean {
  const perms = schedulePermissions(task, access);
  return perms.canRun || perms.canPauseOrDelete || perms.canEdit || perms.canDuplicate;
}
