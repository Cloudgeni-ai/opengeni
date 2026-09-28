import { OpenGeniApiError } from "@opengeni/sdk";
import type { Workspace, WorkspacePauseTimerRequest } from "@opengeni/contracts";
import { Loader2Icon, PauseIcon, PlayIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { durationLabel, workspaceTimerLabel } from "@/components/workspace-runtime-control";
import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { Field, TextInput } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { DisabledReasonTooltip, SettingRow } from "@/components/ui/setting-row";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

type Control = Workspace["inferenceControl"];
type TimerRequest = Omit<WorkspacePauseTimerRequest, "clientEventId" | "expectedRevision">;

const MAX_SECONDS = 2_592_000;
const ADMIN_ONLY = "Only workspace admins can pause agent work.";

export interface AgentActivityProps {
  control: Control;
  canManage: boolean;
  onControl: (action: "pause" | "resume") => Promise<void>;
  onTimer: (request: TimerRequest, revision: number) => Promise<void>;
  onRefresh: () => Promise<void>;
}

/** Keeps a server-corrected clock ticking while a timer runs, and re-reads the workspace. */
export function useWorkspaceTimerClock(control: Control, onRefresh: () => Promise<void>) {
  const [now, setNow] = useState(Date.now());
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset(control.serverTime ? Date.parse(control.serverTime) - Date.now() : 0);
  }, [control.serverTime]);
  useEffect(() => {
    if (!control.timer) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [control.timer]);
  useEffect(() => {
    // SSE is the fast path. A bounded refresh also repairs a missed event or worker restart.
    if (!control.timer) return;
    const tick = setInterval(() => {
      void onRefresh().catch(() => undefined);
    }, 10000);
    return () => clearInterval(tick);
  }, [control.timer, onRefresh]);
  return now + offset;
}

function failureMessage(failure: unknown): string {
  return failure instanceof OpenGeniApiError && failure.status === 409
    ? "Someone changed agent activity just now. Try again with the latest state."
    : "Couldn't update agent activity. Try again.";
}

/* ----------------------------------------------------------------------------
   When agent work resumes. Every timed choice becomes a pause timer that
   starts now; "Until I resume" is a plain pause (or, while paused, cancels the
   timer). Timers run one minute to 30 days.
   -------------------------------------------------------------------------- */

type PauseChoice = "1800" | "3600" | "morning" | "manual" | "custom";

const MORNING_HOUR = 8;

/** The next 08:00 local time after `from`. */
function nextMorning(from: number): number {
  const date = new Date(from);
  date.setHours(MORNING_HOUR, 0, 0, 0);
  if (date.getTime() <= from) date.setDate(date.getDate() + 1);
  return date.getTime();
}

function isTomorrow(at: number, from: number): boolean {
  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return new Date(at).toDateString() === tomorrow.toDateString();
}

/** "14:30" today, "Tue 29 Sep, 08:00" on another day. */
function clockLabel(at: number, from: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === new Date(from).toDateString()) return time;
  const day = date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `${day.replace(",", "")}, ${time}`;
}

/** `YYYY-MM-DDTHH:mm` in local time, for a datetime-local input. */
function localInputValue(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Two hours from now, on the next quarter hour. */
function defaultPickedTime(from: number): number {
  const quarter = 15 * 60_000;
  return Math.ceil((from + 2 * 3_600_000) / quarter) * quarter;
}

/**
 * Settings > General > Agent activity: "● Running" with a Pause button, or
 * "● Paused" with Change and Resume. Pause and Change open one small dialog
 * that asks until when. Pausing stops new agent work in the workspace; work
 * already running finishes its current step.
 */
export function AgentActivityRow(props: AgentActivityProps) {
  const { control, canManage } = props;
  const paused = control.state === "paused";
  const now = useWorkspaceTimerClock(control, props.onRefresh);
  const timerLabel = control.timer ? workspaceTimerLabel(control, now) : null;
  const [resuming, setResuming] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  async function resume() {
    setResuming(true);
    try {
      await props.onControl("resume");
      toast.success("Agent work resumed");
    } catch (failure) {
      toast.error(failureMessage(failure));
      void props.onRefresh().catch(() => undefined);
    } finally {
      setResuming(false);
    }
  }

  const description = paused
    ? timerLabel && control.timer?.action === "resume"
      ? `New sessions and scheduled runs wait. ${timerLabel}.`
      : "New sessions and scheduled runs wait until someone resumes."
    : timerLabel
      ? `Agents can start new sessions and scheduled runs. ${timerLabel}.`
      : "Agents can start new sessions and scheduled runs.";

  const coarse = "pointer-coarse:h-11";
  let controls: ReactNode;
  if (!canManage) {
    controls = (
      <DisabledReasonTooltip reason={ADMIN_ONLY}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled="true"
          className={cn("cursor-not-allowed opacity-50", coarse)}
        >
          {paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}
          {paused ? "Resume" : "Pause"}
        </Button>
      </DisabledReasonTooltip>
    );
  } else if (paused) {
    controls = (
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={resuming}
          onClick={() => setDialogOpen(true)}
          className={coarse}
        >
          Change
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={resuming}
          onClick={() => void resume()}
          className={coarse}
        >
          {resuming ? (
            <Loader2Icon aria-hidden="true" className="animate-spin" />
          ) : (
            <PlayIcon aria-hidden="true" />
          )}
          Resume
        </Button>
      </div>
    );
  } else {
    controls = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setDialogOpen(true)}
        className={coarse}
      >
        <PauseIcon aria-hidden="true" />
        Pause
      </Button>
    );
  }

  return (
    <>
      <SettingRow
        label={
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={paused ? "neutral" : "success"} size="sm" />
            {paused ? "Paused" : "Running"}
          </span>
        }
        description={description}
        control={controls}
      />
      {canManage ? (
        <PauseDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          control={control}
          onControl={props.onControl}
          onTimer={props.onTimer}
          onRefresh={props.onRefresh}
        />
      ) : null}
    </>
  );
}

