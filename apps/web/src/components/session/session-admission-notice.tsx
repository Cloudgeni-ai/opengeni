import type { Session, SessionMachineAccess } from "@opengeni/sdk";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PersonalMachineExplanation } from "./session-machine-access-notice";
import { Button } from "@opengeni/react/ui/button";
import { Notice } from "@opengeni/react/ui/notice";

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

/** A rejected fenced request refreshes reads, never replays the mutation. */
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
  // Wait for both reads even when one rejects, so the pending state covers
  // the complete reconciliation. Preserve the original mutation failure.
  const reads = await Promise.allSettled(refresh.map((read) => read()));
  if (rejected) throw failure;
  if (reads.some((read) => read.status === "rejected")) {
    throw new Error("Session status could not be refreshed");
  }
}

// Read only the public reason and an exact permission classification. Older servers omit this projection;
// unknown future reasons get safe copy, never raw database diagnostics.
function admissionReason(session: Session): { reason: string; permissionDenied: boolean } | null {
  if (session.status !== "requires_action" || !("admissionBlock" in session)) return null;
  const block = session.admissionBlock;
  if (!block || typeof block !== "object") return null;
  return {
    reason: "reason" in block && typeof block.reason === "string" ? block.reason : "unknown",
    permissionDenied: "sqlState" in block && block.sqlState === "42501",
  };
}

function reasonCopy({ reason, permissionDenied }: { reason: string; permissionDenied: boolean }): {
  title: string;
  body: string;
  next: string;
  action: string;
} {
  switch (reason) {
    case "initiator_membership_required":
      return {
        title: "Workspace access needed",
        body: "The person who started this work needs workspace access. Your queued work is saved.",
        next: "Ask a workspace admin to restore their access, then recheck to continue. It will not retry automatically.",
        action: "Recheck access",
      };
    case "personal_resource_grant_required":
      return {
        title: "Resource permission needed",
        body: "A personal resource needed by this chat hasn't been authorized. Your queued work is saved.",
        next: "Ask its owner to grant access, or choose a resource you can use. Then recheck to continue. It will not retry automatically.",
        action: "Recheck access",
      };
    case "database_claim_rejected":
      if (permissionDenied)
        return {
          title: "Permission needed",
          body: "The next step was blocked by a permission check. Your queued work is saved.",
          next: "Check access to this chat's machine and resources with their owner or a workspace admin. After access changes, recheck to continue. It will not retry automatically.",
          action: "Recheck access",
        };
      // Other database rejections do not establish a permission problem.
      break;
    default:
      break;
  }
  return {
    title: "Couldn't start",
    body: "Opengeni couldn't start the next step. Your queued work is saved.",
    next: "Ask a workspace admin to investigate. Once the problem is fixed, try again. It will not retry automatically.",
    action: "Try again",
  };
}

export function SessionAdmissionNotice({
  session,
  canControl,
  paused,
  busy,
  refreshRequired = false,
  onRecheck,
  machineAccess,
  machineAction,
}: {
  session: Session;
  canControl: boolean;
  paused: boolean;
  busy: boolean;
  refreshRequired?: boolean;
  /** Existing authorized Resume request, followed by a fresh session read. */
  onRecheck: () => Promise<void>;
  machineAccess?: SessionMachineAccess | null;
  machineAction?: ReactNode;
}) {
  const descriptionId = useId();
  const pending = useRef(false);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [blockedMachine, setBlockedMachine] = useState<{
    sandboxId: string;
    blockedAt: string | undefined;
  } | null>(null);
  const reason = admissionReason(session);
  const machineBlocked =
    reason?.reason === "database_claim_rejected" &&
    reason.permissionDenied &&
    machineAccess?.queuedTurnBlocked === true;
  const blockedAt = session.admissionBlock?.blockedAt;
  const machineSandboxId = machineAccess?.sandboxId;
  useEffect(() => {
    if (machineBlocked && machineSandboxId) {
      setBlockedMachine((previous) =>
        previous?.sandboxId === machineSandboxId && previous.blockedAt === blockedAt
          ? previous
          : { sandboxId: machineSandboxId, blockedAt },
      );
    }
  }, [machineBlocked, machineSandboxId, blockedAt]);
  if (!reason) return null;
  const machineChanged =
    reason.reason === "database_claim_rejected" &&
    reason.permissionDenied &&
    !machineBlocked &&
    blockedMachine !== null &&
    blockedMachine.blockedAt === blockedAt &&
    blockedMachine.sandboxId !== session.activeSandboxId;
  const copy = machineChanged
    ? {
        title: "Machine changed",
        body: "The saved message has not started yet.",
        next: "Recheck access to try it on the selected machine. It will not retry automatically.",
        action: "Recheck access",
      }
    : reasonCopy(reason);

  async function recheck() {
    if (pending.current || busy || ((paused || machineBlocked) && !refreshRequired) || !canControl)
      return;
    pending.current = true;
    setChecking(true);
    setFailed(false);
    try {
      await onRecheck();
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setChecking(false);
    }
  }

  return (
    <Notice
      tone={machineChanged ? "waiting" : "failed"}
      title={machineBlocked ? "This message needs a different machine" : copy.title}
    >
      <div id={descriptionId} role="status" aria-live="polite">
        {machineBlocked && machineAccess ? (
          <PersonalMachineExplanation access={machineAccess} queued action={machineAction} />
        ) : (
          <>
            <p>{copy.body}</p>
            <p className="mt-1">{copy.next}</p>
          </>
        )}
      </div>
      {refreshRequired ? (
        <p className="mt-2">Session controls changed. Refresh the status before rechecking.</p>
      ) : null}
      {paused && !refreshRequired ? (
        <p className="mt-2">
          This workstream is also paused. Use the existing Resume controls when you are ready;
          rechecking does not clear that pause.
        </p>
      ) : canControl ? (
        <Button
          type="button"
          className="mt-2 min-h-11"
          disabled={busy || checking || (machineBlocked && !refreshRequired)}
          aria-busy={checking}
          aria-describedby={descriptionId}
          onClick={() => void recheck()}
        >
          {checking
            ? refreshRequired
              ? "Refreshing…"
              : "Rechecking…"
            : refreshRequired
              ? "Refresh session status"
              : copy.action}
        </Button>
      ) : (
        <p className="mt-2">
          Someone with permission to control this session can recheck after the issue is resolved.
        </p>
      )}
      {failed ? (
        <p role="alert" className="mt-2">
          {refreshRequired
            ? "Session status could not be refreshed. Try refreshing again."
            : "The recheck could not be confirmed. Check the session status before trying again."}
        </p>
      ) : null}
    </Notice>
  );
}
