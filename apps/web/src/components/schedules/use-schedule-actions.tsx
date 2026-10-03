/**
 * The row and page actions a schedule shares between the list and its own
 * page: Run now, Pause (with Undo), Resume and Delete (a centered confirm).
 * Every action goes through the same API calls the old page used; failures
 * say what happened in a toast and leave the list as it was.
 */
import { useCallback, useState, type ReactNode } from "react";
import { PauseIcon } from "lucide-react";
import { toast } from "sonner";

import { DestructiveConfirm, showUndoToast } from "@/components/ui/destructive-confirm";
import { useAppContext } from "@/context";
import type { ScheduledTask } from "@/types";

import { isKnowledgeSync, nextRunOf, runTimeLabel, scheduleErrorText } from "./schedule-model";

export type ScheduleAction = "pause" | "resume" | "trigger" | "delete";

const ACTION_ERROR: Record<ScheduleAction, string> = {
  pause: "Couldn't pause the schedule",
  resume: "Couldn't resume the schedule",
  trigger: "Couldn't start a run",
  delete: "Couldn't delete the schedule",
};

export interface ScheduleActions {
  busyTaskId: string | null;
  runNow: (task: ScheduledTask) => Promise<boolean>;
  pause: (task: ScheduledTask) => Promise<boolean>;
  resume: (task: ScheduledTask) => Promise<boolean>;
  requestDelete: (task: ScheduledTask) => void;
  /** The delete confirm; render it once on the page. */
  dialogs: ReactNode;
}

export function useScheduleActions({
  workspaceId,
  onChanged,
  onDeleted,
}: {
  workspaceId: string;
  /** Called after a successful change, to reload what the page shows. */
  onChanged: (task: ScheduledTask) => void | Promise<void>;
  onDeleted?: (task: ScheduledTask) => void;
}): ScheduleActions {
  const { client } = useAppContext();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ScheduledTask | null>(null);

  const run = useCallback(
    async (task: ScheduledTask, action: ScheduleAction): Promise<boolean> => {
      setBusyTaskId(task.id);
      try {
        if (action === "pause") {
          await client.pauseScheduledTask(workspaceId, task.id);
        } else if (action === "resume") {
          await client.resumeScheduledTask(workspaceId, task.id);
        } else if (action === "trigger") {
          await client.triggerScheduledTask(workspaceId, task.id);
        } else {
          await client.deleteScheduledTask(workspaceId, task.id);
        }
        return true;
      } catch (error) {
        toast.error(ACTION_ERROR[action], { description: scheduleErrorText(error) });
        return false;
      } finally {
        setBusyTaskId(null);
      }
    },
    [client, workspaceId],
  );

  const resume = useCallback(
    async (task: ScheduledTask) => {
      const done = await run(task, "resume");
      if (!done) return false;
      const now = new Date();
      const next = nextRunOf({ ...task, status: "active" }, now);
      toast.success(`Resumed ${task.name}`, {
        description: next ? `Next run ${runTimeLabel(next, now)}.` : undefined,
      });
      await onChanged(task);
      return true;
    },
    [onChanged, run],
  );

  const pause = useCallback(
    async (task: ScheduledTask) => {
      const done = await run(task, "pause");
      if (!done) return false;
      showUndoToast({
        title: `Paused ${task.name}`,
        description: "It won't run until you resume it.",
        icon: <PauseIcon />,
        onUndo: () => void resume(task),
      });
      await onChanged(task);
      return true;
    },
    [onChanged, resume, run],
  );

  const runNow = useCallback(
    async (task: ScheduledTask) => {
      const done = await run(task, "trigger");
      if (!done) return false;
      toast.success(`Started ${task.name}`, {
        description: isKnowledgeSync(task)
          ? "The sync runs in the background."
          : "Its chat shows up in your chats in a moment.",
      });
      await onChanged(task);
      return true;
    },
    [onChanged, run],
  );

  const knowledge = confirmDelete
    ? Boolean(confirmDelete.agentConfig.knowledgeSource) || isKnowledgeSync(confirmDelete)
    : false;
  const now = new Date();
  const next = confirmDelete ? nextRunOf(confirmDelete, now) : null;

  const dialogs = (
    <DestructiveConfirm
      open={confirmDelete !== null}
      onOpenChange={(open) => {
        if (!open) setConfirmDelete(null);
      }}
      title={confirmDelete ? `Delete ${confirmDelete.name}?` : "Delete schedule?"}
      consequences={
        knowledge
          ? [
              "It stops syncing, and its source is turned off.",
              "Turn the source back on from its connector.",
            ]
          : [
              next
                ? `It stops running. The next run was ${runTimeLabel(next, now)}.`
                : "It won't run again.",
              "Chats from earlier runs stay in your chats.",
              "This can't be undone. Pause it instead to keep it for later.",
            ]
      }
      confirmLabel="Delete schedule"
      pendingLabel="Deleting…"
      onConfirm={async () => {
        const task = confirmDelete;
        if (!task) return false;
        const done = await run(task, "delete");
        if (!done) return false;
        toast(`Deleted ${task.name}`);
        onDeleted?.(task);
        await onChanged(task);
        return true;
      }}
    />
  );

  return {
    busyTaskId,
    runNow,
    pause,
    resume,
    requestDelete: setConfirmDelete,
    dialogs,
  };
}
