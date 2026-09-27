import { OpenGeniApiError } from "@opengeni/sdk";
import type { Workspace, WorkspacePauseTimerRequest } from "@opengeni/contracts";
import {
  CalendarClockIcon,
  ChevronDownIcon,
  Clock3Icon,
  InfinityIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { durationLabel, workspaceTimerLabel } from "@/components/workspace-runtime-control";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldStack, TextInput } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { SelectMenu } from "@/components/ui/select-menu";
import { DisabledReasonTooltip, SettingRow, SettingRowLink } from "@/components/ui/setting-row";
import { StatusDot } from "@/components/ui/status-dot";

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

/**
 * Settings > General > Agent activity: "● Running" with a Pause… menu, or
 * "● Paused" with Resume. Pausing stops new agent work in the workspace; work
 * already running finishes its current step.
 */
export function AgentActivityRow(props: AgentActivityProps) {
  const { control, canManage } = props;
  const paused = control.state === "paused";
  const now = useWorkspaceTimerClock(control, props.onRefresh);
  const timerLabel = control.timer ? workspaceTimerLabel(control, now) : null;
  const [busy, setBusy] = useState(false);
  const [timerOpen, setTimerOpen] = useState(false);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
    } catch (failure) {
      toast.error(failureMessage(failure));
      void props.onRefresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const pauseFor = (seconds: number) =>
    void run(
      () =>
        props.onTimer(
          { action: "set", pauseInSeconds: 0, pauseForSeconds: seconds },
          control.revision,
        ),
      `Agent work paused for ${durationLabel(seconds)}`,
    );

  const description = paused
    ? timerLabel && control.timer?.action === "resume"
      ? `New sessions and scheduled runs wait. ${timerLabel}.`
      : "New sessions and scheduled runs wait until someone resumes."
    : timerLabel
      ? `Agents can start new sessions and scheduled runs. ${timerLabel}.`
      : "Agents can start new sessions and scheduled runs.";

  const spinner = busy ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null;
  const control_ = paused ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() => void run(() => props.onControl("resume"), "Agent work resumed")}
      className="pointer-coarse:h-11"
    >
      {spinner ?? <PlayIcon aria-hidden="true" />}
      Resume
    </Button>
  ) : (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          className="pointer-coarse:h-11"
        >
          {spinner ?? <PauseIcon aria-hidden="true" />}
          Pause…
          <ChevronDownIcon aria-hidden="true" className="-mr-0.5 text-fg-subtle" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel className="text-xs font-medium text-fg-subtle">
          Pause new agent work
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => pauseFor(1800)}>
          <Clock3Icon />
          For 30 minutes
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => pauseFor(3600)}>
          <Clock3Icon />
          For 1 hour
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void run(() => props.onControl("pause"), "Agent work paused")}
        >
          <InfinityIcon />
          Until I resume
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setTimerOpen(true)}>
          <CalendarClockIcon />
          Custom…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

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
        hint={
          canManage && (paused || control.timer) ? (
            <SettingRowLink onClick={() => setTimerOpen(true)}>
              {control.timer ? "Change timer" : "Resume automatically"}
            </SettingRowLink>
          ) : undefined
        }
        control={
          canManage ? (
            control_
          ) : (
            <DisabledReasonTooltip reason={ADMIN_ONLY}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-disabled="true"
                className="cursor-not-allowed opacity-50 pointer-coarse:h-11"
              >
                {paused ? <PlayIcon aria-hidden="true" /> : <PauseIcon aria-hidden="true" />}
                {paused ? "Resume" : "Pause…"}
              </Button>
            </DisabledReasonTooltip>
          )
        }
      />
      {canManage ? (
        <PauseTimerDialog
          open={timerOpen}
          onOpenChange={setTimerOpen}
          control={control}
          now={now}
          onTimer={props.onTimer}
          onRefresh={props.onRefresh}
        />
      ) : null}
    </>
  );
}

/* ----------------------------------------------------------------------------
   The timer: pause later and/or for a while, or resume a paused workspace
   after a while. One minute to 30 days.
   -------------------------------------------------------------------------- */

const PRESETS = [
  { value: "900", label: "15 minutes" },
  { value: "1800", label: "30 minutes" },
  { value: "3600", label: "1 hour" },
  { value: "7200", label: "2 hours" },
  { value: "28800", label: "8 hours" },
  { value: "86400", label: "1 day" },
];
const UNITS = [
  { value: "60", label: "Minutes" },
  { value: "3600", label: "Hours" },
  { value: "86400", label: "Days" },
];

