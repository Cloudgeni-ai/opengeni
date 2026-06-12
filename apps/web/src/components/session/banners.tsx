import { AlertTriangleIcon, ArrowLeftIcon, DownloadIcon, FileJsonIcon, GitBranchIcon, ImageIcon, TerminalIcon, WrenchIcon } from "lucide-react";
import type { UserMessageItem } from "@opengeni/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { MarkdownText } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";
import type { SessionFailureSummary } from "@/lib/events";
import { formatTimestamp } from "@/lib/format";
import { repositoryDisplayName } from "@/lib/session-tools";
import type { FileAsset, ResourceRef, Session } from "@/types";

export function TerminalSessionBanner(props: { session: Session; onNewSession: () => void }) {
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-zinc-500/30 bg-zinc-500/10 p-3 text-zinc-100 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-2.5">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-zinc-300" />
        <div className="min-w-0">
          <div className="text-sm font-medium">
            This session was cancelled and cannot be continued.
          </div>
          <div className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
            Historical session from {formatTimestamp(props.session.createdAt)}.
          </div>
        </div>
      </div>
      <Button type="button" size="sm" variant="secondary" onClick={props.onNewSession} className="shrink-0">
        <ArrowLeftIcon className="size-3.5" />
        Back to sessions
      </Button>
    </div>
  );
}

/**
 * Failure honesty: the reason the session failed, how often the platform
 * re-dispatched turns after worker deaths, and the fact that the composer
 * stays usable — sending a message revives the session.
 */
export function FailedSessionBanner({ failure }: { failure: SessionFailureSummary }) {
  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4 pt-4 sm:px-6">
      <div data-testid="failed-session-banner" className="flex gap-2.5 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-red-100">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-red-300" />
        <div className="min-w-0 text-sm">
          <span className="font-medium">This session failed{failure.failedAt ? ` ${formatTimestamp(failure.failedAt)}` : ""}.</span>{" "}
          {failure.reason ? (
            <span className="text-red-200/90">{failure.reason}</span>
          ) : (
            <span className="text-[color:var(--color-fg-muted)]">No failure detail was recorded.</span>
          )}
          <div className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
            {failure.redispatchCount > 0 ? (
              <>The platform re-dispatched {failure.redispatchCount} timed-out turn{failure.redispatchCount === 1 ? "" : "s"} after worker restarts before this failure. </>
            ) : null}
            {failure.failedTurnCount > 1 ? (
              <>{failure.failedTurnCount} turns have failed in this session. </>
            ) : null}
            The conversation history is preserved — send a message to revive the session and keep working.
          </div>
        </div>
      </div>
    </div>
  );
}

export function TerminalSessionArchive(props: { session: Session; eventCount: number }) {
  return (
    <div className="grid min-h-[18rem] place-items-center rounded-lg border border-dashed border-[color:var(--color-border)] px-4 py-10 text-center">
      <div className="max-w-md">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-md bg-[color:var(--color-surface-2)] text-[color:var(--color-fg-muted)]">
          <TerminalIcon className="size-4" />
        </div>
        <div className="text-sm font-medium">
          Historical cancelled session
        </div>
        <p className="mt-1 text-xs leading-5 text-[color:var(--color-fg-muted)]">
          This is a saved event log from {formatTimestamp(props.session.createdAt)}, not a current run. Sanitized debug metadata is available in the inspector.
        </p>
        <div className="mt-3 text-[11px] uppercase tracking-wide text-[color:var(--color-fg-subtle)]">
          {props.eventCount} timeline item{props.eventCount === 1 ? "" : "s"}
        </div>
      </div>
    </div>
  );
}

/** Attachment/repository/tool chips + markdown body inside the user bubble. */
export function UserMessageBody({ workspaceId, item }: { workspaceId: string; item: UserMessageItem }) {
  const fileResources = item.resources.filter((resource): resource is Extract<ResourceRef, { kind: "file" }> => resource.kind === "file");
  const repositoryResources = item.resources.filter((resource): resource is Extract<ResourceRef, { kind: "repository" }> => resource.kind === "repository");
  return (
    <div data-testid="timeline-user">
      {fileResources.length > 0 || repositoryResources.length > 0 || item.tools.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {fileResources.map((resource) => <MessageFileAttachment key={`${resource.fileId}:${resource.mountPath ?? ""}`} workspaceId={workspaceId} resource={resource} />)}
          {repositoryResources.map((resource) => (
            <span
              key={`${resource.uri}:${resource.ref}:${resource.mountPath ?? ""}`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-xs text-[color:var(--color-fg-muted)]"
            >
              <GitBranchIcon className="size-3.5 shrink-0" />
              <span className="truncate">{repositoryDisplayName(resource)}</span>
            </span>
          ))}
          {item.tools.map((tool) => (
            <span
              key={`${tool.kind}:${tool.id}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-xs text-[color:var(--color-fg-muted)]"
            >
              <WrenchIcon className="size-3.5" />
              <span>{tool.id}</span>
            </span>
          ))}
        </div>
      ) : null}
      <MarkdownText text={item.text} compact />
    </div>
  );
}

/** File chip with the download-url affordance (signed URL on click). */
export function MessageFileAttachment({ workspaceId, resource }: { workspaceId: string; resource: Extract<ResourceRef, { kind: "file" }> }) {
  const { client } = useAppContext();
  const [file, setFile] = useState<FileAsset | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    void client.getFile(workspaceId, resource.fileId).then((asset) => {
      if (mounted) {
        setFile(asset);
      }
    }).catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [client, workspaceId, resource.fileId]);

  async function openFile() {
    setBusy(true);
    try {
      const signed = await client.createFileDownloadUrl(workspaceId, resource.fileId);
      window.open(signed.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error("Failed to open file", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const isImage = file?.contentType.startsWith("image/");
  return (
    <button
      type="button"
      onClick={() => void openFile()}
      disabled={busy}
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-xs text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] disabled:opacity-60"
    >
      {isImage ? <ImageIcon className="size-3.5 shrink-0" /> : <FileJsonIcon className="size-3.5 shrink-0" />}
      <span className="truncate">{file?.filename ?? resource.fileId}</span>
      <DownloadIcon className="size-3 shrink-0" />
    </button>
  );
}
