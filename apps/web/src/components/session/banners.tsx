import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CreditCardIcon,
  DownloadIcon,
  FileJsonIcon,
  GitBranchIcon,
  ImageIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { useLightboxOptional, type UserMessageItem } from "@opengeni/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { MarkdownText } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/context";
import { capabilityChipLabel } from "@/lib/capabilities";
import type { SessionFailureSummary } from "@/lib/events";
import { formatTimestamp } from "@/lib/format";
import { repositoryDisplayName } from "@/lib/session-tools";
import { cn } from "@/lib/utils";
import type { FileAsset, ResourceRef, Session } from "@/types";

export function TerminalSessionBanner(props: { session: Session; onNewSession: () => void }) {
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-status-cancelled/30 bg-status-cancelled/10 p-3 text-status-cancelled sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-2.5">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-status-cancelled" />
        <div className="min-w-0">
          <div className="text-sm font-medium">
            This session was cancelled and cannot be continued.
          </div>
          <div className="mt-1 text-xs text-fg-muted">
            Started {formatTimestamp(props.session.createdAt)}.
          </div>
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={props.onNewSession}
        className="shrink-0"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to sessions
      </Button>
    </div>
  );
}

/**
 * Failure honesty: the reason the session failed, how many turns timed out and
 * were retried automatically before it, and the fact that the composer stays
 * usable — sending a message revives the session.
 *
 * Credit exhaustion gets its own copy: "send a message to revive" is a lie
 * when the workspace has no credits (the revive turn dies the same death), so
 * the banner points at the actual fix — the organization's Credits section.
 */
