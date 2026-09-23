import { OpenGeniApiError } from "@opengeni/sdk";
import { useEffect, useId, useState } from "react";
import { ChevronDownIcon, Clock3Icon, Loader2Icon, PauseIcon, PlayIcon } from "lucide-react";
import type { Workspace, WorkspacePauseTimerRequest } from "@opengeni/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

type Control = Workspace["inferenceControl"];
export function durationLabel(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
}
export function workspaceTimerLabel(control: Control, now: number): string | null {
  const timer = control.timer;
  if (!timer) return control.state === "paused" ? "Paused until you resume" : null;
  const remaining = (Date.parse(timer.dueAt) - now) / 1000;
  if (remaining <= 0) return timer.action === "pause" ? "Pausing…" : "Resuming…";
  return timer.action === "resume"
    ? `Resumes in ${durationLabel(remaining)}`
    : `Pauses in ${durationLabel(remaining)} · ${timer.pauseForSeconds ? `for ${durationLabel(timer.pauseForSeconds)}` : "until resumed"}`;
}

function DurationField(props: {
  label: string;
  special?: string;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled: boolean;
}) {
  const id = useId();
  const presets = [900, 1800, 3600, 7200];
  const [custom, setCustom] = useState(props.value !== null && !presets.includes(props.value));
  const [unit, setUnit] = useState(60);
  return (
    <div className="grid gap-2">
      <label className="text-xs font-medium text-fg-muted" htmlFor={id}>
        {props.label}
      </label>
      <Select
        id={id}
        disabled={props.disabled}
        value={custom ? "custom" : props.value === null ? "special" : String(props.value)}
        onChange={(event) => {
          const value = event.target.value;
          setCustom(value === "custom");
          props.onChange(value === "special" ? null : value === "custom" ? 1800 : Number(value));
        }}
      >
        {props.special ? <option value="special">{props.special}</option> : null}
        <option value="900">15 minutes</option>
        <option value="1800">30 minutes</option>
        <option value="3600">1 hour</option>
        <option value="7200">2 hours</option>
        <option value="custom">Custom…</option>
      </Select>
      {custom ? (
        <div className="flex gap-2">
          <Input
            className="min-w-0 flex-1"
            type="number"
            aria-label={`${props.label} amount`}
            min={1}
            max={2592000 / unit}
            step={1}
            disabled={props.disabled}
            value={props.value === null || !Number.isFinite(props.value) ? "" : props.value / unit}
            onChange={(event) =>
              props.onChange(
                event.target.value === "" ? Number.NaN : Number(event.target.value) * unit,
              )
            }
          />
          <div className="w-28 shrink-0 [&>span]:w-full">
            <Select
              aria-label={`${props.label} unit`}
              value={unit}
              disabled={props.disabled}
              onChange={(event) => {
                const next = Number(event.target.value);
                props.onChange(((props.value ?? 1800) / unit) * next);
                setUnit(next);
              }}
            >
              <option value={60}>Minutes</option>
              <option value={3600}>Hours</option>
            </Select>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceRuntimeControl(props: {
  control: Control;
  canManage: boolean;
  onControl: (action: "pause" | "resume") => Promise<void>;
  onTimer: (
    request: Omit<WorkspacePauseTimerRequest, "clientEventId" | "expectedRevision">,
    revision: number,
  ) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const { control, onRefresh } = props;
  const paused = control.state === "paused";
  const [open, setOpen] = useState(false);
  const [editingPaused, setEditingPaused] = useState(paused);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pauseIn, setPauseIn] = useState<number | null>(null);
  const [pauseFor, setPauseFor] = useState<number | null>(null);
  const [editingRevision, setEditingRevision] = useState(control.revision);
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
  const label = workspaceTimerLabel(control, now + offset);
  const validDuration = (value: number | null) =>
    value === null || (Number.isInteger(value) && value >= 60 && value <= 2592000);
  const valid =
    validDuration(pauseIn) && validDuration(pauseFor) && (!editingPaused || pauseFor !== null);
  function editTimer() {
    setEditingRevision(control.revision);
    setEditingPaused(paused);
    setPauseIn(
      control.timer?.action === "pause"
        ? Math.max(60, Math.ceil((Date.parse(control.timer.dueAt) - now - offset) / 60000) * 60)
        : null,
    );
    setPauseFor(
      control.timer?.action === "resume"
        ? Math.max(60, Math.ceil((Date.parse(control.timer.dueAt) - now - offset) / 60000) * 60)
        : (control.timer?.pauseForSeconds ?? (paused ? 1800 : null)),
    );
    setError(null);
    setOpen(true);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setOpen(false);
    } catch (failure) {
      setError(
        failure instanceof OpenGeniApiError && failure.status === 409
          ? "Workspace changed. Close and reopen the timer to use the latest state."
          : "Couldn't update the workspace. Please try again.",
      );
      void props.onRefresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  const preview = !valid
    ? "Choose a whole duration between 1 minute and 30 days."
    : editingPaused
      ? `Resume after ${durationLabel(pauseFor!)}.`
      : `${pauseIn ? `Pause in ${durationLabel(pauseIn)}` : "Pause now"}${pauseFor ? `, then resume after ${durationLabel(pauseFor)}.` : ", until you resume."}`;
  return (
    <section
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
      aria-label="Workspace runtime"
    >
      <div>
        <h2 className="text-sm font-medium">Workspace runtime</h2>
        <p className="mt-1 text-xs text-fg-muted">
          {paused
            ? "New agent work is paused for this workspace."
            : "Agents can start and continue work in this workspace."}
        </p>
        {label ? (
          <button
            type="button"
            disabled={!props.canManage || busy}
            onClick={editTimer}
            className="mt-2 flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg disabled:cursor-default"
            aria-label={`${label}. Edit pause timer`}
          >
            <Clock3Icon className="size-3" aria-hidden="true" />
            {label}
          </button>
        ) : null}
        {error && !open ? (
          <p role="alert" className="mt-2 text-xs text-status-error">
            {error}
          </p>
        ) : null}
      </div>
      {props.canManage ? (
        <div className="flex items-center">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-r-none"
            disabled={busy}
            onClick={() => void run(() => props.onControl(paused ? "resume" : "pause"))}
          >
            {busy ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : paused ? (
              <PlayIcon className="size-3.5" />
            ) : (
              <PauseIcon className="size-3.5" />
            )}
            {paused ? "Resume workspace" : "Pause workspace"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-l-none border-l border-border px-2"
            disabled={busy}
            onClick={editTimer}
            aria-label="Pause timer"
            aria-haspopup="dialog"
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </div>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{editingPaused ? "Resume timer" : "Pause timer"}</DialogTitle>
            <DialogDescription>Give your workspace a break.</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (valid)
                void run(() =>
                  props.onTimer(
                    {
                      action: "set",
                      pauseInSeconds: editingPaused ? 0 : (pauseIn ?? 0),
                      pauseForSeconds: pauseFor,
                    },
                    editingRevision,
                  ),
                );
            }}
          >
            {!editingPaused ? (
              <DurationField
                key={`in-${editingRevision}`}
                label="Pause in"
                special="Now"
                value={pauseIn}
                onChange={setPauseIn}
                disabled={busy}
              />
            ) : null}
            <DurationField
              key={`for-${editingRevision}`}
              label={editingPaused ? "Resume in" : "Pause for"}
              special={editingPaused ? undefined : "Until I resume"}
              value={pauseFor}
              onChange={setPauseFor}
              disabled={busy}
            />
            <p className="text-xs leading-relaxed text-fg-muted" aria-live="polite">
              {preview}
            </p>
            {error ? (
              <p role="alert" className="text-xs text-status-error">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              {control.timer ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => props.onTimer({ action: "cancel" }, editingRevision))
                  }
                >
                  Cancel timer
                </Button>
              ) : (
                <span />
              )}
              <Button type="submit" size="sm" disabled={busy || !valid}>
                {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                {!editingPaused && pauseIn === null ? "Pause now" : "Set timer"}
              </Button>
            </div>
            {editingPaused && control.timer ? (
              <p className="-mt-3 text-xs text-fg-muted">
                Cancelling the timer leaves the workspace paused.
              </p>
            ) : null}
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
