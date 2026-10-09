import type { EditableArtifactSession } from "@opengeni/sdk/editable-artifacts";
import { DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ArtifactButton } from "./artifact-chrome";
import { useEditableArtifactView } from "./editable-artifact-ui";
import { useSpreadsheetSubmissions } from "./spreadsheet-submissions";

export type SpreadsheetDownload = (signal: AbortSignal) => Promise<Blob>;

export function SpreadsheetDownloadButton({
  session,
  title,
  download,
}: {
  session: EditableArtifactSession;
  title: string;
  download: SpreadsheetDownload;
}) {
  const view = useEditableArtifactView(session);
  const submissions = useSpreadsheetSubmissions();
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
        anchor.download = `${
          title
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
            .replace(/\.xlsx$/i, "")
            .trim() || "Workbook"
        }.xlsx`;
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
          Download failed. Try again.
        </span>
      ) : null}
      <ArtifactButton
        onClick={() => void start()}
        disabled={busy || !ready}
        title={ready ? "Download workbook as XLSX" : "Wait for workbook changes to sync"}
      >
        {busy ? (
          <LoaderCircleIcon className="animate-spin" aria-hidden />
        ) : (
          <DownloadIcon aria-hidden />
        )}
        {busy ? "Preparing…" : "Download"}
      </ArtifactButton>
    </>
  );
}
