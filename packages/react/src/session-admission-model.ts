// Renderer-neutral model for "why didn't my message start?": an admission
// block on the session (the runtime refused to start the next queued turn) and
// the personal-machine explanation behind the most common one (a shared chat
// that runs on somebody else's personal machine). Web (`@opengeni/react/session-ui`)
// and React Native render the same words from the message catalog, so a host
// translates them once (`sessionAdmission.*`).
import type { MachineView, Session, SessionMachineAccess } from "@opengeni/sdk";
import type { OpenGeniText } from "./messages/runtime";

/** Whether a Connected Machine can take work right now. Offline, reconnecting
 *  and enrolling machines cannot; a machine without screen-control consent can
 *  still run compute. */
export function isMachineComputeSelectable(state: string): boolean {
  return state === "online" || state === "display_unavailable" || state === "consent_required";
}

/** A machine-list response is useful only while it names the session's current pointer. */
export function currentSessionMachineAccess(
  access: SessionMachineAccess | null | undefined,
  activeSandboxId: string | null | undefined,
): SessionMachineAccess | null {
  return access && access.sandboxId === activeSandboxId ? access : null;
}

export type SessionAdmissionReason = {
  /** The public reason; unknown future reasons arrive as their own string. */
  reason: string;
  /** The refusal was a permission check (SQLSTATE 42501). */
  permissionDenied: boolean;
};

/**
 * The admission block a person should see, or null. Older servers omit the
 * projection, and a stale block on a session that is no longer waiting is
 * ignored. Never exposes raw database diagnostics.
 */
export function sessionAdmissionReason(
  session: Pick<Session, "status"> & { admissionBlock?: unknown },
): SessionAdmissionReason | null {
  if (session.status !== "requires_action") return null;
  const block = session.admissionBlock;
  if (!block || typeof block !== "object") return null;
  return {
    reason: "reason" in block && typeof block.reason === "string" ? block.reason : "unknown",
    permissionDenied: "sqlState" in block && block.sqlState === "42501",
  };
}

/** The saved message was refused because only the machine's owner may start work on it. */
export function sessionAdmissionNeedsDifferentMachine(
  reason: SessionAdmissionReason | null,
  access: SessionMachineAccess | null | undefined,
): boolean {
  return (
    reason?.reason === "database_claim_rejected" &&
    reason.permissionDenied &&
    access?.queuedTurnBlocked === true
  );
}

/**
 * Machines that can take the saved message. Accepted messages keep the
 * personal-resource permissions they were sent with, so a personal machine
 * chosen now could not run them: offer the session's own cloud machine and
 * workspace or organization machines that are reachable.
 */
export function savedMessageMachineChoices(machines: readonly MachineView[]): MachineView[] {
  return machines.filter(
    (machine) =>
      !machine.active &&
      (machine.isSessionGroup || machine.scope !== "user") &&
      isMachineComputeSelectable(machine.state),
  );
}

export type SessionAdmissionCopy = {
  title: string;
  body: string;
  next: string;
  /** The recheck button label. */
  action: string;
};

/** Words for an admission block that is not (or not known to be) a machine-owner refusal. */
export function sessionAdmissionCopy(
  t: OpenGeniText,
  { reason, permissionDenied }: SessionAdmissionReason,
): SessionAdmissionCopy {
  switch (reason) {
    case "initiator_membership_required":
      return {
        title: t("sessionAdmission.membershipTitle"),
        body: t("sessionAdmission.membershipBody"),
        next: t("sessionAdmission.membershipNext"),
        action: t("sessionAdmission.recheckAccess"),
      };
    case "personal_resource_grant_required":
      return {
        title: t("sessionAdmission.grantTitle"),
        body: t("sessionAdmission.grantBody"),
        next: t("sessionAdmission.grantNext"),
        action: t("sessionAdmission.recheckAccess"),
      };
    case "database_claim_rejected":
      if (permissionDenied)
        return {
          title: t("sessionAdmission.permissionTitle"),
          body: t("sessionAdmission.permissionBody"),
          next: t("sessionAdmission.permissionNext"),
          action: t("sessionAdmission.recheckAccess"),
        };
      // Other database rejections do not establish a permission problem.
      break;
    default:
      break;
  }
  return {
    title: t("sessionAdmission.genericTitle"),
    body: t("sessionAdmission.genericBody"),
    next: t("sessionAdmission.genericNext"),
    action: t("sessionAdmission.tryAgain"),
  };
}

