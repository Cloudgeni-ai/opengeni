/**
 * One schedule sheet drawn in place (no overlay), for side-by-side review.
 * Its switch, Run now and menus work on local state.
 */
import { useEffect, useRef, useState } from "react";
import { PauseIcon } from "lucide-react";
import { toast } from "sonner";

import { showUndoToast } from "@/components/ui/destructive-confirm";

import { KIT_NOW } from "../../fixtures";
import {
  duplicateDraft,
  initialItems,
  nextRunOf,
  permissionsFor,
  runTimeLabel,
  type ScheduleItem,
  type SchedulesQuestions,
} from "./model";
import { ScheduleSheet } from "./schedule-detail";
import { useSchedulePicks } from "./use-picks";

export function ScheduleSheetDemo({
  scheduleId,
  questions,
}: {
  scheduleId: string;
  questions: SchedulesQuestions;
}) {
  const picks = useSchedulePicks();
  const [item, setItem] = useState<ScheduleItem>(
    () => initialItems().find((each) => each.id === scheduleId) ?? initialItems()[0]!,
  );
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const setActive = (active: boolean) => {
    setSaving(true);
    timers.current.push(
      setTimeout(() => {
        setSaving(false);
        setItem((current) => ({ ...current, state: active ? "active" : "paused" }));
        if (active) {
          const next = nextRunOf({ ...item, state: "active" });
          toast.success(`Resumed ${item.name}`, {
            description: next ? `Next run ${runTimeLabel(next)}.` : undefined,
          });
        } else {
          showUndoToast({
            title: `Paused ${item.name}`,
            description: "It won't run until you resume it.",
            icon: <PauseIcon />,
            onUndo: () => setItem((current) => ({ ...current, state: "active" })),
          });
        }
      }, 450),
    );
  };

  const runNow = () => {
    setRunning(true);
    toast(`Started ${item.name}`, { description: "The run's chat shows up in Agents." });
    timers.current.push(
      setTimeout(() => {
        setRunning(false);
        setItem((current) => ({
          ...current,
          lastRun: { status: "succeeded", at: KIT_NOW.toISOString() },
          runs: [
            {
              id: `${current.id}-demo-${current.runs.length}`,
              status: "succeeded",
              statusLabel: "Succeeded",
              startedAt: KIT_NOW.toISOString(),
              startedLabel: "Just now",
              durationLabel: "3 s",
              triggerLabel: "Run now by you",
              outcome: "Finished. Open the chat to see what it found.",
            },
            ...current.runs,
          ],
        }));
      }, 3200),
    );
  };

  const note = (title: string, description?: string) => toast(title, { description });

  return (
    <div className="h-[760px] min-w-0 overflow-hidden rounded-[16px] border border-border bg-surface">
      <ScheduleSheet
        className="shadow-none"
        props={{
          item,
          perms: permissionsFor(item, questions),
          questions,
          picks,
          running,
          savingActive: saving,
          onActiveChange: setActive,
          onRunNow: runNow,
          onEdit: () => note("Opens the edit form", "See the Schedule form page."),
          onDuplicate: () =>
            note("Opens the form as a copy", `Named ${duplicateDraft(item).name}.`),
          onCopyLink: () => note("Link copied"),
          onDelete: () => note("Asks before deleting", "See the Schedules page preview."),
          onOpenRun: (run) =>
            note("Opens the chat for this run", `${run.statusLabel} · ${run.startedLabel}.`),
          onOpenVariableSet: (name) =>
            note(`Opens ${name}`, "Variable sets has its own page preview."),
        }}
      />
    </div>
  );
}
