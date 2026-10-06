import type { SandboxItem, StartupPhaseItem, WorkerItem } from "./types";

/* Pure titles and durations for platform activity rows (startup phases and
   sandbox operations), shared by DOM and non-DOM renderers. */

export function sandboxRowTitle(item: SandboxItem, displayName: (name: string) => string): string {
  if (item.name === "sandbox.provision") {
    return startupPhaseTitle(
      "sandbox",
      item.status === "cancelled" ? "complete" : item.status,
      item.origin ?? null,
    );
  }
  return displayName(item.name);
}

export function startupPhaseTitle(
  phase: StartupPhaseItem["phase"],
  status: StartupPhaseItem["status"],
  outcome: StartupPhaseItem["outcome"],
): string {
  if (status === "complete" && phase === "sandbox" && outcome && outcome !== "skipped") {
    return `Sandbox ${outcome === "resumed" ? "reattached" : outcome}`;
  }
  if (status === "complete" && phase === "rig" && outcome === "skipped") {
    return "Sandbox Environment already ready";
  }
  const statusIndex =
    status === "running" ? 0 : status === "failed" ? 1 : status === "cancelled" ? 2 : 3;
  return STARTUP_PHASE_TITLES[phase][statusIndex];
}

export const STARTUP_WAIT_TITLES: Record<NonNullable<StartupPhaseItem["blockedReason"]>, string> = {
  capture_in_progress: "Waiting for sandbox checkpoint",
  rotation_in_progress: "Waiting for sandbox rotation",
  provider_recovery_in_progress: "Waiting for sandbox recovery",
};

const STARTUP_PHASE_TITLES: Record<
  StartupPhaseItem["phase"],
  readonly [string, string, string, string]
> = {
  queue: [
    "Waiting for a worker",
    "Worker startup failed",
    "Worker wait interrupted",
    "Worker started",
  ],
  sandbox: [
    "Starting sandbox",
    "Sandbox didn’t start",
    "Sandbox startup interrupted",
    "Sandbox ready",
  ],
  rig: [
    "Setting up sandbox environment",
    "Sandbox Environment setup failed",
    "Sandbox Environment setup interrupted",
    "Sandbox Environment ready",
  ],
  repository: [
    "Preparing repository",
    "Repository preparation failed",
    "Repository preparation interrupted",
    "Repository ready",
  ],
  files: [
    "Preparing files",
    "File preparation failed",
    "File preparation interrupted",
    "Files ready",
  ],
  tools: [
    "Connecting tools",
    "Tool connection failed",
    "Tool connection interrupted",
    "Tools ready",
  ],
  model_preparation: [
    "Preparing runtime and model request",
    "Runtime/model preparation failed",
    "Runtime/model preparation interrupted",
    "Model request dispatched",
  ],
  provider_first_byte: [
    "Waiting for model",
    "Model didn’t respond",
    "Model wait interrupted",
    "Model started responding",
  ],
};

export function startupDuration(durationMs: number | null): string | null {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** The worker step title for a spawn or message, by status. */
export function workerRowTitle(item: Pick<WorkerItem, "action" | "status">): string {
  const running = item.status === "running";
  const failed = item.status === "failed";
  const cancelled = item.status === "cancelled";
  return item.action === "spawn"
    ? running
      ? "Spawning worker"
      : failed
        ? "Worker spawn failed"
        : cancelled
          ? "Worker interrupted"
          : "Worker spawned"
    : running
      ? "Messaging worker"
      : failed
        ? "Worker message failed"
        : cancelled
          ? "Worker interrupted"
          : "Worker messaged";
}