/** After a refusal, the session moved to another machine: the saved message can be rechecked there. */
export function sessionAdmissionMachineChangedCopy(t: OpenGeniText): SessionAdmissionCopy {
  return {
    title: t("sessionAdmission.machineChangedTitle"),
    body: t("sessionAdmission.machineChangedBody"),
    next: t("sessionAdmission.machineChangedNext"),
    action: t("sessionAdmission.recheckAccess"),
  };
}

export type PersonalMachineCopy = {
  /** Whose machine this chat runs on, and who may start work there. */
  explanation: string;
  /** What happens to the person's words, and the ways forward. */
  next: string;
  /** A message the person can send the owner themselves; null for the owner. */
  ownerRequest: string | null;
  /** "Copy request to …" button label; null for the owner. */
  copyRequest: string | null;
};

/**
 * Explain a chat that runs on a personal machine. `queued` is a saved message
 * the runtime refused; otherwise it is a draft the person has not sent yet.
 */
export function personalMachineCopy(
  t: OpenGeniText,
  access: Pick<SessionMachineAccess, "machineName" | "ownerName" | "isOwner">,
  { queued }: { queued: boolean },
): PersonalMachineCopy {
  const machine = access.machineName;
  if (access.isOwner) {
    return {
      explanation: t("sessionAdmission.ownMachineExplanation", { machine }),
      next: queued
        ? t("sessionAdmission.ownMachineQueuedNext")
        : t("sessionAdmission.ownMachineDraftNext"),
      ownerRequest: null,
      copyRequest: null,
    };
  }
  const owner = access.ownerName?.trim() || t("sessionAdmission.theMachineOwner");
  return {
    explanation: t("sessionAdmission.otherMachineExplanation", { owner, machine }),
    next: queued
      ? t("sessionAdmission.otherMachineQueuedNext", { owner })
      : t("sessionAdmission.otherMachineDraftNext", { owner }),
    ownerRequest: t("sessionAdmission.ownerRequest", { machine }),
    copyRequest: t("sessionAdmission.copyRequestTo", { owner }),
  };
}

/** Stream, detail, and mutation receipts can arrive in different orders. */
export function admissionRecheckControl(
  sessionControl: Session["effectiveControl"],
  ...observed: (Session["effectiveControl"] | null | undefined)[]
): Session["effectiveControl"] {
  return observed.reduce<Session["effectiveControl"]>((latest, candidate) => {
    if (!candidate) return latest;
    if (candidate.controlVersion > latest.controlVersion) return candidate;
    // A tie must not turn a known pause into an actionable recheck.
    if (candidate.controlVersion === latest.controlVersion && candidate.state === "paused") {
      return candidate;
    }
    return latest;
  }, sessionControl);
}

export function admissionControlNeedsRefresh(
  control: Session["effectiveControl"],
  ...observed: (Session["effectiveControl"] | null | undefined)[]
): boolean {
  return observed.some(
    (candidate) =>
      candidate?.controlVersion === control.controlVersion &&
      (candidate.state !== control.state || candidate.controlEtag !== control.controlEtag),
  );
}

/**
 * Recheck a blocked session: one fenced Resume (the server refuses it if the
 * session's control changed since `control` was read), then every read. A
 * rejected Resume refreshes the reads and is never replayed, so the saved
 * message cannot be sent twice.
 */
export async function recheckSessionAdmission({
  control,
  refreshOnly,
  resume,
  refresh,
}: {
  control: Session["effectiveControl"];
  refreshOnly: boolean;
  resume: (control: Session["effectiveControl"]) => Promise<unknown>;
  refresh: (() => Promise<void>)[];
}): Promise<void> {
  let rejected = false;
  let failure: unknown;
  if (!refreshOnly && control.state !== "paused") {
    try {
      await resume(control);
    } catch (error) {
      rejected = true;
      failure = error;
    }
  }
  // Wait for every read even when one rejects, so the pending state covers
  // the complete reconciliation. Preserve the original mutation failure.
  const reads = await Promise.allSettled(refresh.map((read) => read()));
  if (rejected) throw failure;
  if (reads.some((read) => read.status === "rejected")) {
    throw new Error("Session status could not be refreshed");
  }
}
