// ----------------------------------------------------------------------------
// Machine status copy — what the agent and its connection are doing, in words.
//
// Pure functions from a machine's runtime and connection authority to plain
// status text, a tone and the one action that can help. Cards and the detail
// page share them so every surface tells the same story, and so a past event
// is never shown as a current alarm.
// ----------------------------------------------------------------------------
import type { MachineView } from "../../types/machines";
import { type OpenGeniText } from "../../messages/runtime";

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

const FAILURE_REASON = (t: OpenGeniText): Record<string, string> => ({
  update_state_unavailable: t("machines.machineStatus.theAgentCouldnTCheck"),
  agent_offline: t("machines.machineStatus.theMachineWasOffline"),
  update_dispatch_rejected: t("machines.machineStatus.theAgentRefusedTheRequest"),
  invalid_agent_response: t("machines.machineStatus.theAgentSentAnUnexpected"),
});

function failureReason(t: OpenGeniText, code: string | null): string | null {
  if (!code) return null;
  return FAILURE_REASON(t)[code] ?? code.replaceAll("_", " ");
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
export function describeAgentRuntime(
  t: OpenGeniText,
  runtime: Runtime,
  now: number,
): AgentRuntimeStatus {
  const installed = runtime.installedVersion;
  const title = installed
    ? t("machines.machineStatus.agentVInstalled", { installed })
    : t("machines.machineStatus.agentVersionUnknown");
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
              status: t("machines.machineStatus.theAgentHasnTConfirmed", { target }),
              tone: "attention",
              note: null,
              action: { kind: "resend", label: t("machines.machineStatus.sendAgain") },
            }
          : { ...base, status: t("machines.machineStatus.sendingTheUpdateToTarget", { target }) };
      }
      case "accepted":
        return { ...base, status: t("machines.machineStatus.updatingToTarget", { target }) };
      case "waiting_for_idle":
        return {
          ...base,
          tone: "waiting",
          status: t("machines.machineStatus.updatesToTargetWhenCurrent", { target }),
        };
      case "downloading":
        return { ...base, status: `Downloading ${target}…` };
      case "verifying":
        return { ...base, status: `Verifying ${target}…` };
      case "applying":
        return { ...base, status: `Installing ${target}…` };
      default:
        return { ...base, status: t("machines.machineStatus.restartingTheAgent") };
    }
  }

  if (update?.status === "failed" && !alreadyInstalled) {
    if (isPostponedUpdate(update.errorCode)) {
      // Automatic updates leave an older agent alone while updating it would
      // close its open browsers; updating by hand still closes them.
      const browsersWouldClose = update.errorCode === "update_busy_browsers";
      return {
        title,
        status: browsersWouldClose
          ? t("machines.machineStatus.updateToTargetPostponedOpen", { target })
          : t("machines.machineStatus.updateToTargetPostponedWhile", { target }),
        tone: "waiting",
        note:
          blocked ??
          (browsersWouldClose ? t("machines.machineStatus.theInstalledAgentClosesIts") : null),
        action: blocked ? null : { kind: "update", label: t("machines.machineStatus.updateNow") },
      };
    }
    const reason = failureReason(t, update.errorCode);
    const retry =
      update.retryable && !blocked
        ? { kind: "retry" as const, label: t("machines.machineStatus.tryAgain") }
        : null;
    if (update.rolledBack) {
      return {
        title,
        status: t("machines.machineStatus.couldnTUpdateToTarget", { target }),
        tone: "attention",
        note: blocked ?? (reason ? t("machines.machineStatus.reasonReason", { reason }) : null),
        action: retry,
      };
    }
    return {
      title,
      status: t("machines.machineStatus.updateToTargetFailed", { target }),
      tone: "failed",
      note: blocked ?? (reason ? t("machines.machineStatus.reasonReason", { reason }) : null),
      action: retry,
    };
  }

  const desired = runtime.desiredVersion;
  switch (runtime.versionState) {
    case "current":
      return {
        title,
        status:
          runtime.updateChannel === "beta"
            ? t("machines.machineStatus.upToDateBeta")
            : t("machines.machineStatus.upToDate"),
        tone: "ok",
        note: null,
        action: null,
      };
    case "ahead":
      return {
        title,
        status: desired
          ? t("machines.machineStatus.newerThanTheReleasedV", { desired })
          : t("machines.machineStatus.newerThanTheRelease"),
        tone: "muted",
        note: null,
        action: null,
      };
    case "unknown":
      return {
        title,
        status: desired
          ? t("machines.machineStatus.latestIsVDesired", { desired })
          : t("machines.machineStatus.noReleaseConfigured"),
        tone: "muted",
        note: blocked,
        action: null,
      };
    default:
      // `outdated`, or a server state the failure handling above already settled.
      if (!desired || desired === installed) {
        return {
          title,
          status: t("machines.machineStatus.upToDate"),
          tone: "ok",
          note: null,
          action: null,
        };
      }
      return {
        title,
        status: `v${desired} available`,
        tone: "waiting",
        note: blocked,
        action: blocked ? null : { kind: "update", label: t("machines.machineStatus.update") },
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
export function describeAgentConnection(
  t: OpenGeniText,
  authority: Authority,
): {
  label: string;
  detail: string | null;
} {
  if (authority.state !== "active" && authority.authenticationError === "credentials_expired") {
    return {
      label: t("machines.machineStatus.credentialsExpired"),
      detail: t("machines.machineStatus.credentialsRecovery"),
    };
  }
  const label =
    authority.state === "active"
      ? t("machines.machineStatus.agentConnected")
      : authority.state === "expired"
        ? t("machines.machineStatus.agentConnectionLapsed")
        : t("machines.machineStatus.agentNotConnectedYet");
  const n = authority.supersededCount;
  return {
    label,
    detail:
      authority.state === "expired" || authority.state === "unclaimed"
        ? t("machines.machineStatus.offlineRecovery")
        : n > 0
          ? t("machines.machineStatus.reconnectedTimesSinceSetup", { count: n })
          : null,
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
