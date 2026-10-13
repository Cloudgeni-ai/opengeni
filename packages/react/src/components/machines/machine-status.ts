// ----------------------------------------------------------------------------
// Machine status copy — what the agent and its connection are doing, in words.
//
// Pure functions from a machine's runtime and connection authority to plain
// status text, a tone and the one action that can help. Cards and the detail
// page share them so every surface tells the same story, and so a past event
// is never shown as a current alarm.
// ----------------------------------------------------------------------------
import type { MachineView } from "../../types/machines";

type Runtime = NonNullable<MachineView["runtime"]>;
type Authority = MachineView["connectionAuthority"];

/** `waiting` is neutral progress or a postponement; `attention` asks for a look. */
export type StatusTone = "ok" | "progress" | "waiting" | "attention" | "failed" | "muted";

export type AgentUpdateAction = "update" | "retry" | "resend";

export type AgentRuntimeStatus = {
  /** "Agent v0.1.54" */
  title: string;
  /** One short line: "Up to date", "Updates to v0.1.55 when current work finishes", … */
  status: string;
  tone: StatusTone;
  /** Extra explanation under the status (blocked reason, failure cause). */
  note: string | null;
  /** The one action that can help right now, before permission/online checks. */
  action: { kind: AgentUpdateAction; label: string } | null;
};

/** An update request the agent has not confirmed after this long can be resent. */
export const UPDATE_CONFIRMATION_GRACE_MS = 30_000;

/** A busy machine postpones an update instead of interrupting work. The agent
 * reports this as a retryable `update_busy_*` result; it is not a failure. */
export function isPostponedUpdate(errorCode: string | null | undefined): boolean {
  return typeof errorCode === "string" && errorCode.startsWith("update_busy");
}

const FAILURE_REASON: Record<string, string> = {
  update_state_unavailable: "the agent couldn't check whether the machine was idle",
  agent_offline: "the machine was offline",
  update_dispatch_rejected: "the agent refused the request",
  invalid_agent_response: "the agent sent an unexpected reply",
};

function failureReason(code: string | null): string | null {
  if (!code) return null;
  return FAILURE_REASON[code] ?? code.replaceAll("_", " ");
}

const ACTIVE_STATUSES = new Set([
  "requested",
  "accepted",
  "waiting_for_idle",
  "downloading",
  "verifying",
  "applying",
  "restarting",
]);

/**
 * Describe the connected agent's build and update in plain words. A failed
 * update whose target is already installed is moot and ignored; a postponed
 * update reads as postponed, not failed.
 */
