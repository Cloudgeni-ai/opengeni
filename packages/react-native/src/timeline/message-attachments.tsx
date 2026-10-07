import type { FileAsset, OpenGeniClient, ResourceRef } from "@opengeni/sdk";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, Text, View } from "react-native";
import { Icon } from "./icon";
import { fontStyle, useNativeTimelineTheme } from "./theme";

type AttachmentClient = Pick<OpenGeniClient, "getFile" | "createFileDownloadUrl">;
type FileResource = Extract<ResourceRef, { kind: "file" }>;

const PREVIEW_WIDTH = 200;

/**
 * Files sent with a user message, above its bubble as on web: images as
 * signed previews (tap opens the full image), other files as named chips.
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
  if (files.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6 }}>
      {files.map((resource) => (
        <Attachment
          key={resource.fileId}
          client={props.client}
          workspaceId={props.workspaceId}
          sessionId={props.sessionId}
          resource={resource}
        />
      ))}
    </View>
  );
}

function Attachment(props: {
  client: AttachmentClient;
  workspaceId: string;
  sessionId?: string | undefined;
  resource: FileResource;
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

  if (image) {
    return (
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open ${name}`}
        onPress={() => void open()}
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
