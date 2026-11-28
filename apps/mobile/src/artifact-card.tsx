import type { OpenGeniText } from "@opengeni/react/messages";
import { fontStyle, Icon, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import type {
  ArtifactCatalogItem,
  ChatClient,
  OpenGeniClient,
  RetainedArtifactReference,
} from "@opengeni/sdk";
import {
  SITE_PREVIEW_TIMEOUT_MS,
  SITE_PREVIEW_WIDTH,
  sitePreviewDocument,
  sitePreviewPainted,
} from "@opengeni/sdk/site-preview";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, Platform, Pressable, Text, View } from "react-native";
import { parse, SvgXml } from "react-native-svg";
import { captureRef } from "react-native-view-shot";
import { WebView } from "react-native-webview";
import {
  ARTIFACT_KIND_ICON,
  ARTIFACT_KIND_LABEL,
  editedLabel,
  isEditableKind,
  sitePreviewFileName,
  sitePreviewFilePrefix,
} from "@/artifacts";
import {
  blankSitePreviews,
  keepSitePreview,
  onForgetArtifactPreviews,
  sitePreviewGeneration,
  storedSitePreview,
} from "@/site-preview-store";

export type ArtifactThumbnailClient = Pick<
  ChatClient<OpenGeniClient>,
  "getWorkspaceArtifactHtml" | "createRetainedArtifactDownloadUrl" | "getEditableArtifactPreview"
>;

/* A Site's page, an image's address and a document's picture, shared across cards and remounts. */
const siteHtml = new Map<string, Promise<string>>();
const imageUrls = new Map<string, Promise<string>>();
const editablePictures = new Map<string, Promise<string>>();
const CACHE_LIMIT = 48;
// Nothing of a signed-out account stays in memory either.
onForgetArtifactPreviews(() => {
  siteHtml.clear();
  imageUrls.clear();
  editablePictures.clear();
  failedPictures.clear();
});
/* Pictures that couldn't be drawn keep their card's glyph. */
const failedPictures = new Set<string>();

/* The API draws pictures a few at a time. */
const PICTURE_REQUEST_SLOTS = 4;
let pictureRequestsRunning = 0;
const pictureRequestQueue: Array<() => void> = [];

function limitPictureRequest<T>(request: () => Promise<T>): Promise<T> {
  return new Promise<void>((resolve) => {
    if (pictureRequestsRunning < PICTURE_REQUEST_SLOTS) {
      pictureRequestsRunning += 1;
      resolve();
    } else pictureRequestQueue.push(resolve);
  })
    .then(request)
    .finally(() => {
      const next = pictureRequestQueue.shift();
      if (next) next();
      else pictureRequestsRunning -= 1;
    });
}

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

/* Two Sites render at a time, so a screen of cards never runs every page at once. */
const SITE_PREVIEW_SLOTS = 2;
let sitePreviewsRendering = 0;
const sitePreviewQueue: Array<() => void> = [];

function releaseSitePreviewSlot() {
  const next = sitePreviewQueue.shift();
  if (next) next();
  else sitePreviewsRendering = Math.max(0, sitePreviewsRendering - 1);
}

function useSitePreviewSlot(): { granted: boolean; release: () => void } {
  const [granted, setGranted] = useState(false);
  const heldRef = useRef(false);
  const release = useCallback(() => {
    if (!heldRef.current) return;
    heldRef.current = false;
    releaseSitePreviewSlot();
  }, []);
  useEffect(() => {
    let active = true;
    const grant = () => {
      if (!active) return releaseSitePreviewSlot();
      heldRef.current = true;
      setGranted(true);
    };
    if (sitePreviewsRendering < SITE_PREVIEW_SLOTS) {
      sitePreviewsRendering += 1;
      grant();
    } else sitePreviewQueue.push(grant);
    return () => {
      active = false;
      const queued = sitePreviewQueue.indexOf(grant);
      if (queued >= 0) sitePreviewQueue.splice(queued, 1);
      release();
    };
  }, [release]);
  return { granted, release };
}

