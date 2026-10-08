import type { FileAsset, OpenGeniClient, ResourceRef } from "@opengeni/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, Text, View } from "react-native";
import { Icon } from "./icon";
import { NativeImageViewer, type NativeViewerImage } from "./image-viewer";
import { fontStyle, useNativeTimelineTheme } from "./theme";

type AttachmentClient = Pick<OpenGeniClient, "getFile" | "createFileDownloadUrl">;
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
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [asset, setAsset] = useState<FileAsset | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [ratio, setRatio] = useState(1);
  const [failed, setFailed] = useState(false);
  const { client, workspaceId, sessionId } = props;
  const fileId = props.resource.fileId;

  useEffect(() => {
    let current = true;
    setAsset(null);
    setUrl(null);
    setFailed(false);
    const options = sessionId ? { sessionId } : {};
    void (async () => {
      try {
        const file = await client.getFile(workspaceId, fileId, options);
        if (!current) return;
        setAsset(file);
        if (!file.contentType.startsWith("image/")) return;
        const signed = await client.createFileDownloadUrl(workspaceId, fileId, options);
        if (current) setUrl(signed.url);
      } catch {
        if (current) setFailed(true);
      }
    })();
    return () => {
      current = false;
    };
  }, [client, fileId, sessionId, workspaceId]);

  const open = async () => {
    try {
      const target =
        url ??
        (await client.createFileDownloadUrl(workspaceId, fileId, sessionId ? { sessionId } : {}))
          .url;
      await Linking.openURL(target);
    } catch {
      // Opening is best effort; the chip stays.
    }
  };
  const name = asset?.filename ?? "Attachment";
  const image = asset?.contentType.startsWith("image/") === true && !failed;
  const { onImageReady } = props;
  useEffect(() => {
    if (image && url) onImageReady(fileId, { url, alt: name, filename: asset?.filename });
  }, [asset?.filename, fileId, image, name, onImageReady, url]);

  if (image) {
    return (
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open ${name}`}
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
            onError={() => setFailed(true)}
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
      accessibilityLabel={`Open ${name}`}
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