export function describeAgentRuntime(runtime: Runtime, now: number): AgentRuntimeStatus {
  const installed = runtime.installedVersion;
  const title = installed ? `Agent v${installed}` : "Agent version unknown";
  const blocked = runtime.updateBlockedReason?.trim() || null;
  const update = runtime.update;
  const target = update ? `v${update.targetVersion}` : null;
  const alreadyInstalled =
    update !== null &&
    (update.targetVersion === installed ||
      runtime.versionState === "current" ||
      runtime.versionState === "ahead");

  if (update && ACTIVE_STATUSES.has(update.status) && !alreadyInstalled) {
    const base = { title, tone: "progress" as const, note: null, action: null };
    switch (update.status) {
      case "requested": {
        const stalled = now - new Date(update.updatedAt).getTime() >= UPDATE_CONFIRMATION_GRACE_MS;
        return stalled
          ? {
              title,
              status: `The agent hasn't confirmed the update to ${target}`,
              tone: "attention",
              note: null,
              action: { kind: "resend", label: "Send again" },
            }
          : { ...base, status: `Sending the update to ${target}…` };
      }
      case "accepted":
        return { ...base, status: `Updating to ${target}…` };
      case "waiting_for_idle":
        return {
          ...base,
          tone: "waiting",
          status: `Updates to ${target} when current work finishes`,
        };
      case "downloading":
        return { ...base, status: `Downloading ${target}…` };
      case "verifying":
        return { ...base, status: `Verifying ${target}…` };
      case "applying":
        return { ...base, status: `Installing ${target}…` };
      default:
        return { ...base, status: "Restarting the agent…" };
    }
  }

  if (update?.status === "failed" && !alreadyInstalled) {
    if (isPostponedUpdate(update.errorCode)) {
      return {
        title,
        status: `Update to ${target} postponed while the machine was busy`,
        tone: "waiting",
        note: blocked,
        action: blocked ? null : { kind: "update", label: "Update now" },
      };
    }
    const reason = failureReason(update.errorCode);
    const retry =
      update.retryable && !blocked ? { kind: "retry" as const, label: "Try again" } : null;
    if (update.rolledBack) {
      return {
        title,
        status: `Couldn't update to ${target}, so the current version was kept`,
        tone: "attention",
        note: blocked ?? (reason ? `Reason: ${reason}.` : null),
        action: retry,
      };
    }
    return {
      title,
      status: `Update to ${target} failed`,
      tone: "failed",
      note: blocked ?? (reason ? `Reason: ${reason}.` : null),
      action: retry,
    };
  }

  const desired = runtime.desiredVersion;
  switch (runtime.versionState) {
    case "current":
      return {
        title,
        status: runtime.updateChannel === "beta" ? "Up to date · beta" : "Up to date",
        tone: "ok",
        note: null,
        action: null,
      };
    case "ahead":
      return {
        title,
        status: desired ? `Newer than the released v${desired}` : "Newer than the release",
        tone: "muted",
        note: null,
        action: null,
      };
    case "unknown":
      return {
        title,
        status: desired ? `Latest is v${desired}` : "No release configured",
        tone: "muted",
        note: blocked,
        action: null,
      };
    default:
      // `outdated`, or a server state the failure handling above already settled.
      if (!desired || desired === installed) {
        return { title, status: "Up to date", tone: "ok", note: null, action: null };
      }
      return {
        title,
        status: `v${desired} available`,
        tone: "waiting",
        note: blocked,
        action: blocked ? null : { kind: "update", label: "Update" },
      };
  }
}

/** A competing agent process retries at least every ten seconds while it runs,
 * so a refusal older than this belongs to history, not to the present. */
export const RUNNER_CONFLICT_ACTIVE_MS = 2 * 60_000;

export type RunnerConflict = {
  /** A second agent process on the machine is being kept out right now. */
  active: boolean;
  count: number;
  lastAt: string | null;
};

export function runnerConflict(authority: Authority, now: number): RunnerConflict | null {
  if (authority.duplicateRunnerDeniedCount <= 0) return null;
  const lastAt = authority.duplicateRunnerDeniedAt;
  const last = lastAt ? new Date(lastAt).getTime() : Number.NaN;
  return {
    active: Number.isFinite(last) && now - last < RUNNER_CONFLICT_ACTIVE_MS,
    count: authority.duplicateRunnerDeniedCount,
    lastAt,
  };
}

/** Plain words for the live connection: "Connected", "Reconnected 3 times". */
export function describeAgentConnection(authority: Authority): {
  label: string;
  detail: string | null;
} {
  const label =
    authority.state === "active"
      ? "Agent connected"
      : authority.state === "expired"
        ? "Agent connection lapsed"
        : "Agent not connected yet";
  const n = authority.supersededCount;
  return {
    label,
    detail: n > 0 ? `Reconnected ${n} ${n === 1 ? "time" : "times"} since setup` : null,
  };
}

export const STATUS_TONE_TEXT: Record<StatusTone, string> = {
  ok: "text-og-status-idle",
  progress: "text-og-accent",
  waiting: "text-og-fg-muted",
  attention: "text-og-status-waiting",
  failed: "text-og-status-failed",
  muted: "text-og-fg-subtle",
};
