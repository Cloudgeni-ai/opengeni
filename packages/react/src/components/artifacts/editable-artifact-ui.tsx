import type {
  EditableArtifactSession,
  EditableArtifactSyncView,
} from "@opengeni/sdk/editable-artifacts";
import { useEffect, useState } from "react";

export function useEditableArtifactView(
  session: EditableArtifactSession,
): EditableArtifactSyncView {
  const [view, setView] = useState(() => session.getView());
  useEffect(() => {
    setView(session.getView());
    return session.subscribe(setView);
  }, [session]);
  return view;
}

/** Changes whenever the Worker-resident speculative projection may have changed. */
export function editableArtifactProjectionKey(view: EditableArtifactSyncView): string {
  return [
    view.state,
    view.cursor,
    view.headSequence,
    view.pendingTransactions,
    view.blockedPending.map((entry) => `${entry.clientTransactionId}:${entry.code}`).join(","),
  ].join(":");
}

export function editableArtifactStatusLabel(view: EditableArtifactSyncView): string {
  switch (view.state) {
    case "idle":
    case "connecting":
      return "Connecting…";
    case "syncing":
    case "resyncing":
      return "Syncing…";
    case "reconnecting":
      return "Reconnecting…";
    case "unsupported":
      return "This artifact version is not supported";
    case "failed":
      if (editableArtifactAccessRevoked(view)) {
        return "You no longer have access to this artifact";
      }
      return view.lastError?.message ?? "Could not open this artifact";
    case "closed":
      return "Artifact session closed";
    case "live":
      return view.writable ? "Live" : "Live · Read only";
  }
}

/** Revoked read authority must hide any projection retained before invalidation. */
export function editableArtifactAccessRevoked(view: EditableArtifactSyncView): boolean {
  if (view.state !== "failed" || !view.lastError) return false;
  return (view.lastError as Error & Readonly<{ code?: unknown }>).code === "permission_changed";
}

export function EditableArtifactMessage({
  title,
  detail,
  retry,
}: {
  title: string;
  detail: string;
  retry?: (() => void) | undefined;
}) {
  return (
    <div className="grid h-full min-h-56 place-items-center bg-og-bg p-6 text-center">
      <div>
        <p className="text-og-base font-medium text-og-fg">{title}</p>
        <p className="mt-1 max-w-lg text-og-sm text-og-fg-muted">{detail}</p>
        {retry ? (
          <button
            type="button"
            onClick={retry}
            className="mt-3 rounded-og-sm bg-og-accent-deep px-3 py-1.5 text-og-sm font-medium text-og-accent-fg outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent"
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function asEditableArtifactError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}
