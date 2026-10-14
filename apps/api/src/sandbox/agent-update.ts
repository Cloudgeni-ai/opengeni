// One exact-process agent update request, shared by the dashboard's "Update
// now" route and the automatic updater that keeps every live Connected Machine
// on its channel's promoted build without a click.

import type { Settings } from "@opengeni/config";
import { ControlRequest, ErrorCode } from "@opengeni/agent-proto";
import {
  advanceEnrollmentAgentUpdate,
  beginEnrollmentAgentUpdate,
  countLiveConnectedMachineBrowsers,
  type Database,
  type EnrollmentRecord,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import { NatsControlRpc, subjectFor } from "@opengeni/runtime/sandbox";
import {
  ACTIVE_UPDATE_STATUSES,
  compareAgentVersions,
  machineUpdateBlockedReason,
  promotedAgentVersion,
} from "./machines";

export type AgentUpdateDeps = {
  db: Database;
  bus?: EventBus | null;
  settings: Settings;
};

export type AgentUpdateRequestResult =
  | { kind: "accepted"; operationId: string; targetVersion: string }
  | { kind: "refused"; status: 409 | 422 | 502; message: string };

/** Reserve one exact-generation operation, ask the authoritative runner to
 * apply the promoted release, then let progress events + the successor Hello
 * drive the durable state to completion. `live` must be the enrollment's
 * current live connection. */
export async function requestAgentUpdate(
  deps: AgentUpdateDeps,
  live: EnrollmentRecord,
  input: { releaseBaseUrl: string },
): Promise<AgentUpdateRequestResult> {
  const { db, bus, settings } = deps;
  if (!live.connectionInstanceId || !live.agentVersion) {
    return refused(409, "machine has no authoritative live agent build");
  }
  const blockedReason = machineUpdateBlockedReason(live.os, live.agentVersion);
  if (blockedReason) return refused(422, blockedReason);
  const channel = live.agentUpdateChannel ?? "stable";
  const targetVersion = promotedAgentVersion(settings, channel);
  const reusableRequest =
    live.agentUpdate?.status === "requested" &&
    live.agentUpdate.targetVersion === targetVersion &&
    live.agentUpdate.connectionInstanceId === live.connectionInstanceId &&
    live.agentUpdate.connectionGeneration === live.connectionGeneration
      ? live.agentUpdate
      : null;
  // Whatever happened to an earlier attempt, a machine already running the
  // promoted build has nothing to install.
  if (!reusableRequest && live.agentVersion === targetVersion) {
    return refused(409, "machine already runs the promoted version");
  }
  const operationId = reusableRequest?.operationId ?? crypto.randomUUID();
  const fence = {
    accountId: live.accountId,
    workspaceId: live.workspaceId,
    enrollmentId: live.id,
    connectionInstanceId: live.connectionInstanceId,
    connectionGeneration: live.connectionGeneration,
    operationId,
  };
  if (!reusableRequest) {
    const reserved = await beginEnrollmentAgentUpdate(db, { ...fence, targetVersion });
    if (!reserved) return refused(409, "machine update state changed; refresh and retry");
  }

  const rpc = new NatsControlRpc(async () => bus?.getRequestConnection() ?? null);
  const request: ControlRequest = {
    requestId: operationId,
    // The subject already selects the exact authoritative process instance.
    // `epoch` is the sandbox lease epoch, not the enrollment connection
    // generation, so this process-scoped operation intentionally leaves it 0.
    epoch: 0,
    resourcePolicy: undefined,
    op: {
      $case: "agentUpdateApply",
      agentUpdateApply: {
        operationId,
        targetVersion,
        channel,
        expectedCurrentVersion: live.agentVersion,
        expectedCurrentSha256: live.agentBinarySha256 ?? "",
        releaseBaseUrl: input.releaseBaseUrl.replace(/\/+$/, ""),
      },
    },
  };
  const subject = subjectFor(live.workspaceId, live.id, live.connectionInstanceId);
  let response = await rpc.request(subject, request, { timeoutMs: 10_000 });
  // The operation id is idempotent. One retry heals an ambiguous lost reply;
  // the agent returns the same acceptance and never starts a second update.
  if (response.error?.code === ErrorCode.ERROR_CODE_TIMEOUT) {
    response = await rpc.request(subject, request, { timeoutMs: 10_000 });
  }
  if (response.error) {
    // A second timeout remains ambiguous: progress/Hello may still prove the
    // operation. Keep it requested rather than racing a false terminal failure.
    if (response.error.code !== ErrorCode.ERROR_CODE_TIMEOUT) {
      await advanceEnrollmentAgentUpdate(db, {
        ...fence,
        status: "failed",
        errorCode:
          response.error.detail.failure_code ??
          (response.error.code === ErrorCode.ERROR_CODE_AGENT_OFFLINE
            ? "agent_offline"
            : "update_dispatch_rejected"),
        retryable: response.error.retryable,
        rolledBack: false,
      });
      return refused(response.error.retryable ? 409 : 422, response.error.message);
    }
  } else if (
    response.result?.$case !== "agentUpdateApply" ||
    !response.result.agentUpdateApply.accepted
  ) {
    await advanceEnrollmentAgentUpdate(db, {
      ...fence,
      status: "failed",
      errorCode: "invalid_agent_response",
      retryable: true,
      rolledBack: false,
    });
    return refused(502, "agent returned an invalid update response");
  } else {
    await advanceEnrollmentAgentUpdate(db, { ...fence, status: "accepted" });
  }
  return { kind: "accepted", operationId, targetVersion };
}

function refused(status: 409 | 422 | 502, message: string): AgentUpdateRequestResult {
  return { kind: "refused", status, message };
}

/** First agent release whose restart detaches from its managed browsers so
 * the successor adopts them with their tabs and page state. An older agent
 * closes every managed browser while it shuts down for an update. */
export const BROWSER_PRESERVING_AGENT_VERSION = "0.1.58";

/** Recorded when the automatic updater leaves an older agent alone because
 * updating it would close managed browsers. A `update_busy_*` code, so it
 * reads and retries as a postponement rather than a failure. */
export const UPDATE_POSTPONED_FOR_BROWSERS = "update_busy_browsers";

/** Whether updating this agent would close browsers it manages. */
export async function agentUpdateWouldCloseBrowsers(
  db: Database,
  enrollment: EnrollmentRecord,
): Promise<boolean> {
  const order = enrollment.agentVersion
    ? compareAgentVersions(enrollment.agentVersion, BROWSER_PRESERVING_AGENT_VERSION)
    : null;
  if (order !== null && order >= 0) return false;
  const live = await countLiveConnectedMachineBrowsers(db, {
    accountId: enrollment.accountId,
    workspaceId: enrollment.workspaceId,
    enrollmentId: enrollment.id,
  });
  return live > 0;
}

/** Record a postponed automatic update on the machine without asking its
 * agent, so the machine shows why it stays on its current build and the
 * busy backoff decides when to look again. */
async function postponeAgentUpdate(
  db: Database,
  live: EnrollmentRecord,
  targetVersion: string,
  errorCode: string,
): Promise<boolean> {
  if (!live.connectionInstanceId) return false;
  const fence = {
    accountId: live.accountId,
    workspaceId: live.workspaceId,
    enrollmentId: live.id,
    connectionInstanceId: live.connectionInstanceId,
    connectionGeneration: live.connectionGeneration,
    operationId: crypto.randomUUID(),
  };
  const reserved = await beginEnrollmentAgentUpdate(db, { ...fence, targetVersion });
  if (!reserved) return false;
  await advanceEnrollmentAgentUpdate(db, {
    ...fence,
    status: "failed",
    errorCode,
    retryable: true,
    rolledBack: false,
  });
  return true;
}

/** How long the automatic updater leaves a machine alone after an attempt. */
export const AUTOMATIC_AGENT_UPDATE_RETRY_MS = {
  /** A machine postponed because it was busy (running work, or managed
   * browsers an older agent would close) is looked at again soon: the check
   * is instant and interrupts nothing. */
  busy: 10 * 60_000,
  /** A request the runner never answered is re-sent under the same operation. */
  unanswered: 10 * 60_000,
  /** Other retryable failures (download, verification, a replaced process). */
  retryable: 60 * 60_000,
} as const;

/** Whether a live machine should be asked now to move to `targetVersion`.
 * Pure: decided from the enrollment the heartbeat already read. Only upgrades
 * are automatic; moving a machine to an older promoted build stays an explicit
 * per-machine request. A non-retryable failure waits for a newer promotion. */
export function automaticAgentUpdateDue(
  enrollment: EnrollmentRecord,
  targetVersion: string,
  now: number,
): boolean {
  if (!enrollment.connectionInstanceId || !enrollment.agentVersion) return false;
  if (machineUpdateBlockedReason(enrollment.os, enrollment.agentVersion)) return false;
  const order = compareAgentVersions(enrollment.agentVersion, targetVersion);
  if (order === null || order >= 0) return false;
  const update = enrollment.agentUpdate;
  if (!update) return true;
  const updatedAt = Date.parse(update.updatedAt);
  const age = Number.isFinite(updatedAt) ? now - updatedAt : Number.POSITIVE_INFINITY;
  if (ACTIVE_UPDATE_STATUSES.has(update.status)) {
    // Past "requested", the runner owns the operation (including waiting for
    // idle). A replaced runner turns it into a retryable failure on its Hello.
    return (
      update.status === "requested" &&
      update.targetVersion === targetVersion &&
      update.connectionInstanceId === enrollment.connectionInstanceId &&
      age >= AUTOMATIC_AGENT_UPDATE_RETRY_MS.unanswered
    );
  }
  if (update.status === "succeeded" || update.targetVersion !== targetVersion) return true;
  if (update.errorCode?.startsWith("update_busy")) {
    return age >= AUTOMATIC_AGENT_UPDATE_RETRY_MS.busy;
  }
  return update.retryable && age >= AUTOMATIC_AGENT_UPDATE_RETRY_MS.retryable;
}

export type AutomaticAgentUpdater = {
  /** Consider one live machine, typically from the enrollment its heartbeat
   * just read and renewed. Never blocks the caller. */
  consider(enrollment: EnrollmentRecord): void;
};

/** Keep live machines on their promoted build. Returns null when the
 * deployment turned automatic updates off or has no public base URL for the
 * agent to fetch the release manifest from. Concurrent API replicas are safe:
 * reserving an operation is an atomic conditional write. */
export function createAutomaticAgentUpdater(
  deps: AgentUpdateDeps & { observability?: Observability; now?: () => number },
): AutomaticAgentUpdater | null {
  const { settings, observability } = deps;
  if (!settings.agentAutoUpdate || !settings.publicBaseUrl) return null;
  const releaseBaseUrl = settings.publicBaseUrl;
  const now = deps.now ?? Date.now;
  const inFlight = new Set<string>();
  return {
    consider(enrollment) {
      const targetVersion = promotedAgentVersion(settings, enrollment.agentUpdateChannel);
      if (inFlight.has(enrollment.id)) return;
      if (!automaticAgentUpdateDue(enrollment, targetVersion, now())) return;
      inFlight.add(enrollment.id);
      const fields = {
        workspaceId: enrollment.workspaceId,
        enrollmentId: enrollment.id,
        installedVersion: enrollment.agentVersion,
        targetVersion,
      };
      void (async () => {
        // An explicit "Update now" may still close them; an automatic update
        // never does.
        if (await agentUpdateWouldCloseBrowsers(deps.db, enrollment)) {
          if (
            await postponeAgentUpdate(
              deps.db,
              enrollment,
              targetVersion,
              UPDATE_POSTPONED_FOR_BROWSERS,
            )
          ) {
            observability?.info?.(
              "Postponed an automatic Connected Machine agent update: the installed agent would close its open managed browsers",
              fields,
            );
          }
          return;
        }
        const result = await requestAgentUpdate(deps, enrollment, { releaseBaseUrl });
        if (result.kind === "accepted") {
          observability?.info?.("Requested an automatic Connected Machine agent update", fields);
        } else if (result.status !== 409) {
          observability?.warn?.("An automatic Connected Machine agent update was refused", {
            ...fields,
            message: result.message,
          });
        }
      })()
        .catch((error: unknown) => {
          observability?.warn?.("Failed to request an automatic Connected Machine agent update", {
            workspaceId: enrollment.workspaceId,
            enrollmentId: enrollment.id,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => inFlight.delete(enrollment.id));
    },
  };
}
