// Screen control and macOS permission setup for an already-connected machine.
//
// Screen-control consent lives on the enrollment row and in the credentials the
// machine holds (the agent's own dispatch gate checks them). Turning it on
// records the consent on the row, in place (same id, scope, owner and
// credential generation), then asks the live agent to renew its credentials
// now. That renewal is the same install-key-signed exchange the agent runs on
// its own schedule, and it re-reads consent from the row, so nothing new is
// trusted: no token, no installer, no restart, no second connection file. A
// machine that is offline, or whose agent predates credential_renew, picks the
// consent up when it next says Hello (reconcileScreenControlOnHello).

import { ControlRequest, ErrorCode, type Hello } from "@opengeni/agent-proto";
import {
  EnableMachineScreenControlResponse,
  OpenMachinePrivacySettingsResponse,
  type MachinePrivacySettingsPane,
} from "@opengeni/contracts";
import { runOnEnrollmentDirect, type FleetServices } from "@opengeni/core";
import {
  allowEnrollmentScreenControl,
  getLiveEnrollmentConnection,
  type EnrollmentRecord,
} from "@opengeni/db";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import { NatsControlRpc, subjectFor } from "@opengeni/runtime/sandbox";

type Services = Pick<FleetServices, "db" | "settings" | "bus"> & {
  observability?: Observability | undefined;
};
type EnrollmentAccess = string | { accountId: string; workspaceId: string; subjectId: string };

/** The agent's renewal HTTP call is bounded at 20s; leave room for the reply. */
const CREDENTIAL_RENEW_TIMEOUT_MS = 30_000;
/** Opening a System Settings pane is instant; never hold a request open longer. */
const PRIVACY_PANE_TIMEOUT_MS = 15_000;

/** macOS System Settings deep links for the three desktop permissions. */
export const MAC_PRIVACY_PANE_URLS: Record<MachinePrivacySettingsPane, string> = {
  screen_recording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  input_monitoring: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
};

/** Read access for live-connection lookups, matching the machine's scope. */
export function enrollmentAccess(
  enrollment: Pick<EnrollmentRecord, "scope" | "workspaceId">,
  personal: { accountId: string; workspaceId: string; subjectId: string },
): EnrollmentAccess {
  return enrollment.scope === "user" ? personal : enrollment.workspaceId;
}

export type CredentialRenewOutcome =
  | { kind: "renewed"; consentedScreenControl: boolean }
  | { kind: "offline" }
  | { kind: "failed"; failureCode: string };

/** Ask one exact live runner process to renew its credentials now. */
export async function requestCredentialRenew(
  bus: EventBus | undefined,
  target: { workspaceId: string; enrollmentId: string; connectionInstanceId: string },
): Promise<CredentialRenewOutcome> {
  if (!bus) return { kind: "offline" };
  const rpc = new NatsControlRpc(async () => bus.getRequestConnection() ?? null);
  const request: ControlRequest = {
    requestId: crypto.randomUUID(),
    // Process-scoped, like agentUpdateApply: the subject names the instance.
    epoch: 0,
    resourcePolicy: undefined,
    op: { $case: "credentialRenew", credentialRenew: {} },
  };
  const response = await rpc.request(
    subjectFor(target.workspaceId, target.enrollmentId, target.connectionInstanceId),
    request,
    { timeoutMs: CREDENTIAL_RENEW_TIMEOUT_MS },
  );
  if (response.error) {
    if (response.error.code === ErrorCode.ERROR_CODE_AGENT_OFFLINE) return { kind: "offline" };
    return {
      kind: "failed",
      failureCode:
        response.error.detail.failure_code ??
        (response.error.code === ErrorCode.ERROR_CODE_TIMEOUT ? "timeout" : "agent_error"),
    };
  }
  if (response.result?.$case !== "credentialRenew") {
    return { kind: "failed", failureCode: "invalid_agent_response" };
  }
  return {
    kind: "renewed",
    consentedScreenControl: response.result.credentialRenew.consentedScreenControl,
  };
}

const pending = (
  reason: "offline" | "agent_update_required" | "renewal_failed" | "reconnect_required",
  message: string,
): EnableMachineScreenControlResponse =>
  EnableMachineScreenControlResponse.parse({ status: "pending", reason, message });

const ACTIVE = { status: "active", reason: null, message: null } as const;

/** Agent failure codes that no retry fixes: the connection must be redone. */
const PERMANENT_RENEW_FAILURES = new Set([
  "connection_missing",
  "legacy_origin",
  "local_state_unavailable",
]);

/** The enrollment was revoked or removed between lookup and update. */
export class MachineNotActiveError extends Error {
  constructor() {
    super("machine is no longer connected to this workspace");
    this.name = "MachineNotActiveError";
  }
}

/** Who turned screen control on, for the audit trail. */
export type ScreenControlActor = {
  subjectId: string | null;
  sessionId?: string | null;
  attemptId?: string | null;
};

/**
 * Turn screen control on for one enrolled machine, in place. The caller has
 * already authorized the actor for this enrollment (enrollments:manage, plus
 * account:admin for an organization machine, plus personal-machine admission
 * for an agent attempt). Safe to repeat: a retry re-requests the renewal.
 */
