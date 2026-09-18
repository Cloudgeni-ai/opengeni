import type { Session } from "@opengeni/sdk";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

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

// Read only the public reason. Older servers omit this optional projection;
// unknown future reasons get safe copy, never raw database diagnostics.
function admissionReason(session: Session): string | null {
  if (session.status !== "requires_action" || !("admissionBlock" in session)) return null;
  const block = session.admissionBlock;
  if (!block || typeof block !== "object") return null;
  return "reason" in block && typeof block.reason === "string" ? block.reason : "unknown";
}

function reasonCopy(reason: string): string {
  switch (reason) {
    case "initiator_membership_required":
      return "The person who started this work needs active workspace access before it can continue.";
    case "personal_resource_grant_required":
      return "Access to a personal resource needed by this work must be restored before it can continue.";
    default:
      return "This work could not start because a required access or safety check did not pass.";
  }
}

export function SessionAdmissionNotice({
  session,
  canControl,
  paused,
  busy,
  refreshRequired = false,
  onRecheck,
}: {
  session: Session;
  canControl: boolean;
  paused: boolean;
  busy: boolean;
  refreshRequired?: boolean;
  /** Existing authorized Resume request, followed by a fresh session read. */
  onRecheck: () => Promise<void>;
}) {
  const descriptionId = useId();
  const pending = useRef(false);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const reason = admissionReason(session);
  if (!reason) return null;

  async function recheck() {
    if (pending.current || busy || (paused && !refreshRequired) || !canControl) return;
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
    <Notice tone="waiting" title="Work needs attention">
      <div id={descriptionId} role="status" aria-live="polite">
        <p>{reasonCopy(reason)}</p>
        <p className="mt-1">
          After the issue is resolved, recheck to try this work again. It will not retry
          automatically.
        </p>
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
          variant="outline"
          className="mt-2 min-h-11"
          disabled={busy || checking}
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
              : "Recheck and resume"}
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
