import { useState } from "react";
import type { KnowledgeOriginalFileDownload } from "@opengeni/sdk";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";

/** Download authority follows the selected Knowledge revision, including private originals. */
export function KnowledgeOriginalFile(props: {
  workspaceId: string;
  entryId: string;
  revisionId: string;
}) {
  const { client } = useAppContext();
  const [file, setFile] = useState<KnowledgeOriginalFileDownload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setBusy(true);
    setError(null);
    try {
      const result = await client.createKnowledgeFileDownloadUrl(
        props.workspaceId,
        props.entryId,
        props.revisionId,
      );
      if (!["http:", "https:"].includes(new URL(result.url).protocol))
        throw new Error("The original file URL is unavailable");
      setFile(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open the original file");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-3">
      {!file ? (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? "Opening file…" : error ? "Retry opening file" : "View retained file"}
        </Button>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="min-w-0 break-words">{file.filename}</span>
            <a
              href={file.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-fg-muted underline underline-offset-4"
            >
              Open original
            </a>
            <Button variant="ghost" size="sm" onClick={() => setFile(null)}>
              Close preview
            </Button>
          </div>
          {file.contentType.split(";")[0]?.trim().toLowerCase() === "application/pdf" ? (
            <object
              data={file.url}
              type="application/pdf"
              aria-label={`Original PDF: ${file.filename}`}
              className="h-[32rem] w-full rounded-md border border-border bg-white"
            >
              <p className="p-4 text-sm text-fg-muted">
                PDF preview is unavailable in this browser. Use Open original above to view the
                file.
              </p>
            </object>
          ) : file.contentType.startsWith("image/") ? (
            <img
              src={file.url}
              alt={file.filename}
              className="max-h-[32rem] max-w-full object-contain"
            />
          ) : (
            <p className="text-sm text-fg-muted">
              Use Open original to view this file in its application.
            </p>
          )}
        </>
      )}
      {error ? (
        <p role="alert" className="text-sm text-status-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
