import type {
  EditableArtifactSession,
  EditableArtifactSyncView,
} from "@opengeni/sdk/editable-artifacts";
import { useEffect, useState } from "react";
import { type OpenGeniText } from "../../messages/runtime";
import { useOpenGeniText } from "../../messages/runtime";

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

export function editableArtifactStatusLabel(
  t: OpenGeniText,
  view: EditableArtifactSyncView,
): string {
  switch (view.state) {
    case "idle":
    case "connecting":
      return t("artifacts.editableArtifactUi.connecting");
    case "syncing":
    case "resyncing":
      return t("artifacts.editableArtifactUi.syncing");
    case "reconnecting":
      return t("artifacts.editableArtifactUi.reconnecting");
    case "unsupported":
      return t("artifacts.editableArtifactUi.thisArtifactVersionIsNot");
    case "failed":
      if (editableArtifactAccessRevoked(view)) {
        return t("artifacts.editableArtifactUi.youNoLongerHaveAccess");
      }
      return view.lastError?.message ?? t("artifacts.editableArtifactUi.couldNotOpenThisArtifact");
    case "closed":
      return t("artifacts.editableArtifactUi.artifactSessionClosed");
    case "live":
      return view.writable
        ? t("artifacts.editableArtifactUi.live")
        : t("artifacts.editableArtifactUi.liveReadOnly");
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
  retryLabel: retryLabelProp,
}: {
  title: string;
  detail: string;
  retry?: (() => void) | undefined;
  retryLabel?: string | undefined;
}) {
  const t = useOpenGeniText();
  const retryLabel =
    retryLabelProp === undefined ? t("artifacts.editableArtifactUi.retry") : retryLabelProp;
  return (
    <div className="grid h-full min-h-56 place-items-center bg-og-bg p-6 text-center">
      <div>
        <p className="text-og-base font-medium text-og-fg">{title}</p>
        <p className="mt-1 max-w-lg text-og-sm text-og-fg-muted">{detail}</p>
        {retry ? (
          <button
            type="button"
            onClick={retry}
            className="mt-3 rounded-og-sm border border-og-primary-border bg-og-primary text-og-primary-fg px-3 py-1.5 text-og-sm font-medium hover:bg-og-primary-hover outline-hidden focus-visible:ring-2 focus-visible:ring-og-accent"
          >
            {retryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function asEditableArtifactError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(fallback);
}
