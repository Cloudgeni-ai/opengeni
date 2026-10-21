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

/** Presentation only; never a deadline for work or update admission. */
export const UPDATE_HOLD_ATTENTION_MS = 10 * 60_000;

function elapsedDuration(t: OpenGeniText, ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return minutes < 60
    ? t("lib.format.minutes", { count: minutes })
    : minutes < 1440
      ? t("lib.format.hours", { count: Math.floor(minutes / 60) })
      : t("lib.format.days", { count: Math.floor(minutes / 1440) });
}

function updateWaitingReason(
  t: OpenGeniText,
  update: NonNullable<Runtime["update"]>,
  now: number,
): string {
  const labels: Record<string, string> = {
    browser_action: t("machines.machineStatus.blockerBrowserAction"),
    browser_session: t("machines.machineStatus.blockerBrowserSession"),
    browser_creation: t("machines.machineStatus.blockerBrowserCreation"),
    browser_closing: t("machines.machineStatus.blockerBrowserClosing"),
    browser_recovery: t("machines.machineStatus.blockerBrowserRecovery"),
    browser_authentication: t("machines.machineStatus.blockerBrowserAuth"),
    browser_state_transfer: t("machines.machineStatus.blockerBrowserTransfer"),
    computer_action: t("machines.machineStatus.blockerComputerAction"),
    computer_virtual_seat: t("machines.machineStatus.blockerVirtualDesktop"),
    computer_session: t("machines.machineStatus.blockerComputerSession"),
    computer_creation: t("machines.machineStatus.blockerComputerCreation"),
    computer_closing: t("machines.machineStatus.blockerComputerClosing"),
    computer_seat_transfer: t("machines.machineStatus.blockerSeatTransfer"),
    controller_request: t("machines.machineStatus.blockerControllerRequest"),
    controller_lifecycle: t("machines.machineStatus.blockerControllerLifecycle"),
    controller_stream: t("machines.machineStatus.blockerStream"),
    controller_producer: t("machines.machineStatus.blockerProducer"),
    controller_previous_update: t("machines.machineStatus.blockerPreviousUpdate"),
    other_work: t("machines.machineStatus.blockerOtherWork"),
    upload: t("machines.machineStatus.blockerUpload"),
    native_request: t("machines.machineStatus.blockerNativeRequest"),
    native_operation: t("machines.machineStatus.blockerNativeOperation"),
    native_light_running: t("machines.machineStatus.blockerNativeRequest"),
    native_light_queued: t("machines.machineStatus.blockerQueuedRequest"),
    native_heavy_running: t("machines.machineStatus.blockerNativeOperation"),
    native_heavy_queued: t("machines.machineStatus.blockerQueuedOperation"),
  };
  const raw = update.blockers ?? [];
  const native = raw.filter(
    (blocker) => blocker.kind.startsWith("native_") && !blocker.kind.includes("cleanup"),
  );
  const blockers = raw.filter((blocker) => !native.includes(blocker));
  if (native.length)
    blockers.push({
      kind: "native_work",
      count: Math.max(...native.map((blocker) => blocker.count)),
    });
  labels.native_work = t("machines.machineStatus.blockerNativeCounters");
  if (blockers.length) {
    const details = blockers
      .map((blocker) => {
        const label =
          labels[blocker.kind] ??
          (blocker.kind.includes("cleanup")
            ? t("machines.machineStatus.blockerCleanup")
            : t("machines.machineStatus.blockerUnknown"));
        return t("machines.machineStatus.blockerCount", { label, count: blocker.count });
      })
      .join("; ");
    return t("machines.machineStatus.reportedBlockers", {
      details,
      duration: elapsedDuration(t, now - Date.parse(update.updatedAt)),
    });
  }
  switch (update.errorCode) {
    case "update_busy_interactions":
    case "update_busy_browsers":
      return t("machines.machineStatus.waitingForInteractions");
    case "update_busy_uploads":
      return t("machines.machineStatus.waitingForUploads");
    default:
      return t("machines.machineStatus.waitingForUnspecifiedWork");
  }
}

/** A busy machine postpones an update instead of interrupting work. The agent
 * reports this as a retryable `update_busy_*` result; it is not a failure. */
export function isPostponedUpdate(errorCode: string | null | undefined): boolean {
  return typeof errorCode === "string" && errorCode.startsWith("update_busy");
}

const FAILURE_REASON = (t: OpenGeniText): Record<string, string> => ({
  update_cleanup_unconfirmed: t("machines.machineStatus.previousWorkCleanupUnconfirmed"),
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
  online = true,
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
      case "waiting_for_idle": {
        const heldMs = Math.max(0, now - Date.parse(update.requestedAt));
        const duration = elapsedDuration(t, heldMs);
        return {
          ...base,
          tone: !online ? "muted" : heldMs >= UPDATE_HOLD_ATTENTION_MS ? "attention" : "waiting",
          status: !online
            ? t("machines.machineStatus.offlineUpdateReport")
            : heldMs >= UPDATE_HOLD_ATTENTION_MS
              ? t("machines.machineStatus.updateHeldDuration", { target, duration })
              : t("machines.machineStatus.updatesToTargetWhenCurrent", { target }),
          note: blocked ?? updateWaitingReason(t, update, now),
        };
      }
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
          (browsersWouldClose
            ? t("machines.machineStatus.theInstalledAgentClosesIts")
            : updateWaitingReason(t, update, now)),
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