/**
 * A Site's page drawn at a desktop width and scaled into the tile, in an
 * isolated web view (`@opengeni/sdk/site-preview`: no bridge, no calls, no
 * shared cookies on iOS). Once the page reports it painted, the tile is
 * captured and `onCaptured` gets the picture; a page that stays blank calls
 * `onBlank`. If capturing fails the live page stays (`onLive`).
 */
function SiteRender({
  html,
  name,
  replaces,
  scheme,
  onCaptured,
  onBlank,
  onLive,
}: {
  html: string;
  name: string;
  /** The start of this Site's earlier previews, replaced by this one. */
  replaces: string;
  scheme: "light" | "dark";
  onCaptured: (uri: string) => void;
  onBlank: () => void;
  onLive: () => void;
}) {
  const shotRef = useRef<View>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const { granted: slotGranted, release: releaseSlot } = useSitePreviewSlot();
  const settledRef = useRef(false);
  const generation = useMemo(() => sitePreviewGeneration(), []);
  const document = useMemo(() => sitePreviewDocument(html, { theme: scheme }), [html, scheme]);
  const settle = useCallback(
    (painted: boolean, reported = true) => {
      if (settledRef.current) return;
      settledRef.current = true;
      if (!painted) {
        // A page that said it drew nothing isn't tried again this run; one
        // that never said (slow network) is, next time its card shows.
        if (reported) blankSitePreviews.add(name);
        releaseSlot();
        onBlank();
        return;
      }
      // One frame for the web view to present what it reported.
      setTimeout(() => {
        captureRef(shotRef, { format: "jpg", quality: 0.85, result: "tmpfile" }).then(
          (uri) => {
            releaseSlot();
            const kept = keepSitePreview(name, uri, { generation, replaces });
            if (kept) onCaptured(kept);
          },
          () => {
            releaseSlot();
            onLive();
          },
        );
      }, 120);
    },
    [generation, name, onBlank, onCaptured, onLive, releaseSlot, replaces],
  );
  // The page's time runs from when its web view is laid out and mounted.
  const mounted = slotGranted && box !== null;
  useEffect(() => {
    if (!mounted) return;
    const timer = setTimeout(() => settle(false, false), SITE_PREVIEW_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [settle, mounted]);
  const scale = box ? box.width / SITE_PREVIEW_WIDTH : 0;
  return (
    <View
      ref={shotRef}
      collapsable={false}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setBox({ width, height });
      }}
      style={{ flex: 1, overflow: "hidden", backgroundColor: "#ffffff" }}
    >
      {box && slotGranted ? (
        <WebView
          source={{ html: document }}
          originWhitelist={["about:*"]}
          javaScriptEnabled
          // A separate cookie and storage jar on iOS. On Android the page has
          // no origin of its own, so with third-party cookies off none of its
          // requests carry the app's cookies.
          incognito={Platform.OS === "ios"}
          thirdPartyCookiesEnabled={false}
          sharedCookiesEnabled={false}
          scalesPageToFit={false}
          scrollEnabled={false}
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          allowsLinkPreview={false}
          mediaPlaybackRequiresUserAction
          pointerEvents="none"
          onMessage={(event) => {
            const painted = sitePreviewPainted(event.nativeEvent.data);
            if (painted !== null) settle(painted);
          }}
          onError={() => settle(false, false)}
          onContentProcessDidTerminate={() => settle(false, false)}
          onRenderProcessGone={() => settle(false, false)}
          onShouldStartLoadWithRequest={(request) => request.url.startsWith("about:")}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: SITE_PREVIEW_WIDTH,
            height: Math.ceil(box.height / scale),
            transformOrigin: "top left",
            transform: [{ scale }],
            backgroundColor: "#ffffff",
          }}
        />
      ) : null}
    </View>
  );
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
 * An artifact's still, as the web library draws it: a Site's page as it looks
 * when opened, an image's own pixels, the first page, slide or sheet of a
 * document, presentation or spreadsheet, and the type glyph for the rest (and
 * whenever a still can't be had).
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
  const previewName =
    item.kind === "site" && item.versionId
      ? sitePreviewFileName(workspaceId, item.id, item.versionId, theme.scheme)
      : null;
  const stored = useMemo(
    () => (previewName ? storedSitePreview(previewName) : null),
    [previewName],
  );
  const [site, setSite] = useState<{ name: string; uri: string | null; live?: boolean } | null>(
    null,
  );
  const siteState = site && site.name === previewName ? site : null;
  const capturedUri = stored ?? siteState?.uri ?? null;
  const blank = previewName !== null && blankSitePreviews.has(previewName);
  const siteKey =
    // A capture that failed keeps its live page, so its page stays loaded.
    previewName && !capturedUri && !blank && (!siteState || siteState.live)
      ? `${workspaceId}:${item.id}:${item.versionId}`
      : null;
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
  const pictureKey = isEditableKind(item.kind)
    ? `${workspaceId}:${item.id}:${item.updatedAt}`
    : null;
  const picture = useLoaded(pictureKey, () =>
    cached(editablePictures, pictureKey!, () =>
      limitPictureRequest(() => client.getEditableArtifactPreview(workspaceId, item.id)),
    ),
  );
  const [pictureFailed, setPictureFailed] = useState<string | null>(null);
  const onPictureFailed = useCallback(() => {
    if (!pictureKey) return;
    failedPictures.add(pictureKey);
    setPictureFailed(pictureKey);
  }, [pictureKey]);
  const pictureShown = useCallback(() => setPainted(true), []);
  const [painted, setPainted] = useState(false);
  const onCaptured = useCallback(
    (uri: string) => previewName && setSite({ name: previewName, uri }),
    [previewName],
  );
  const onBlank = useCallback(
    () => previewName && setSite({ name: previewName, uri: null }),
    [previewName],
  );
  const onLive = useCallback(() => {
    if (previewName) setSite({ name: previewName, uri: null, live: true });
    setPainted(true);
  }, [previewName]);
  let still: ReactNode = null;
  if (capturedUri) {
    still = (
      <Image
        source={{ uri: capturedUri }}
        resizeMode="cover"
        onLoad={() => setPainted(true)}
        style={{ flex: 1, opacity: painted ? 1 : 0 }}
      />
    );
  } else if (html && previewName && (!siteState || siteState.live)) {
    still = (
      <SiteRender
        html={html}
        name={previewName}
        replaces={sitePreviewFilePrefix(workspaceId, item.id)}
        scheme={theme.scheme}
        onCaptured={onCaptured}
        onBlank={onBlank}
        onLive={onLive}
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
  } else if (
    picture &&
    pictureKey &&
    pictureFailed !== pictureKey &&
    !failedPictures.has(pictureKey)
  ) {
    still = <EditablePicture svg={picture} onShown={pictureShown} onFailed={onPictureFailed} />;
  }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flex: 1, overflow: "hidden", backgroundColor: theme.colors["surface-2"] }}
    >
      {still}
      {!painted ? (
        <View style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}>
          <KindTile item={item} size={glyphSize} />
        </View>
      ) : null}
    </View>
  );
});

/**
 * A document's, presentation's or spreadsheet's first page as the server drew
 * it. A picture that doesn't parse leaves the glyph in place.
 */
function EditablePicture({
  svg,
  onShown,
  onFailed,
}: {
  svg: string;
  onShown: () => void;
  onFailed: () => void;
}) {
  const drawable = useMemo(() => {
    try {
      return parse(svg) !== null;
    } catch {
      return false;
    }
  }, [svg]);
  useEffect(() => (drawable ? onShown() : onFailed()), [drawable, onFailed, onShown]);
  if (!drawable) return null;
  return (
    <View style={{ flex: 1, backgroundColor: "#ffffff" }}>
      <SvgXml xml={svg} width="100%" height="100%" />
    </View>
  );
}

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
