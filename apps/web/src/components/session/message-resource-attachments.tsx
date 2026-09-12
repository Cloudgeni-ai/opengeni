import { DownloadIcon, FileJsonIcon, ImageIcon } from "lucide-react";
import { useLightboxOptional } from "@opengeni/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useAppContext } from "@/context";
import { cn } from "@/lib/utils";
import type { FileAsset, ResourceRef } from "@/types";
import { MessageFileSkeletons, MessageRepositoryChips } from "./message-resource-placeholders";
type FileResource = Extract<ResourceRef, { kind: "file" }>;

export default function MessageResourceAttachments({
  workspaceId,
  resources,
}: {
  workspaceId: string;
  resources: ResourceRef[];
}) {
  const fileResources = resources.filter(
    (resource): resource is FileResource => resource.kind === "file",
  );
  const { assets, ready } = useFileAssets(workspaceId, fileResources);
  const filesPending = fileResources.length > 0 && !ready;
  const imageResources = filesPending
    ? []
    : fileResources.filter((resource) => isImageAsset(assets.get(resource.fileId)));
  const otherFileResources = filesPending
    ? []
    : fileResources.filter((resource) => !isImageAsset(assets.get(resource.fileId)));
  const hasChips =
    otherFileResources.length > 0 || resources.some((resource) => resource.kind === "repository");
  return (
    <>
      {filesPending ? <MessageFileSkeletons resources={resources} /> : null}
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
          <MessageRepositoryChips resources={resources} />
        </div>
      ) : null}
    </>
  );
}

/** Fetch metadata as one batch; never flash an image as a file chip first. */
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

/** Signed image preview with lightbox and download; failures become file chips. */
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
          className="inline-flex shrink-0 items-center justify-center rounded p-0.5 outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:size-10"
        >
          <DownloadIcon className="size-3" />
        </button>
      </figcaption>
    </figure>
  );
}

/** File chip with the download-url affordance (signed URL on click). */
function MessageFileAttachment({
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
      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg-muted hover:text-fg disabled:opacity-60 pointer-coarse:min-h-10"
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