function DurationField({
  label,
  special,
  value,
  onChange,
  disabled,
}: {
  label: string;
  special?: string;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled: boolean;
}) {
  const presetValues = PRESETS.map((preset) => Number(preset.value));
  const [custom, setCustom] = useState(value !== null && !presetValues.includes(value));
  const [unit, setUnit] = useState(value !== null && value % 3600 === 0 ? 3600 : 60);
  const options = [
    ...(special ? [{ value: "special", label: special }] : []),
    ...PRESETS,
    { value: "custom", label: "Custom" },
  ];
  const selected = custom ? "custom" : value === null ? "special" : String(value);
  return (
    <Field label={label}>
      <div className="grid min-w-0 gap-2">
        <SelectMenu
          options={options}
          value={selected}
          disabled={disabled}
          onValueChange={(next) => {
            setCustom(next === "custom");
            onChange(
              next === "special" ? null : next === "custom" ? (value ?? 1800) : Number(next),
            );
          }}
          className="w-full"
        />
        {custom ? (
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_8rem] gap-2">
            <TextInput
              type="number"
              aria-label={`${label}, amount`}
              min={1}
              max={MAX_SECONDS / unit}
              step={1}
              disabled={disabled}
              value={value === null || !Number.isFinite(value) ? "" : value / unit}
              onChange={(event) =>
                onChange(event.target.value === "" ? Number.NaN : Number(event.target.value) * unit)
              }
            />
            <SelectMenu
              aria-label={`${label}, unit`}
              options={UNITS}
              value={String(unit)}
              disabled={disabled}
              onValueChange={(next) => {
                const nextUnit = Number(next);
                onChange(((value ?? 1800) / unit) * nextUnit);
                setUnit(nextUnit);
              }}
              className="w-full"
            />
          </div>
        ) : null}
      </div>
    </Field>
  );
}

function PauseTimerDialog({
  open,
  onOpenChange,
  control,
  now,
  onTimer,
  onRefresh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  control: Control;
  now: number;
  onTimer: AgentActivityProps["onTimer"];
  onRefresh: AgentActivityProps["onRefresh"];
}) {
  const paused = control.state === "paused";
  const [revision, setRevision] = useState(control.revision);
  const [pauseIn, setPauseIn] = useState<number | null>(null);
  const [pauseFor, setPauseFor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [draftKey, setDraftKey] = useState(0);

  function reset() {
    const remaining = (dueAt: string) =>
      Math.max(60, Math.ceil((Date.parse(dueAt) - now) / 60000) * 60);
    setRevision(control.revision);
    setPauseIn(control.timer?.action === "pause" ? remaining(control.timer.dueAt) : null);
    setPauseFor(
      control.timer?.action === "resume"
        ? remaining(control.timer.dueAt)
        : (control.timer?.pauseForSeconds ?? (paused ? 1800 : null)),
    );
    setError(null);
    setDraftKey((key) => key + 1);
  }

  // Start from the current timer each time the dialog opens (it opens from a menu or a link).
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const validDuration = (value: number | null) =>
    value === null || (Number.isInteger(value) && value >= 60 && value <= MAX_SECONDS);
  const valid = validDuration(pauseIn) && validDuration(pauseFor) && (!paused || pauseFor !== null);
  const preview = !valid
    ? "Pick a whole number of minutes between 1 minute and 30 days."
    : paused
      ? `Agent work resumes in ${durationLabel(pauseFor!)}.`
      : `${pauseIn ? `Agent work pauses in ${durationLabel(pauseIn)}` : "Agent work pauses now"}${
          pauseFor
            ? ` and resumes after ${durationLabel(pauseFor)}.`
            : ", until someone resumes it."
        }`;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={paused ? "Resume automatically" : "Pause agent work"}
      description={
        paused
          ? "Agent work stays paused until the time you pick."
          : "New sessions and scheduled runs wait while agent work is paused. Work already running finishes its current step."
      }
      submitLabel={paused ? "Set timer" : pauseIn === null ? "Pause" : "Set timer"}
      pendingLabel="Saving…"
      submitDisabled={!valid || cancelling}
      error={error}
      footerStart={
        control.timer ? (
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
                toast.success(
                  paused ? "Timer cancelled. Agent work stays paused" : "Timer cancelled",
                );
                onOpenChange(false);
              } catch (failure) {
                setError(failureMessage(failure));
                void onRefresh().catch(() => undefined);
              } finally {
                setCancelling(false);
              }
            }}
          >
            Cancel timer
          </Button>
        ) : undefined
      }
      onSubmit={async () => {
        if (!valid) return false;
        setError(null);
        try {
          await onTimer(
            {
              action: "set",
              pauseInSeconds: paused ? 0 : (pauseIn ?? 0),
              pauseForSeconds: pauseFor,
            },
            revision,
          );
          toast.success(paused || pauseIn ? "Timer set" : "Agent work paused");
          return true;
        } catch (failure) {
          setError(failureMessage(failure));
          void onRefresh().catch(() => undefined);
          return false;
        }
      }}
    >
      <FieldStack key={draftKey}>
        {paused ? null : (
          <DurationField
            label="Start"
            special="Now"
            value={pauseIn}
            onChange={setPauseIn}
            disabled={cancelling}
          />
        )}
        <DurationField
          label={paused ? "Resume after" : "Pause for"}
          special={paused ? undefined : "Until someone resumes it"}
          value={pauseFor}
          onChange={setPauseFor}
          disabled={cancelling}
        />
        <p className="-mt-3 text-xs leading-4.5 text-fg-muted" aria-live="polite">
          {preview}
        </p>
      </FieldStack>
    </FormDialog>
  );
}
