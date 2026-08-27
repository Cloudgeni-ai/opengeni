import type { CompanyBrainOkfDownload, OpenGeniClient } from "@opengeni/sdk";
import { DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";

type CompanyBrainExportClient = Pick<OpenGeniClient, "exportCompanyBrainOkf">;

export function saveCompanyBrainOkf(download: CompanyBrainOkfDownload): void {
  const blob = new Blob([download.content], { type: download.contentType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = download.filename;
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function CompanyBrainExportButton({
  client,
  workspaceId,
  save = saveCompanyBrainOkf,
}: {
  client: CompanyBrainExportClient;
  workspaceId: string;
  save?: (download: CompanyBrainOkfDownload) => void;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function exportPackage(): Promise<void> {
    setStatus("loading");
    setError(null);
    try {
      save(await client.exportCompanyBrainOkf(workspaceId));
      setStatus("success");
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
      setStatus("error");
    }
  }

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <button
        type="button"
        aria-busy={status === "loading"}
        disabled={status === "loading"}
        onClick={() => void exportPackage()}
        className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-xs font-medium text-fg transition-colors hover:bg-surface-2 disabled:cursor-wait disabled:opacity-60"
      >
        {status === "loading" ? (
          <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin" />
        ) : (
          <DownloadIcon aria-hidden="true" className="size-3.5" />
        )}
        {status === "loading" ? "Preparing export…" : "Export OKF"}
      </button>
      <span aria-live="polite" className="max-w-xs text-xs text-fg-muted">
        {status === "success"
          ? "Permission-filtered Agent Knowledge package downloaded."
          : status === "error"
            ? `Export failed: ${error}`
            : "Includes authorized guidance bodies and explicit omission facts."}
      </span>
    </div>
  );
}
