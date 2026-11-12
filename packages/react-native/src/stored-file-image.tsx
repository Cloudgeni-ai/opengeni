import type { FileAsset, ResourceRef } from "@opengeni/sdk";
import {
  useStoredFilePreview,
  useStoredFiles,
  type StoredFileSource,
} from "@opengeni/react/session";
import type { ReactNode } from "react";
import { Image, type ImageProps, type ImageStyle, type StyleProp } from "react-native";
import { nativeAttachmentKind, type NativeAttachment } from "./attachments";

/**
 * An attached image: the local photo while it is there, otherwise (after a
 * reload, on another device, in the queue) the stored copy from the server.
 * Renders `fallback` while it loads or when it cannot be shown.
 */
export function StoredFileImage({
  source,
  file,
  localUri,
  style,
  resizeMode = "cover",
  onLoad,
  fallback = null,
}: {
  source: StoredFileSource | null | undefined;
  file: Pick<FileAsset, "id" | "contentType"> | null | undefined;
  localUri?: string | undefined;
  style?: StyleProp<ImageStyle>;
  resizeMode?: ImageProps["resizeMode"];
  onLoad?: ImageProps["onLoad"];
  fallback?: ReactNode;
}) {
  // A local photo shows even before its upload has a stored file to fall back to.
  const stored = file ?? (localUri ? { id: "", contentType: "image/*" } : null);
  const preview = useStoredFilePreview(file ? source : null, stored, { localUrl: localUri });
  if (!preview.url) return <>{fallback}</>;
  return (
    <Image
      source={{ uri: preview.url }}
      style={style}
      resizeMode={resizeMode}
      onLoad={onLoad}
      onError={preview.onError}
    />
  );
}

/** A composer attachment, or a file restored into the composer at `restoredIndex`. */
export type NativeComposerAttachment = NativeAttachment & { restoredIndex?: number | undefined };

/**
 * Files restored into the composer (a draft from a reload or another device)
 * shown as the attachments they are, after the composer's own uploads.
 * Files already among those uploads are not repeated.
 */
export function useNativeComposerAttachments(
  source: StoredFileSource | null | undefined,
  attachments: readonly NativeAttachment[],
  restoredResources: readonly ResourceRef[] | undefined,
): NativeComposerAttachment[] {
  const uploaded = new Set(attachments.flatMap((item) => (item.file ? [item.file.id] : [])));
  const restored = (restoredResources ?? []).flatMap((resource, index) =>
    resource.kind === "file" && !uploaded.has(resource.fileId)
      ? [{ fileId: resource.fileId, index }]
      : [],
  );
  const { files, ready } = useStoredFiles(
    source,
    restored.map((entry) => entry.fileId),
  );
  if (!ready) return [...attachments];
  return [
    ...attachments,
    ...restored.map(({ fileId, index }): NativeComposerAttachment => {
      const file = files.get(fileId) ?? undefined;
      return {
        id: `restored-resource:${index}:${fileId}`,
        name: file?.filename ?? fileId,
        contentType: file?.contentType ?? "application/octet-stream",
        sizeBytes: file?.sizeBytes ?? null,
        kind: file ? nativeAttachmentKind(file.contentType) : "document",
        status: "ready",
        file,
        restoredIndex: index,
      };
    }),
  ];
}
