import type { EditableArtifactSession } from "@opengeni/sdk/editable-artifacts";
import { DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ArtifactButton } from "./artifact-chrome";
import { useArtifactSubmissions } from "./artifact-submissions";
import { useEditableArtifactView } from "./editable-artifact-ui";
import { useOpenGeniText } from "../../messages/runtime";

/** Host-authenticated export of the saved native head as an Office file. */
export type EditableArtifactDownload = (signal: AbortSignal) => Promise<Blob>;
export type EditableArtifactDownloadFormat = "xlsx" | "docx" | "pptx";

const LABELS = {
  xlsx: {
    download: "artifacts.spreadsheetDownload.download",
    preparing: "artifacts.spreadsheetDownload.preparing",
    failed: "artifacts.spreadsheetDownload.downloadFailedTryAgain",
    title: "artifacts.spreadsheetDownload.downloadWorkbookAsXlsx",
    wait: "artifacts.spreadsheetDownload.waitForWorkbookChangesTo",
    fallbackName: "artifacts.spreadsheetDownload.workbook",
  },
  docx: {
    download: "artifacts.artifactDownload.download",
    preparing: "artifacts.artifactDownload.preparing",
    failed: "artifacts.artifactDownload.downloadFailedTryAgain",
    title: "artifacts.artifactDownload.downloadDocumentAsDocx",
    wait: "artifacts.artifactDownload.waitForDocumentChangesTo",
    fallbackName: "artifacts.artifactDownload.document",
  },
  pptx: {
    download: "artifacts.artifactDownload.download",
    preparing: "artifacts.artifactDownload.preparing",
    failed: "artifacts.artifactDownload.downloadFailedTryAgain",
    title: "artifacts.artifactDownload.downloadPresentationAsPptx",
    wait: "artifacts.artifactDownload.waitForPresentationChangesTo",
    fallbackName: "artifacts.artifactDownload.presentation",
  },
} as const;

/**
 * Download action shared by every editable modality. It waits for live sync
 * with no pending or still-submitting edits, so the export is the latest head.
 */
export function EditableArtifactDownloadButton({
  session,
  title,
  download,
  format,
}: {
  session: EditableArtifactSession;
  title: string;
  download: EditableArtifactDownload;
  format: EditableArtifactDownloadFormat;
}) {
  const t = useOpenGeniText();
  const labels = LABELS[format];
  const view = useEditableArtifactView(session);
  const submissions = useArtifactSubmissions();
  const submitting = useSyncExternalStore(
    submissions.subscribe,
    submissions.getPending,
    submissions.getPending,
  );
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const ready =
    view.state === "live" &&
    submitting === 0 &&
    view.pendingTransactions === 0 &&
    view.blockedPending.length === 0 &&
    !view.authoringBlockedReason;
  useEffect(() => () => active.current?.abort(), [session]);
  useEffect(() => {
    if (view.state === "failed" || view.state === "closed") {
      active.current?.abort();
      active.current = null;
      setBusy(false);
    }
  }, [view.state]);

  const start = async () => {
    if (active.current || !ready || submissions.getPending()) return;
    // Re-read the live view: a just-committed edit may precede React's next render.
    const current = session.getView();
    if (
      current.state !== "live" ||
      current.pendingTransactions ||
      current.blockedPending.length ||
      current.authoringBlockedReason
    )
      return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(false);
    try {
      const blob = await download(controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = downloadFileName(title, format, t(labels.fallbackName));
        anchor.rel = "noopener";
        anchor.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) {
        active.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <>
      {error ? (
        <span role="alert" className="text-og-xs text-og-fg-muted">
          {t(labels.failed)}
        </span>
      ) : null}
      <ArtifactButton
        onClick={() => void start()}
        disabled={busy || !ready}
        title={ready ? t(labels.title) : t(labels.wait)}
      >
        {busy ? (
          <LoaderCircleIcon className="animate-spin" aria-hidden />
        ) : (
          <DownloadIcon aria-hidden />
        )}
        {busy ? t(labels.preparing) : t(labels.download)}
      </ArtifactButton>
    </>
  );
}

/** Safe local file name: the artifact title with exactly one matching extension. */
export function downloadFileName(
  title: string,
  format: EditableArtifactDownloadFormat,
  fallback: string,
): string {
  const base =
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(new RegExp(`\\.${format}$`, "i"), "")
      .trim() || fallback;
  return `${base}.${format}`;
}
