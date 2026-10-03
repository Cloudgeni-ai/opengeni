import type { Workspace } from "@opengeni/contracts";
import { useEffect, useState } from "react";

/*
 * Agent-activity timer copy and clock, shared by the settings page and the
 * workspace-wide paused banner. Kept out of the settings chunks so the banner,
 * which renders on every workspace page, doesn't pull the management surface
 * into a direct session load.
 */

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
