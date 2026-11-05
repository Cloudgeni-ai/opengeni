// One exact-process agent update request, shared by the dashboard's "Update
// now" route and the automatic updater that keeps every live Connected Machine
// on its channel's promoted build without a click.

import type { Settings } from "@opengeni/config";
import { ControlRequest, ErrorCode } from "@opengeni/agent-proto";
import {
  advanceEnrollmentAgentUpdate,
  beginEnrollmentAgentUpdate,
  connectedMachineBrowserUse,
  getEnrollment,
  getSandbox,
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
} from "./machines";
import { publishedAgentReleasesFor, type PublishedAgentReleases } from "./agent-release";
import { errorMessage } from "@opengeni/contracts/values";

export type AgentUpdateDeps = {
  db: Database;
  bus?: EventBus | null;
  settings: Settings;
  /** Which release an update targets; defaults to the deployment's
   * published releases (see createPublishedAgentReleases). */
  releases?: PublishedAgentReleases;
};

function releasesFor(deps: AgentUpdateDeps): PublishedAgentReleases {
  return deps.releases ?? publishedAgentReleasesFor(deps.settings);
}

/** The agent's refusal while its process-global updater already runs another
 * operation, typically one requested through another enrollment of the same
 * process, or an earlier operation an older agent still holds. */
const AGENT_UPDATE_ALREADY_IN_PROGRESS = "update_already_in_progress";

/** Recorded for that refusal. A `update_busy_*` code: the machine is updating,
 * not failing, and the successor's Hello settles the update. */