export function FailedSessionBanner({
  failure,
  creditExhausted,
  workspaceId,
}: {
  failure: SessionFailureSummary;
  creditExhausted?: boolean;
  workspaceId?: string;
}) {
  if (creditExhausted) {
    return (
      <div className="mx-auto mb-2 w-full max-w-3xl px-4 pt-4 sm:px-6">
        <div
          data-testid="failed-session-banner"
          className="flex flex-col gap-3 rounded-lg border border-status-failed/30 bg-status-failed/10 p-3 text-status-failed sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 gap-2.5">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-status-failed" />
            <div className="min-w-0 text-sm">
              <span className="font-medium">
                This workspace is out of OpenGeni credits
                {failure.failedAt ? ` (since ${formatTimestamp(failure.failedAt)})` : ""}.
              </span>
              <div className="mt-1 text-xs text-fg-muted">
                The conversation history is preserved. Add credits to the organization, then keep
                working from right here.
              </div>
            </div>
          </div>
          {workspaceId ? (
            <Button asChild type="button" size="sm" variant="secondary" className="shrink-0">
              <Link to="/workspaces/$workspaceId/organization" params={{ workspaceId }}>
                <CreditCardIcon className="size-3.5" />
                Add credits
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4 pt-4 sm:px-6">
      <div
        data-testid="failed-session-banner"
        className="flex gap-2.5 rounded-lg border border-status-failed/30 bg-status-failed/10 p-3 text-status-failed"
      >
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-status-failed" />
        <div className="min-w-0 text-sm">
          <span className="font-medium">
            This session failed{failure.failedAt ? ` ${formatTimestamp(failure.failedAt)}` : ""}.
          </span>{" "}
          {failure.reason ? (
            <span className="text-status-failed/90">{failure.reason}</span>
          ) : (
            <span className="text-fg-muted">No failure detail was recorded.</span>
          )}
          <div className="mt-1 text-xs text-fg-muted">
            {failure.redispatchCount > 0 ? (
              <>
                {failure.redispatchCount} turn{failure.redispatchCount === 1 ? "" : "s"} timed out
                and {failure.redispatchCount === 1 ? "was" : "were"} retried automatically before
                this failure.{" "}
              </>
            ) : null}
            {failure.failedTurnCount > 1 ? (
              <>{failure.failedTurnCount} turns have failed in this session. </>
            ) : null}
            The conversation history is preserved — send a message to revive the session and keep
            working.
          </div>
        </div>
      </div>
    </div>
  );
}

export function TerminalSessionArchive(props: { session: Session; eventCount: number }) {
  return (
    <div className="grid min-h-[18rem] place-items-center rounded-lg border border-dashed border-border px-4 py-10 text-center">
      <div className="max-w-md">
        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-md bg-surface-2 text-fg-muted">
          <TerminalIcon className="size-4" />
        </div>
        <div className="text-sm font-medium">Cancelled session (read-only)</div>
        <p className="mt-1 text-xs leading-5 text-fg-muted">
          This is a saved event log from {formatTimestamp(props.session.createdAt)}, not a current
          run. Sanitized debug metadata is available in the inspector.
        </p>
        <div className="mt-3 text-2xs uppercase tracking-wide text-fg-subtle">
          {props.eventCount} timeline item{props.eventCount === 1 ? "" : "s"}
        </div>
      </div>
    </div>
  );
}

type FileResource = Extract<ResourceRef, { kind: "file" }>;

/**
 * Fetch the {@link FileAsset} for each attached file in one batch. The map is
 * empty while loading and populated all at once (a file whose lookup failed maps
 * to `null`), so the UI never flickers attachment-by-attachment. Keyed on the
 * concatenated ids so re-renders with the same attachments don't refetch.
 */
function useFileAssets(
  workspaceId: string,
  resources: FileResource[],
): { assets: Map<string, FileAsset | null>; ready: boolean } {
  const { client } = useAppContext();
  // The map remembers WHICH id-key it was fetched for: when the attachments
  // change, the stale map must not masquerade as this message's metadata while
  // the new fetch is in flight (previews briefly showed the previous message's
  // files). `ready` is key-matched, never inferred from map size.
  const [loaded, setLoaded] = useState<{ key: string; assets: Map<string, FileAsset | null> }>({
    key: "",
    assets: new Map(),
  });
  const key = resources.map((resource) => resource.fileId).join(",");
  useEffect(() => {
    let mounted = true;
    const ids = key ? key.split(",") : [];
    if (ids.length === 0) {
      setLoaded({ key, assets: new Map() });
      return;
    }
    void Promise.all(
      ids.map(async (id): Promise<readonly [string, FileAsset | null]> => {
        try {
          return [id, await client.getFile(workspaceId, id)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((entries) => {
      if (mounted) {
        setLoaded({ key, assets: new Map(entries) });
      }
    });
    return () => {
      mounted = false;
    };
  }, [client, workspaceId, key]);
  return { assets: loaded.key === key ? loaded.assets : new Map(), ready: loaded.key === key };
}

function isImageAsset(asset: FileAsset | null | undefined): boolean {
  return Boolean(asset?.contentType.startsWith("image/"));
}

/** Attachment previews/chips + repository/tool chips + markdown body inside the user bubble. */
export function UserMessageBody({
  workspaceId,
  item,
  resolveCapabilityName,
}: {
  workspaceId: string;
  item: UserMessageItem;
  /** Real capability name for a tool chip (from the workspace catalog), or null. */
  resolveCapabilityName?: (mcpServerId: string) => string | null;
}) {
  const fileResources = item.resources.filter(
    (resource): resource is FileResource => resource.kind === "file",
  );
  const repositoryResources = item.resources.filter(
    (resource): resource is Extract<ResourceRef, { kind: "repository" }> =>
      resource.kind === "repository",
  );
  const { assets, ready } = useFileAssets(workspaceId, fileResources);
  // A single all-at-once populate: until THIS message's fetch lands every file
  // is "pending" and renders as a neutral skeleton, so an image never briefly
  // shows as a file chip — or as the PREVIOUS message's file — before its
  // preview resolves.
  const filesPending = fileResources.length > 0 && !ready;
  const imageResources = filesPending
    ? []
    : fileResources.filter((resource) => isImageAsset(assets.get(resource.fileId)));
  const otherFileResources = filesPending
    ? []
    : fileResources.filter((resource) => !isImageAsset(assets.get(resource.fileId)));
  const hasChips =
    otherFileResources.length > 0 || repositoryResources.length > 0 || item.tools.length > 0;

  return (
    <div data-testid="timeline-user">
      {filesPending ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {fileResources.map((resource) => (
            <span
              key={resource.fileId}
              className="h-7 w-28 animate-pulse rounded-md border border-border bg-surface-2"
            />
          ))}
        </div>
      ) : null}

      {imageResources.length > 0 ? (
        <div
          className={cn(
            "mb-2",
            imageResources.length === 1 ? "max-w-md" : "grid grid-cols-2 gap-2",
          )}
        >
          {imageResources.map((resource) => (
            <MessageImagePreview
              key={`${resource.fileId}:${resource.mountPath ?? ""}`}
              workspaceId={workspaceId}
              resource={resource}
              asset={assets.get(resource.fileId) as FileAsset}
              grid={imageResources.length > 1}
            />
          ))}
        </div>
      ) : null}

      {hasChips ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {otherFileResources.map((resource) => (
            <MessageFileAttachment
              key={`${resource.fileId}:${resource.mountPath ?? ""}`}
              workspaceId={workspaceId}
              resource={resource}
              asset={assets.get(resource.fileId) ?? undefined}
            />
          ))}
          {repositoryResources.map((resource) => (
            <span
              key={`${resource.uri}:${resource.ref}:${resource.mountPath ?? ""}`}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg-muted"
            >
              <GitBranchIcon className="size-3.5 shrink-0" />
              <span className="truncate">{repositoryDisplayName(resource)}</span>
            </span>
          ))}
          {item.tools.map((tool) => (
            <span
              key={`${tool.kind}:${tool.id}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg-muted"
            >
              <WrenchIcon className="size-3.5 shrink-0" />
              <span className="truncate">
                {resolveCapabilityName?.(tool.id) ?? capabilityChipLabel(tool.id)}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      <MarkdownText text={item.text} compact />
    </div>
  );
}

/**
 * An inline image attachment: a constrained, rounded preview (object-contain,
 * capped height) that opens the full image in the shared lightbox — or a new tab
 * when no lightbox is mounted. A subtle caption carries the filename and a
 * download affordance. A signed URL that fails or expires falls back to the file
 * card rather than a broken-image glyph.
 */
function MessageImagePreview({
  workspaceId,
  resource,
  asset,
  grid,
}: {
  workspaceId: string;
  resource: FileResource;
  asset: FileAsset;
  grid: boolean;
}) {
  const { client } = useAppContext();
  const lightbox = useLightboxOptional();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    // Same mounted instance, new file (virtualized/reused rows): the previous
    // attachment's url/failed/loaded must never bleed into this one.
    setUrl(null);
    setFailed(false);
    setLoaded(false);
    void client
      .createFileDownloadUrl(workspaceId, resource.fileId)
      .then((signed) => {
        if (mounted) {
          setUrl(signed.url);
        }
      })
      .catch(() => {
        if (mounted) {
          setFailed(true);
        }
      });
    return () => {
      mounted = false;
    };
  }, [client, workspaceId, resource.fileId]);

  // A dead/expired signed URL degrades to the plain file card — never a broken image.
  if (failed) {
    return <MessageFileAttachment workspaceId={workspaceId} resource={resource} asset={asset} />;
  }

  const openFull = () => {
    if (!url) {
      return;
    }
    if (lightbox) {
      lightbox.open(url, asset.filename);
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  async function download() {
    try {
      const signed = await client.createFileDownloadUrl(workspaceId, resource.fileId);
      window.open(signed.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error("Failed to download image", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <figure className="m-0 min-w-0">
      <button
        type="button"
        onClick={openFull}
        aria-label={`Open ${asset.filename}`}
        className="block w-full overflow-hidden rounded-lg border border-border bg-surface outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {url ? (
          <img
            src={url}
            alt={asset.filename}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={cn(
              "w-full transition-opacity duration-200",
              grid ? "h-36 object-cover" : "max-h-80 object-contain",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        ) : (
          <div className={cn("w-full animate-pulse bg-surface-2", grid ? "h-36" : "h-40")} />
        )}
      </button>
      <figcaption className="mt-1 flex items-center gap-1.5 px-0.5 text-2xs text-fg-subtle">
        <ImageIcon className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={asset.filename}>
          {asset.filename}
        </span>
        <button
          type="button"
          onClick={() => void download()}
          aria-label={`Download ${asset.filename}`}
          className="shrink-0 rounded p-0.5 outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-ring"
        >
          <DownloadIcon className="size-3" />
        </button>
      </figcaption>
    </figure>
  );
}

/** File chip with the download-url affordance (signed URL on click). */
export function MessageFileAttachment({
  workspaceId,
  resource,
  asset: preloaded,
}: {
  workspaceId: string;
  resource: FileResource;
  /** When the parent already fetched the asset, skip the redundant lookup. */
  asset?: FileAsset | undefined;
}) {
  const { client } = useAppContext();
  const [file, setFile] = useState<FileAsset | null>(preloaded ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (preloaded) {
      setFile(preloaded);
      return;
    }
    let mounted = true;
    void client
      .getFile(workspaceId, resource.fileId)
      .then((asset) => {
        if (mounted) {
          setFile(asset);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [client, workspaceId, resource.fileId, preloaded]);

  async function openFile() {
    setBusy(true);
    try {
      const signed = await client.createFileDownloadUrl(workspaceId, resource.fileId);
      window.open(signed.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error("Failed to open file", {
        description: error instanceof Error ? error.message : String(error),
      });
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
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg-muted hover:text-fg disabled:opacity-60"
    >
      {isImage ? (
        <ImageIcon className="size-3.5 shrink-0" />
      ) : (
        <FileJsonIcon className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{file?.filename ?? resource.fileId}</span>
      <DownloadIcon className="size-3 shrink-0" />
    </button>
  );
}
