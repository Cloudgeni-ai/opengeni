import { useEffect, useMemo, useState } from "react";
import type { KnowledgeOriginalFileDownload } from "@opengeni/sdk";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";

/** Download authority follows the selected Knowledge revision, including private originals. */
export function KnowledgeOriginalFile(props: {
  workspaceId: string;
  entryId: string;
  revisionId: string;
  autoOpen?: boolean;
  extractedText?: string;
}) {
  const { client, accessContext, workspaceStateOwnerId } = useAppContext();
  // Reset both the URL and pending response synchronously when its authority changes.
  const lifetime = useMemo(
    () => crypto.randomUUID(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- each identity fences original-file authority
    [
      client,
      accessContext,
      workspaceStateOwnerId,
      props.workspaceId,
      props.entryId,
      props.revisionId,
    ],
  );
  return <OriginalFilePreview key={lifetime} {...props} client={client} />;
}

function OriginalFilePreview(props: {
  workspaceId: string;
  entryId: string;
  revisionId: string;
  autoOpen?: boolean;
  extractedText?: string;
  client: ReturnType<typeof useAppContext>["client"];
}) {
  const [requested, setRequested] = useState(props.autoOpen ?? false);
  const [retry, setRetry] = useState(0);
  const [file, setFile] = useState<KnowledgeOriginalFileDownload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!requested) return;
    let current = true;
    setBusy(true);
    setError(null);
    void props.client
      .createKnowledgeFileDownloadUrl(props.workspaceId, props.entryId, props.revisionId)
      .then((result) => {
        if (!["http:", "https:"].includes(new URL(result.url).protocol))
          throw new Error("The original file URL is unavailable");
        if (current) setFile(result);
      })
      .catch((reason: unknown) => {
        if (current)
          setError(reason instanceof Error ? reason.message : "Could not open the original file");
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [props.client, props.workspaceId, props.entryId, props.revisionId, requested, retry]);
  return (
    <div className="grid gap-3">
      {!file ? (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={busy}
          onClick={() => {
            setRequested(true);
            setRetry((value) => value + 1);
          }}
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setRequested(false);
                setFile(null);
              }}
            >
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
      {props.extractedText !== undefined ? (
        <details className="border-y border-border py-3">
          <summary className="cursor-pointer text-sm font-medium">Extracted text</summary>
          <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">
            {props.extractedText ||
              "No extracted text is available. You can still open the original file."}
          </div>
        </details>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-status-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