export async function enableMachineScreenControl(
  services: Services,
  input: { enrollment: EnrollmentRecord; access: EnrollmentAccess; actor: ScreenControlActor },
): Promise<EnableMachineScreenControlResponse> {
  const { enrollment } = input;
  if (!enrollment.allowScreenControl) {
    const allowed = await allowEnrollmentScreenControl(services.db, {
      accountId: enrollment.accountId,
      workspaceId: enrollment.workspaceId,
      enrollmentId: enrollment.id,
      ...input.actor,
    });
    if (!allowed.active) throw new MachineNotActiveError();
  }
  const live = await getLiveEnrollmentConnection(services.db, input.access, enrollment.id);
  if (!live?.connectionInstanceId) {
    return pending(
      "offline",
      "Screen control is allowed. The machine is offline, so it turns on when the machine reconnects.",
    );
  }
  // The live agent's Hello already carries the consent: nothing to renew, so
  // repeated calls never churn the connection.
  if (live.allowScreenControl && live.agentCapabilities.screenControl === true) {
    return EnableMachineScreenControlResponse.parse(ACTIVE);
  }
  if (live.agentCapabilities.credentialRenew !== true) {
    return pending(
      "agent_update_required",
      "Screen control is allowed. This machine's agent is too old to switch it on while connected: update the agent and it turns on after the update.",
    );
  }
  const outcome = await requestCredentialRenew(services.bus, {
    workspaceId: live.workspaceId,
    enrollmentId: enrollment.id,
    connectionInstanceId: live.connectionInstanceId,
  });
  if (outcome.kind === "renewed" && outcome.consentedScreenControl) {
    return EnableMachineScreenControlResponse.parse(ACTIVE);
  }
  services.observability?.warn?.("Screen control renewal did not complete", {
    workspaceId: live.workspaceId,
    enrollmentId: enrollment.id,
    outcome: outcome.kind,
    failureCode: outcome.kind === "failed" ? outcome.failureCode : null,
  });
  if (outcome.kind === "offline") {
    return pending(
      "offline",
      "Screen control is allowed. The machine went offline, so it turns on when the machine reconnects.",
    );
  }
  if (outcome.kind === "failed" && PERMANENT_RENEW_FAILURES.has(outcome.failureCode)) {
    return pending(
      "reconnect_required",
      "Screen control is allowed, but this machine's connection can't take it in place. Run the connect command on the machine again with screen control on.",
    );
  }
  return pending(
    "renewal_failed",
    "The machine couldn't refresh its credentials. Try again in a moment.",
  );
}

const HELLO_RENEW_DELAYS_MS = [2_000, 5_000] as const;

/**
 * A machine whose enrollment allows screen control but whose credentials do
 * not (it was offline, or updated from an agent without credential_renew)
 * renews them as soon as it says Hello. The agent subscribes to requests just
 * after its Hello, so wait briefly and retry once. Never throws.
 */
export async function reconcileScreenControlOnHello(
  deps: {
    bus: EventBus | undefined;
    observability?: Observability | undefined;
    sleep?: (ms: number) => Promise<void>;
  },
  input: {
    authority: Pick<EnrollmentRecord, "allowScreenControl">;
    hello: Hello;
    target: {
      workspaceId: string;
      enrollmentId: string;
      connectionInstanceId: string;
    };
  },
): Promise<CredentialRenewOutcome | null> {
  const capabilities = input.hello.capabilities;
  if (
    !input.authority.allowScreenControl ||
    !capabilities?.credentialRenew ||
    capabilities.consentedScreenControl
  ) {
    return null;
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let outcome: CredentialRenewOutcome = { kind: "offline" };
  try {
    for (const delay of HELLO_RENEW_DELAYS_MS) {
      await sleep(delay);
      outcome = await requestCredentialRenew(deps.bus, input.target);
      if (outcome.kind !== "offline") break;
    }
  } catch (error) {
    outcome = {
      kind: "failed",
      failureCode: error instanceof Error ? error.message : "request_failed",
    };
  }
  if (outcome.kind !== "renewed") {
    deps.observability?.warn?.("Could not apply allowed screen control after a Hello", {
      workspaceId: input.target.workspaceId,
      enrollmentId: input.target.enrollmentId,
      outcome: outcome.kind,
      failureCode: outcome.kind === "failed" ? outcome.failureCode : null,
    });
  }
  return outcome;
}

/** Open one macOS Privacy & Security pane on a connected Mac. Opening a pane
 * grants nothing; the person flips the switch for OpenGeni. */
export async function openMachinePrivacySettings(
  services: Services,
  input: {
    enrollment: EnrollmentRecord;
    access: EnrollmentAccess;
    pane: MachinePrivacySettingsPane;
  },
): Promise<OpenMachinePrivacySettingsResponse> {
  if (input.enrollment.os !== "macos") {
    return OpenMachinePrivacySettingsResponse.parse({
      opened: false,
      message: "Privacy & Security panes exist only on macOS.",
    });
  }
  const result = await runOnEnrollmentDirect(services, {
    access: input.access,
    enrollmentId: input.enrollment.id,
    target: input.enrollment.id,
    cmd: `open '${MAC_PRIVACY_PANE_URLS[input.pane]}'`,
    execTimeoutMs: PRIVACY_PANE_TIMEOUT_MS,
  });
  const opened = result.ok && result.exitCode === 0;
  if (!opened) {
    services.observability?.warn?.("Could not open a macOS privacy pane", {
      enrollmentId: input.enrollment.id,
      pane: input.pane,
      exitCode: result.ok ? (result.exitCode ?? null) : null,
      timedOut: result.timedOut === true,
    });
  }
  return OpenMachinePrivacySettingsResponse.parse({
    opened,
    message: opened ? null : "The Mac isn't reachable right now.",
  });
}
