import type { OpenGeniText } from "@opengeni/react/messages";
import { fontStyle, Icon, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import type {
  ArtifactCatalogItem,
  ChatClient,
  OpenGeniClient,
  RetainedArtifactReference,
} from "@opengeni/sdk";
import { memo, useEffect, useState, type ReactNode } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import {
  ARTIFACT_KIND_ICON,
  ARTIFACT_KIND_LABEL,
  editedLabel,
  siteStillDocument,
} from "@/artifacts";

export type ArtifactThumbnailClient = Pick<
  ChatClient<OpenGeniClient>,
  "getWorkspaceArtifactHtml" | "createRetainedArtifactDownloadUrl"
>;

/* A Site's page and an image's address, shared across cards and remounts. */
const siteHtml = new Map<string, Promise<string>>();
const imageUrls = new Map<string, Promise<string>>();
const CACHE_LIMIT = 48;

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) {
  let request = cache.get(key);
  if (!request) {
    request = load();
    cache.set(key, request);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    request.catch(() => cache.delete(key));
  }
  return request;
}

function useLoaded<T>(key: string | null, load: () => Promise<T>): T | null {
  const [state, setState] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    if (!key) return;
    let active = true;
    load().then(
      (value) => active && setState({ key, value }),
      () => undefined,
    );
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the key names what is loaded
  }, [key]);
  return state && state.key === key ? state.value : null;
}

/** The type glyph on a quiet tile: what a card shows before (or without) a still. */
function KindTile({ item, size }: { item: ArtifactCatalogItem; size: number }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const extension =
    item.kind === "file"
      ? (item.filename ?? item.title).match(/\.([A-Za-z0-9]{1,5})$/u)?.[1]?.toUpperCase()
      : undefined;
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        backgroundColor: c["surface-2"],
      }}
    >
      <Icon name={ARTIFACT_KIND_ICON[item.kind]} size={size} color={c["fg-subtle"]} />
      {extension ? (
        <Text style={{ ...fontStyle(theme, 600), fontSize: 10, color: c["fg-subtle"] }}>
          {extension}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * An artifact's still, as the web library draws it: a Site's page with no
 * scripts running, an image's own pixels, and the type glyph for the rest.
 */
export const ArtifactThumbnail = memo(function ArtifactThumbnail({
  client,
  workspaceId,
  item,
  glyphSize = 26,
}: {
  client: ArtifactThumbnailClient;
  workspaceId: string;
  item: ArtifactCatalogItem;
  glyphSize?: number;
}) {
  const theme = useNativeTimelineTheme();
  const siteKey =
    item.kind === "site" && item.versionId ? `${workspaceId}:${item.id}:${item.versionId}` : null;
  const html = useLoaded(siteKey, () =>
    cached(siteHtml, siteKey!, () =>
      client.getWorkspaceArtifactHtml(workspaceId, item.id, { versionId: item.versionId! }),
    ),
  );
  const file: RetainedArtifactReference | undefined = item.file;
  const imageKey = item.kind === "image" && file ? `${workspaceId}:${file.artifactId}` : null;
  const imageUrl = useLoaded(imageKey, () =>
    cached(imageUrls, imageKey!, () =>
      client.createRetainedArtifactDownloadUrl(workspaceId, file!).then((link) => link.url),
    ),
  );
  const [painted, setPainted] = useState(false);
  let still: ReactNode = null;
  if (html) {
    still = (
      <WebView
        source={{ html: siteStillDocument(html) }}
        originWhitelist={["about:*"]}
        javaScriptEnabled={false}
        scrollEnabled={false}
        pointerEvents="none"
        scalesPageToFit
        onLoadEnd={() => setPainted(true)}
        onShouldStartLoadWithRequest={(request) => request.url.startsWith("about:")}
        style={{ flex: 1, backgroundColor: "#ffffff", opacity: painted ? 1 : 0 }}
      />
    );
  } else if (imageUrl) {
    still = (
      <Image
        source={{ uri: imageUrl }}
        resizeMode="cover"
        onLoad={() => setPainted(true)}
        style={{ flex: 1, opacity: painted ? 1 : 0 }}
      />
    );
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flex: 1, overflow: "hidden", backgroundColor: theme.colors["surface-2"] }}
    >
      {!painted ? (
        <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}>
          <KindTile item={item} size={glyphSize} />
        </View>
      ) : null}
      {still}
    </View>
  );
});

/**
 * One artifact in the list: a large rounded card, its still on the left and
 * its title, type and last edit on the right.
 */
export const ArtifactCard = memo(function ArtifactCard({
  t,
  client,
  workspaceId,
  item,
  now,
  onOpen,
}: {
  t: OpenGeniText;
  client: ArtifactThumbnailClient;
  workspaceId: string;
  item: ArtifactCatalogItem;
  now: Date;
  onOpen: (item: ArtifactCatalogItem) => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const edited = editedLabel(t, item.updatedAt, now);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${ARTIFACT_KIND_LABEL[item.kind]}${edited ? `, ${edited}` : ""}`}
      onPress={() => onOpen(item)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        padding: 8,
        borderRadius: 24,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: pressed ? c.hover : c["surface-1"],
        transform: [{ scale: pressed ? 0.985 : 1 }],
      })}
    >
      <View style={{ width: 132, height: 92, borderRadius: 16, overflow: "hidden" }}>
        <ArtifactThumbnail client={client} workspaceId={workspaceId} item={item} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4, paddingRight: 8 }}>
        <Text
          numberOfLines={2}
          style={{
            ...fontStyle(theme, 600),
            fontSize: 16,
            lineHeight: 21,
            letterSpacing: -0.2,
            color: c.fg,
          }}
        >
          {item.title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Icon name={ARTIFACT_KIND_ICON[item.kind]} size={13} color={c["fg-subtle"]} />
          <Text
            numberOfLines={1}
            style={{ ...fontStyle(theme), flexShrink: 1, fontSize: 13, color: c["fg-muted"] }}
          >
            {edited || ARTIFACT_KIND_LABEL[item.kind]}
          </Text>
          {item.pinned ? <Icon name="pin" size={12} color={c["fg-subtle"]} /> : null}
          {item.visibility === "private" ? (
            <Icon name="lock" size={12} color={c["fg-subtle"]} />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});