export const UPDATE_POSTPONED_FOR_ANOTHER_UPDATE = "update_busy_updating";

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
  input: {
    releaseBaseUrl: string;
    /** Reserve only while the machine's latest operation is still this one
     * (see beginEnrollmentAgentUpdate). */
    expectedOperationId?: string | null;
  },
): Promise<AgentUpdateRequestResult> {
  const { db, bus } = deps;
  if (!live.connectionInstanceId || !live.agentVersion) {
    return refused(409, "machine has no authoritative live agent build");
  }
  const blockedReason = machineUpdateBlockedReason(live.os, live.agentVersion);
  if (blockedReason) return refused(422, blockedReason);
  const channel = live.agentUpdateChannel ?? "stable";
  // Only a release whose manifest exists: the agent downloads it next.
  const targetVersion = await releasesFor(deps).resolve(channel);
  if (!targetVersion) {
    return refused(409, `no published ${channel} agent release is available for this deployment`);
  }
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
    const reserved = await beginEnrollmentAgentUpdate(db, {
      ...fence,
      targetVersion,
      ...(input.expectedOperationId === undefined
        ? {}
        : { expectedOperationId: input.expectedOperationId }),
    });
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
      const failureCode = response.error.detail.failure_code;
      // One process serves every enrollment it is linked to, and its updater
      // runs one operation at a time. Another operation is already updating
      // this process: postpone, and let the successor's receipt settle this
      // enrollment too.
      const updatingForAnotherOperation = failureCode === AGENT_UPDATE_ALREADY_IN_PROGRESS;
      await advanceEnrollmentAgentUpdate(db, {
        ...fence,
        status: "failed",
        errorCode: updatingForAnotherOperation
          ? UPDATE_POSTPONED_FOR_ANOTHER_UPDATE
          : (failureCode ??
            (response.error.code === ErrorCode.ERROR_CODE_AGENT_OFFLINE
              ? "agent_offline"
              : "update_dispatch_rejected")),
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

/** Whether this agent keeps its managed browsers open across an update. An
 * unknown version is assumed not to. */
export function agentUpdatePreservesBrowsers(agentVersion: string | null): boolean {
  const order = agentVersion
    ? compareAgentVersions(agentVersion, BROWSER_PRESERVING_AGENT_VERSION)
    : null;
  return order !== null && order >= 0;
}

/** How long an automatic update waits for the browsers of an older agent. */
export const AUTOMATIC_AGENT_UPDATE_BROWSER_WAIT_MS = {
  /** Once the machine has been trying to update this long, browsers that are
   * still in use no longer postpone it: a closing time is announced. */
  bound: 24 * 60 * 60_000,
  /** How long after the announcement the update closes the browsers. Agents
   * using a browser there are told in every browser observation. */
  notice: 30 * 60_000,
  /** How long after the closing time the announcement still holds while the
   * update is attempted (a busy agent refuses it, and is asked again). Past
   * it, browsers still in use get a new announcement before any update. */
  grace: 30 * 60_000,
} as const;

/** The announced time at which an automatic update closes this older
 * agent's managed browsers, or null. */
export function browserClosingUpdateAt(enrollment: EnrollmentRecord): number | null {
  if (!enrollment.agentUpdate || enrollment.agentUpdate.status === "succeeded") return null;
  if (agentUpdatePreservesBrowsers(enrollment.agentVersion)) return null;
  const closingAt = Date.parse(enrollment.agentUpdateBrowsersCloseAt ?? "");
  return Number.isFinite(closingAt) ? closingAt : null;
}

/** The model-visible notice an agent using a browser on this machine gets
 * from an announcement until its grace period ends, or null. */
export function agentUpdateBrowserClosingNotice(
  enrollment: EnrollmentRecord,
  now: number,
): string | null {
  const closingAt = browserClosingUpdateAt(enrollment);
  if (closingAt === null || now >= closingAt + AUTOMATIC_AGENT_UPDATE_BROWSER_WAIT_MS.grace) {
    return null;
  }
  const loss =
    "The restart closes this browser, so its open pages and unsaved page state, such as form input or downloads in progress, are lost. Finish or save that work first; the next browser action reopens the browser if it can.";
  if (now >= closingAt) {
    return `This Connected Machine's agent is restarting to update now. ${loss}`;
  }
  const at = new Date(closingAt).toISOString().slice(11, 16);
  const minutes = Math.max(1, Math.ceil((closingAt - now) / 60_000));
  return `This Connected Machine's agent restarts to update at about ${at} UTC (in ${minutes} min). ${loss}`;
}

const OBSERVATION_NOTICE_LIMIT = 1_024;

/** Add the closing notice to a browser observation's own notice, shortening
 * the observation's notice when both do not fit. */
export function withBrowserClosingNotice<T extends { notice?: string | undefined }>(
  observation: T,
  notice: string | null,
): T {
  if (!notice) return observation;
  if (!observation.notice) return { ...observation, notice };
  const room = OBSERVATION_NOTICE_LIMIT - notice.length - 1;
  const own =
    observation.notice.length <= room
      ? observation.notice
      : room > 1
        ? `${observation.notice.slice(0, room - 1)}\u2026`
        : "";
  return { ...observation, notice: own ? `${own}\n${notice}` : notice };
}

const CLOSING_NOTICE_ENROLLMENT_TTL_MS = 15_000;
const CLOSING_NOTICE_CACHE_LIMIT = 1_000;
const closingNoticeEnrollments = new Map<
  string,
  { readAt: number; enrollment: Promise<EnrollmentRecord | null> }
>();

/** The closing notice for a browser on this workspace's Connected Machine
 * sandbox, or null. The machine's update state is read at most every few
 * seconds per sandbox, so a browser's every step does not add reads. */
export async function connectedMachineBrowserClosingNotice(
  db: Database,
  workspaceId: string,
  sandboxId: string,
  now: number = Date.now(),
): Promise<string | null> {
  const key = `${workspaceId}:${sandboxId}`;
  let cached = closingNoticeEnrollments.get(key);
  if (!cached || now - cached.readAt >= CLOSING_NOTICE_ENROLLMENT_TTL_MS) {
    if (closingNoticeEnrollments.size >= CLOSING_NOTICE_CACHE_LIMIT) {
      closingNoticeEnrollments.clear();
    }
    cached = {
      readAt: now,
      enrollment: (async () => {
        const sandbox = await getSandbox(db, workspaceId, sandboxId);
        return sandbox?.enrollmentId
          ? await getEnrollment(db, workspaceId, sandbox.enrollmentId)
          : null;
      })(),
    };
    closingNoticeEnrollments.set(key, cached);
    // A failed read is not remembered.
    cached.enrollment.catch(() => closingNoticeEnrollments.delete(key));
  }
  const enrollment = await cached.enrollment;
  return enrollment ? agentUpdateBrowserClosingNotice(enrollment, now) : null;
}

/** What the automatic updater does about an older agent's managed browsers:
 * - `update` when none would close, when none is in use by a working session
 *   (an idle window), or while an announced closing time holds (the due check
 *   waits for that time to arrive);
 * - `announce` a closing time when browsers in use have held the update for
 *   the bound, or an earlier announcement's grace period has passed;
 * - `postpone` otherwise. */
export function browserUpdateDecision(
  enrollment: EnrollmentRecord,
  browsers: { live: number; inUse: number },
  now: number,
): "update" | "announce" | "postpone" {
  if (agentUpdatePreservesBrowsers(enrollment.agentVersion)) return "update";
  if (browsers.live === 0 || browsers.inUse === 0) return "update";
  const closingAt = browserClosingUpdateAt(enrollment);
  if (closingAt !== null) {
    return now < closingAt + AUTOMATIC_AGENT_UPDATE_BROWSER_WAIT_MS.grace ? "update" : "announce";
  }
  // Only a run of unsuccessful attempts still underway has waited.
  const waitingSince =
    enrollment.agentUpdate?.status === "failed"
      ? Date.parse(enrollment.agentUpdatePendingSince ?? enrollment.agentUpdate.requestedAt)
      : Number.NaN;
  return Number.isFinite(waitingSince) &&
    now - waitingSince >= AUTOMATIC_AGENT_UPDATE_BROWSER_WAIT_MS.bound
    ? "announce"
    : "postpone";
}

/** Record a postponed automatic update on the machine without asking its
 * agent, so the machine shows why it stays on its current build and the
 * busy backoff decides when to look again. With `browsersCloseAt`, the
 * postponement announces when the update will close the machine's browsers.
 * Recorded only while the machine's latest operation is still the one the
 * decision was made from. */
async function postponeAgentUpdate(
  db: Database,
  live: EnrollmentRecord,
  targetVersion: string,
  errorCode: string,
  browsersCloseAt?: Date,
): Promise<EnrollmentRecord | null> {
  if (!live.connectionInstanceId) return null;
  const fence = {
    accountId: live.accountId,
    workspaceId: live.workspaceId,
    enrollmentId: live.id,
    connectionInstanceId: live.connectionInstanceId,
    connectionGeneration: live.connectionGeneration,
    operationId: crypto.randomUUID(),
  };
  const reserved = await beginEnrollmentAgentUpdate(db, {
    ...fence,
    targetVersion,
    expectedOperationId: live.agentUpdate?.operationId ?? null,
    ...(browsersCloseAt ? { browsersCloseAt } : {}),
  });
  if (!reserved?.agentUpdate) return null;
  await advanceEnrollmentAgentUpdate(db, {
    ...fence,
    status: "failed",
    errorCode,
    retryable: true,
    rolledBack: false,
  });
  return {
    ...reserved,
    agentUpdate: {
      ...reserved.agentUpdate,
      status: "failed",
      errorCode,
      retryable: true,
    },
  };
}

/** How long the automatic updater leaves a machine alone after an attempt. */
export const AUTOMATIC_AGENT_UPDATE_RETRY_MS = {
  /** A machine postponed because it was busy (running work, or managed
   * browsers an older agent would close) is looked at again soon: the check
   * is instant and interrupts nothing. */
  busy: 10 * 60_000,
  /** A request the runner never answered is re-sent under the same operation. */
  unanswered: 10 * 60_000,
  /** Other retryable failures (download, verification, a replaced process)
   * back off: `retryableFirst` after the first, doubling after each further
   * failure of the same run, at most `retryableMax`. */
  retryableFirst: 10 * 60_000,
  retryableMax: 6 * 60 * 60_000,
} as const;

/** How long after a retryable failure the next automatic attempt waits. */
export function retryableAgentUpdateBackoffMs(enrollment: EnrollmentRecord): number {
  const recorded = enrollment.agentUpdateFailedAttempts;
  const earlierFailures = Number.isFinite(recorded) ? Math.max(0, Math.min(recorded, 30)) : 0;
  return Math.min(
    AUTOMATIC_AGENT_UPDATE_RETRY_MS.retryableMax,
    AUTOMATIC_AGENT_UPDATE_RETRY_MS.retryableFirst * 2 ** earlierFailures,
  );
}

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
  // An announced closing time holds, even for a newer target, so the agents
  // told about it are not surprised earlier.
  const closingAt = browserClosingUpdateAt(enrollment);
  if (closingAt !== null && now < closingAt) return false;
  if (update.status === "succeeded") return true;
  // A newer target is worth asking for at once. An older one (another
  // replica that has not seen the newer release yet) waits like a retry, so
  // replicas never alternate between targets.
  if ((compareAgentVersions(targetVersion, update.targetVersion) ?? 1) > 0) return true;
  if (update.errorCode?.startsWith("update_busy")) {
    return age >= AUTOMATIC_AGENT_UPDATE_RETRY_MS.busy;
  }
  return update.retryable && age >= retryableAgentUpdateBackoffMs(enrollment);
}

export type AutomaticAgentUpdater = {
  /** Consider one live machine, typically from the enrollment its heartbeat
   * just read and renewed. Never blocks the caller. */
  consider(enrollment: EnrollmentRecord): void;
};

/** Keep live machines on their newest published build. Returns null when the
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
  const releases =
    deps.releases ??
    publishedAgentReleasesFor(settings, {
      warn: (message, fields) => observability?.warn?.(message, fields),
    });
  const requestDeps = { ...deps, releases };
  const inFlight = new Set<string>();
  return {
    consider(enrollment) {
      if (!enrollment.connectionInstanceId || !enrollment.agentVersion) return;
      if (inFlight.has(enrollment.id)) return;
      inFlight.add(enrollment.id);
      void (async () => {
        const targetVersion = await releases.resolve(enrollment.agentUpdateChannel);
        if (!targetVersion || !automaticAgentUpdateDue(enrollment, targetVersion, now())) return;
        const fields = {
          workspaceId: enrollment.workspaceId,
          enrollmentId: enrollment.id,
          installedVersion: enrollment.agentVersion,
          targetVersion,
        };
        // An older agent closes its managed browsers when it updates. Wait
        // for a window where no working session is using them; after the
        // bound, announce a closing time to the agents using them and update
        // then. An explicit "Update now" may still close them at once. An
        // unanswered request is re-sent as it was decided.
        if (
          !agentUpdatePreservesBrowsers(enrollment.agentVersion) &&
          enrollment.agentUpdate?.status !== "requested"
        ) {
          const browsers = await connectedMachineBrowserUse(deps.db, {
            accountId: enrollment.accountId,
            workspaceId: enrollment.workspaceId,
            enrollmentId: enrollment.id,
          });
          const decided = now();
          const decision = browserUpdateDecision(enrollment, browsers, decided);
          if (decision !== "update") {
            const closingAt =
              decision === "announce"
                ? new Date(decided + AUTOMATIC_AGENT_UPDATE_BROWSER_WAIT_MS.notice)
                : undefined;
            const postponed = await postponeAgentUpdate(
              deps.db,
              enrollment,
              targetVersion,
              UPDATE_POSTPONED_FOR_BROWSERS,
              closingAt,
            );
            if (postponed) {
              observability?.info?.(
                closingAt
                  ? "Announced an automatic Connected Machine agent update that will close managed browsers in use"
                  : "Postponed an automatic Connected Machine agent update: the installed agent would close managed browsers that are in use",
                {
                  ...fields,
                  liveBrowsers: browsers.live,
                  browsersInUse: browsers.inUse,
                  ...(closingAt ? { closingAt: closingAt.toISOString() } : {}),
                },
              );
            }
            return;
          }
        }
        const result = await requestAgentUpdate(requestDeps, enrollment, {
          releaseBaseUrl,
          expectedOperationId: enrollment.agentUpdate?.operationId ?? null,
        });
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
            error: errorMessage(error),
          });
        })
        .finally(() => inFlight.delete(enrollment.id));
    },
  };
}
