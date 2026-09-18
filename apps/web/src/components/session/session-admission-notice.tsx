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
  onRecheck,
}: {
  session: Session;
  canControl: boolean;
  paused: boolean;
  busy: boolean;
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
    if (pending.current || busy || paused || !canControl) return;
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
      {paused ? (
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
          {checking ? "Rechecking…" : "Recheck and resume"}
        </Button>
      ) : (
        <p className="mt-2">
          Someone with permission to control this session can recheck after the issue is resolved.
        </p>
      )}
      {failed ? (
        <p role="alert" className="mt-2">
          The recheck could not be confirmed. Check the session status before trying again.
        </p>
      ) : null}
    </Notice>
  );
}
