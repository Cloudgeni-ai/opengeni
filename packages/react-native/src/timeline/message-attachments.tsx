import type { OpenGeniClient, ResourceRef } from "@opengeni/sdk";
import type { ChatClient } from "@opengeni/sdk";
import {
  readStoredFilePreviewUrl,
  useStoredFilePreview,
  useStoredFiles,
} from "@opengeni/react/session";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, Text, View } from "react-native";
import { Icon } from "./icon";
import { NativeImageViewer, type NativeViewerImage } from "./image-viewer";
import { fontStyle, useNativeTimelineTheme } from "./theme";
import { useOpenGeniText } from "@opengeni/react/messages";

type AttachmentClient = Pick<ChatClient<OpenGeniClient>, "getFile" | "createFileDownloadUrl">;
type FileResource = Extract<ResourceRef, { kind: "file" }>;

const PREVIEW_WIDTH = 200;

/**
 * Files sent with a user message, above its bubble as on web: images as
 * signed previews (tap opens them full screen in the app, swiping between the
 * message's images), other files as named chips.
 */
export function NativeMessageAttachments(props: {
  client: AttachmentClient;
  workspaceId: string;
  sessionId?: string | undefined;
  resources: readonly ResourceRef[];
}) {
  const files = props.resources.filter(
    (resource): resource is FileResource => resource.kind === "file",
  );
  const [ready, setReady] = useState<Record<string, NativeViewerImage>>({});
  const [viewing, setViewing] = useState<string | null>(null);
  const onImageReady = useCallback((fileId: string, image: NativeViewerImage) => {
    setReady((current) =>
      current[fileId]?.url === image.url ? current : { ...current, [fileId]: image },
    );
  }, []);
  const order = files.map((file) => file.fileId).join(",");
  const gallery = useMemo(
    () =>
      order
        .split(",")
        .flatMap((fileId) => (ready[fileId] ? [{ fileId, image: ready[fileId]! }] : [])),
    [order, ready],
  );
  if (files.length === 0) return null;
  const index = Math.max(
    0,
    gallery.findIndex((entry) => entry.fileId === viewing),
  );
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 }}>
      {files.map((resource) => (
        <Attachment
          key={resource.fileId}
          client={props.client}
          workspaceId={props.workspaceId}
          sessionId={props.sessionId}
          resource={resource}
          onImageReady={onImageReady}
          onOpenImage={setViewing}
        />
      ))}
      {gallery.length > 0 ? (
        <NativeImageViewer
          images={gallery.map((entry) => entry.image)}
          index={index}
          visible={viewing !== null}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </View>
  );
}

function Attachment(props: {
  client: AttachmentClient;
  workspaceId: string;
  sessionId?: string | undefined;
  resource: FileResource;
  onImageReady: (fileId: string, image: NativeViewerImage) => void;
  onOpenImage: (fileId: string) => void;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [ratio, setRatio] = useState(1);
  const { client, workspaceId, sessionId } = props;
  const fileId = props.resource.fileId;
  const source = useMemo(
    () => ({ client, workspaceId, sessionId }),
    [client, sessionId, workspaceId],
  );
  const fileIds = useMemo(() => [fileId], [fileId]);
  const stored = useStoredFiles(source, fileIds);
  const asset = stored.ready ? (stored.files.get(fileId) ?? null) : null;
  // The stored copy, re-signed once if it stops loading before falling back to a chip.
  const preview = useStoredFilePreview(source, asset);
  const url = preview.url ?? null;
  const failed = (stored.ready && !asset) || preview.failed;

  const open = async () => {
    try {
      await Linking.openURL(url ?? (await readStoredFilePreviewUrl(source, fileId)));
    } catch {
      // Opening is best effort; the chip stays.
    }
  };
  const name = asset?.filename ?? t("native.timeline.messageAttachments.attachment");
  const image = asset?.contentType.startsWith("image/") === true && !failed;
  const { onImageReady } = props;
  useEffect(() => {
    if (image && url) onImageReady(fileId, { url, alt: name, filename: asset?.filename });
  }, [asset?.filename, fileId, image, name, onImageReady, url]);

  if (image) {
    return (
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={t("native.timeline.messageAttachments.openName", { name })}
        disabled={!url}
        onPress={() => props.onOpenImage(fileId)}
        style={{
          width: PREVIEW_WIDTH,
          height: Math.min(260, Math.max(90, PREVIEW_WIDTH / ratio)),
          borderRadius: 12,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c["surface-2"],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {url ? (
          <Image
            source={{ uri: url }}
            resizeMode="cover"
            onLoad={(event) => {
              const { width, height } = event.nativeEvent.source;
              if (width > 0 && height > 0) setRatio(width / height);
            }}
            onError={preview.onError}
            style={{ width: "100%", height: "100%" }}
          />
        ) : (
          <ActivityIndicator size="small" color={c["fg-muted"]} />
        )}
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("native.timeline.messageAttachments.openName", { name })}
      onPress={() => void open()}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        maxWidth: 240,
        height: 34,
        paddingHorizontal: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: pressed ? c.hover : c["surface-1"],
      })}
    >
      <Icon name="file-text" size={14} color={c["fg-muted"]} />
      <Text
        numberOfLines={1}
        style={{ ...fontStyle(theme, 500), fontSize: 13, color: c.fg, flexShrink: 1 }}
      >
        {name}
      </Text>
    </Pressable>
  );
}