/**
 * "Pause agent work": a short list of until-when choices, Cancel and Pause.
 * Opened from Change while paused, the same choices move the resume time.
 */
function PauseDialog({
  open,
  onOpenChange,
  control,
  onControl,
  onTimer,
  onRefresh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  control: Control;
  onControl: AgentActivityProps["onControl"];
  onTimer: AgentActivityProps["onTimer"];
  onRefresh: AgentActivityProps["onRefresh"];
}) {
  const paused = control.state === "paused";
  const [revision, setRevision] = useState(control.revision);
  const [openedAt, setOpenedAt] = useState(() => Date.now());
  const [choice, setChoice] = useState<PauseChoice>("1800");
  const [picked, setPicked] = useState("");
  const [pickedError, setPickedError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Start from the current state each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const at = Date.now();
    const resumeAt =
      paused && control.timer?.action === "resume" ? Date.parse(control.timer.dueAt) : null;
    setRevision(control.revision);
    setOpenedAt(at);
    setChoice(paused ? (resumeAt ? "custom" : "manual") : "1800");
    setPicked(localInputValue(resumeAt ?? defaultPickedTime(at)));
    setPickedError(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const morning = nextMorning(openedAt);
  const until = (seconds: number) => `until ${clockLabel(openedAt + seconds * 1000, openedAt)}`;

  /** Seconds until the picked time, or what to fix. */
  function pickedSeconds(): number | string {
    const at = new Date(picked).getTime();
    if (!picked || Number.isNaN(at)) return "Pick a date and time.";
    const seconds = Math.ceil((at - Date.now()) / 1000);
    if (seconds < 60) return "Pick a time at least a minute from now.";
    if (seconds > MAX_SECONDS) return "Pick a time within the next 30 days.";
    return seconds;
  }

  async function submit(): Promise<boolean> {
    setError(null);
    let seconds: number | null = null;
    if (choice === "1800" || choice === "3600") seconds = Number(choice);
    if (choice === "morning")
      seconds = Math.min(MAX_SECONDS, Math.ceil((nextMorning(Date.now()) - Date.now()) / 1000));
    if (choice === "custom") {
      const result = pickedSeconds();
      if (typeof result === "string") {
        setPickedError(result);
        return false;
      }
      seconds = result;
    }
    try {
      if (seconds !== null) {
        await onTimer({ action: "set", pauseInSeconds: 0, pauseForSeconds: seconds }, revision);
        const at = clockLabel(Date.now() + seconds * 1000, Date.now());
        toast.success(
          paused
            ? `Agent work resumes at ${at}`
            : choice === "1800" || choice === "3600"
              ? `Agent work paused for ${durationLabel(seconds)}`
              : `Agent work paused until ${at}`,
        );
      } else if (!paused) {
        await onControl("pause");
        toast.success("Agent work paused");
      } else if (control.timer) {
        await onTimer({ action: "cancel" }, revision);
        toast.success("Agent work stays paused until someone resumes it");
      }
      return true;
    } catch (failure) {
      setError(failureMessage(failure));
      void onRefresh().catch(() => undefined);
      return false;
    }
  }

  // A pause scheduled for later (running, with a pause timer) can be cancelled here.
  const scheduledPause = !paused && control.timer?.action === "pause";

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={paused ? "Change pause" : "Pause agent work"}
      description={
        paused
          ? "Pick when agent work resumes."
          : "New sessions and scheduled runs wait until agent work resumes, and running work stops after its current step."
      }
      submitLabel={paused ? "Save" : "Pause"}
      pendingLabel={paused ? "Saving…" : "Pausing…"}
      submitDisabled={cancelling}
      error={error}
      footerStart={
        scheduledPause ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              setError(null);
              try {
                await onTimer({ action: "cancel" }, revision);
                toast.success("Scheduled pause cancelled");
                onOpenChange(false);
              } catch (failure) {
                setError(failureMessage(failure));
                void onRefresh().catch(() => undefined);
              } finally {
                setCancelling(false);
              }
            }}
          >
            Cancel scheduled pause
          </Button>
        ) : undefined
      }
      onSubmit={submit}
    >
      <div className="grid min-w-0 gap-3">
        <ChoiceCards
          variant="list"
          aria-label={paused ? "Resume" : "Pause until"}
          value={choice}
          onValueChange={(next) => {
            setChoice(next as PauseChoice);
            setPickedError(null);
          }}
        >
          <ChoiceCard value="1800" title="For 30 minutes" meta={until(1800)} />
          <ChoiceCard value="3600" title="For 1 hour" meta={until(3600)} />
          <ChoiceCard
            value="morning"
            title={isTomorrow(morning, openedAt) ? "Until tomorrow morning" : "Until this morning"}
            meta={clockLabel(morning, openedAt)}
          />
          <ChoiceCard value="manual" title="Until I resume" />
          <ChoiceCard value="custom" title="Pick a time" />
        </ChoiceCards>
        {choice === "custom" ? (
          <Field label="Resume at" error={pickedError} className="pl-6">
            <TextInput
              type="datetime-local"
              value={picked}
              min={localInputValue(Date.now() + 60_000)}
              max={localInputValue(Date.now() + MAX_SECONDS * 1000)}
              onChange={(event) => {
                setPicked(event.target.value);
                setPickedError(null);
              }}
            />
          </Field>
        ) : null}
      </div>
    </FormDialog>
  );
}
