/* ----------------------------------------------------------------------------
   Agent media in native chat, matching the web chat: retained images inline
   (tap for a zoomable full-screen view), and `opengeni-html` / `opengeni-site`
   previews in a sandboxed web view. While the assistant is still writing a
   preview, the web's "Preparing preview…" ripple plays instead of raw HTML.
   Requires `react-native-webview`; wire it into the markdown renderer with
   `createWebMarkdownRenderer({ ...createNativePreviewRenderers(...) })`.
   -------------------------------------------------------------------------- */
import {
  inlineHtmlDocument,
  loadSiteSnapshot,
  parseSiteFence,
  previewLoadingDocument,
  type SiteSnapshotReadClient,
} from "@opengeni/react/native-previews";
import {
  parseRetainedFileReference,
  type OpenGeniClient,
  type OpenGeniLinkTarget,
  type RetainedArtifactReference,
} from "@opengeni/sdk";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { Icon } from "./icon";
import { NativeImageViewer } from "./image-viewer";
import type { NativeInteractiveBlock } from "./markdown";
import { fontStyle, useNativeTimelineTheme, type NativeTimelineTheme } from "./theme";

export type NativePreviewClient = Pick<
  OpenGeniClient,
  "getRetainedArtifact" | "createRetainedArtifactDownloadUrl"
> &
  SiteSnapshotReadClient;

export interface NativePreviewOptions {
  client: NativePreviewClient;
  workspaceId: string;
  /** Open an artifact or Site in the host (its Artifacts screen, a browser…). */
  onOpenLink?: ((target: OpenGeniLinkTarget) => void) | undefined;
  labels?: Partial<NativePreviewLabels> | undefined;
}

export interface NativePreviewLabels {
  preparing: string;
  incompleteTitle: string;
  incompleteBody: string;
  previewFailed: string;
  siteLoading: string;
  siteFailed: string;
  siteUnpublished: string;
  siteInvalid: string;
  imageUnavailable: string;
  retry: string;
  open: string;
  expand: string;
  close: string;
}

const DEFAULT_LABELS: NativePreviewLabels = {
  preparing: "Preparing preview…",
  incompleteTitle: "Preview incomplete",
  incompleteBody: "Generation stopped before the preview was ready.",
  previewFailed: "The preview couldn't load.",
  siteLoading: "Loading Site…",
  siteFailed: "The Site couldn't load.",
  siteUnpublished: "This Site has no published version.",
  siteInvalid: "This Site reference is invalid.",
  imageUnavailable: "Image unavailable",
  retry: "Retry",
  open: "Open",
  expand: "Full screen",
  close: "Close",
};

/** Inline html grows with its content up to this height, then scrolls inside. */
const HTML_MAX_HEIGHT = 640;
const HTML_INITIAL_HEIGHT = 360;
const SITE_HEIGHT = 420;
const LOADING_HEIGHT = 260;

/** `renderImage` and `renderInteractiveBlock` for `createWebMarkdownRenderer`. */
export function createNativePreviewRenderers(options: NativePreviewOptions): {
  renderImage: (image: { src: string; alt: string }) => ReactNode;
  renderInteractiveBlock: (block: NativeInteractiveBlock) => ReactNode;
} {
  const labels = { ...DEFAULT_LABELS, ...options.labels };
  return {
    renderImage: ({ src, alt }) => {
      const artifactId = parseRetainedFileReference(src);
      return artifactId ? (
        <RetainedImage
          key={`${options.workspaceId}:${artifactId}`}
          options={options}
          labels={labels}
          artifactId={artifactId}
          alt={alt}
        />
      ) : null;
    },
    renderInteractiveBlock: (block) => (
      <InteractivePreview block={block} options={options} labels={labels} />
    ),
  };
}

/* Interactive previews ------------------------------------------------------- */

function InteractivePreview({
  block,
  options,
  labels,
}: {
  block: NativeInteractiveBlock;
  options: NativePreviewOptions;
  labels: NativePreviewLabels;
}) {
  if (block.state === "streaming") return <PreparingPreview label={labels.preparing} />;
  if (block.state === "incomplete") return <IncompletePreview labels={labels} />;
  if (block.kind === "html") return <HtmlPreview fragment={block.content} labels={labels} />;
  return <SitePreview content={block.content} options={options} labels={labels} />;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let current = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (current) setReduced(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      current = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/** The web's preview-preparation ripple, drawn by the same canvas code. */
function PreparingPreview({ label }: { label: string }) {
  const theme = useNativeTimelineTheme();
  const reducedMotion = useReducedMotion();
  const html = useMemo(
    () =>
      previewLoadingDocument({
        scheme: theme.scheme,
        label,
        labelColor: theme.colors["fg-muted"],
        reducedMotion,
      }),
    [label, reducedMotion, theme.colors, theme.scheme],
  );
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{
        height: LOADING_HEIGHT,
        marginVertical: 8,
        borderRadius: 10,
        overflow: "hidden",
        backgroundColor: theme.scheme === "dark" ? "#1b1b1b" : "#f9f9f9",
      }}
    >
      <WebView
        source={{ html }}
        originWhitelist={["about:*"]}
        scrollEnabled={false}
        bounces={false}
        style={{ backgroundColor: "transparent" }}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />
    </View>
  );
}

function IncompletePreview({ labels }: { labels: NativePreviewLabels }) {
  const theme = useNativeTimelineTheme();
  return (
    <View
      accessibilityRole="text"
      style={{
        flexDirection: "row",
        gap: 10,
        alignItems: "flex-start",
        marginVertical: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <View style={{ paddingTop: 2 }}>
        <Icon name="panels-top-left" size={14} color={theme.colors["fg-subtle"]} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ ...fontStyle(theme, 500), color: theme.colors.fg, fontSize: theme.size.sm }}>
          {labels.incompleteTitle}
        </Text>
        <Text
          style={{ ...fontStyle(theme), color: theme.colors["fg-muted"], fontSize: theme.size.sm }}
        >
          {labels.incompleteBody}
        </Text>
      </View>
    </View>
  );
}

/**
 * Reports the document's height to React Native and opens followed links in
 * the system browser. Runs before the page's own scripts.
 */
const HEIGHT_REPORTER = `(()=>{let last=0;const report=()=>{const body=document.body;if(!body)return;const style=getComputedStyle(body);const h=Math.ceil(body.getBoundingClientRect().height+parseFloat(style.marginTop||"0")+parseFloat(style.marginBottom||"0"));if(h&&h!==last){last=h;window.ReactNativeWebView.postMessage(JSON.stringify({type:"height",height:h}));}};
document.addEventListener("DOMContentLoaded",()=>{report();if(typeof ResizeObserver==="function")new ResizeObserver(report).observe(document.body);});window.addEventListener("load",report);setTimeout(report,400);})();true;`;

function themeScript(scheme: "light" | "dark"): string {
  return `window.postMessage({type:"opengeni.preview.theme",theme:${JSON.stringify(scheme)}},"*");true;`;
}

/** Only the document itself loads in place; anything the reader taps opens outside. */
function openExternally(request: { url: string; navigationType?: string }): boolean {
  if (request.url === "about:blank" || request.url.startsWith("about:")) return true;
  if (request.navigationType === "click" || /^(https?|mailto|tel):/i.test(request.url)) {
    void Linking.openURL(request.url).catch(() => undefined);
  }
  return false;
}

function PreviewWebView({
  html,
  height,
  scrollEnabled,
  onHeight,
  onReady,
  onFailed,
}: {
  html: string;
  height: number;
  scrollEnabled: boolean;
  onHeight?: ((height: number) => void) | undefined;
  onReady?: (() => void) | undefined;
  onFailed?: (() => void) | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const ref = useRef<WebView>(null);
  useEffect(() => {
    ref.current?.injectJavaScript(themeScript(theme.scheme));
  }, [theme.scheme]);
  return (
    <WebView
      ref={ref}
      source={{ html }}
      originWhitelist={["*"]}
      injectedJavaScriptBeforeContentLoaded={HEIGHT_REPORTER}
      onMessage={(event: WebViewMessageEvent) => {
        try {
          const data = JSON.parse(event.nativeEvent.data) as { type?: string; height?: number };
          if (data.type === "height" && typeof data.height === "number") onHeight?.(data.height);
        } catch {
          // Pages may post their own messages; only height reports matter here.
        }
      }}
      onLoadEnd={() => {
        ref.current?.injectJavaScript(themeScript(theme.scheme));
        onReady?.();
      }}
      onError={() => onFailed?.()}
      onShouldStartLoadWithRequest={openExternally}
      setSupportMultipleWindows={false}
      allowFileAccess={false}
      allowsLinkPreview={false}
      allowsInlineMediaPlayback
      scrollEnabled={scrollEnabled}
      nestedScrollEnabled
      bounces={false}
      showsHorizontalScrollIndicator={false}
      style={{ height, backgroundColor: "transparent" }}
    />
  );
}

function PreviewFrame({
  title,
  height,
  loading,
  failed,
  failedLabel,
  onRetry,
  onExpand,
  onOpen,
  labels,
  children,
}: {
  title?: string | undefined;
  height: number;
  loading: boolean;
  failed: boolean;
  failedLabel: string;
  onRetry?: (() => void) | undefined;
  onExpand?: (() => void) | undefined;
  onOpen?: (() => void) | undefined;
  labels: NativePreviewLabels;
  children: ReactNode;
}) {
  const theme = useNativeTimelineTheme();
  const reveal = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (loading) return;
    Animated.timing(reveal, { toValue: 1, duration: 260, useNativeDriver: true }).start();
  }, [loading, reveal]);
  return (
    <View
      style={{
        marginVertical: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: "hidden",
        backgroundColor: theme.colors.bg,
      }}
    >
      {title !== undefined ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            minHeight: 40,
            paddingLeft: 12,
            paddingRight: 4,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
          }}
        >
          <Icon name="panels-top-left" size={14} color={theme.colors["fg-subtle"]} />
          <Text
            numberOfLines={1}
            style={{
              ...fontStyle(theme, 500),
              flex: 1,
              color: theme.colors.fg,
              fontSize: theme.size.sm,
            }}
          >
            {title}
          </Text>
          {onOpen ? (
            <HeaderButton icon="external-link" label={labels.open} onPress={onOpen} theme={theme} />
          ) : null}
          {onExpand ? (
            <HeaderButton
              icon="maximize-2"
              label={labels.expand}
              onPress={onExpand}
              theme={theme}
            />
          ) : null}
        </View>
      ) : null}
      <View style={{ height }}>
        {failed ? (
          <FailedState label={failedLabel} onRetry={onRetry} retryLabel={labels.retry} />
        ) : (
          <>
            <Animated.View style={{ flex: 1, opacity: reveal }}>{children}</Animated.View>
            {loading ? <Skeleton /> : null}
            {title === undefined && onExpand && !loading ? (
              <View style={{ position: "absolute", top: 6, right: 6 }}>
                <HeaderButton
                  icon="maximize-2"
                  label={labels.expand}
                  onPress={onExpand}
                  theme={theme}
                  floating
                />
              </View>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

function HeaderButton({
  icon,
  label,
  onPress,
  theme,
  floating = false,
}: {
  icon: "external-link" | "maximize-2";
  label: string;
  onPress: () => void;
  theme: NativeTimelineTheme;
  floating?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: floating ? 18 : 8,
        backgroundColor: floating
          ? theme.scheme === "dark"
            ? "rgba(0,0,0,0.45)"
            : "rgba(255,255,255,0.8)"
          : pressed
            ? theme.colors.hover
            : "transparent",
        opacity: floating && pressed ? 0.7 : 1,
      })}
    >
      <Icon name={icon} size={15} color={theme.colors["fg-muted"]} />
    </Pressable>
  );
}

/** A quiet shimmer while the document lays out, so the frame never flashes blank. */
function Skeleton() {
  const theme = useNativeTimelineTheme();
  const pulse = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.9, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{ position: "absolute", inset: 0, padding: 16, gap: 10, opacity: pulse }}
    >
      {[0.62, 0.92, 0.78, 0.4].map((width, index) => (
        <View
          key={width}
          style={{
            width: `${width * 100}%`,
            height: index === 0 ? 14 : 10,
            borderRadius: 5,
            backgroundColor: theme.colors["surface-2"],
          }}
        />
      ))}
    </Animated.View>
  );
}

function FailedState({
  label,
  onRetry,
  retryLabel,
}: {
  label: string;
  onRetry?: (() => void) | undefined;
  retryLabel: string;
}) {
  const theme = useNativeTimelineTheme();
  return (
    <View
      accessibilityRole="alert"
      style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 16 }}
    >
      <Icon name="triangle-alert" size={18} color={theme.colors["fg-subtle"]} />
      <Text
        style={{
          ...fontStyle(theme),
          color: theme.colors["fg-muted"],
          fontSize: theme.size.sm,
          textAlign: "center",
        }}
      >
        {label}
      </Text>
      {onRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => ({
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 12,
            height: 32,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: pressed ? theme.colors.hover : "transparent",
          })}
        >
          <Icon name="rotate-ccw" size={13} color={theme.colors.fg} />
          <Text
            style={{ ...fontStyle(theme, 500), color: theme.colors.fg, fontSize: theme.size.sm }}
          >
            {retryLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** A full-screen view of a preview, for content that wants room. */
function FullScreenPreview({
  html,
  title,
  visible,
  onClose,
  labels,
}: {
  html: string;
  title?: string | undefined;
  visible: boolean;
  onClose: () => void;
  labels: NativePreviewLabels;
}) {
  const theme = useNativeTimelineTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            height: 48,
            paddingLeft: 16,
            paddingRight: 6,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.border,
          }}
        >
          <Text
            numberOfLines={1}
            style={{
              ...fontStyle(theme, 600),
              flex: 1,
              color: theme.colors.fg,
              fontSize: theme.size.md,
            }}
          >
            {title ?? ""}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={labels.close}
            hitSlop={8}
            onPress={onClose}
            style={{ width: 40, height: 40, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name="x" size={18} color={theme.colors.fg} />
          </Pressable>
        </View>
        {visible ? (
          <PreviewWebView html={html} height={height - insets.top - 48} scrollEnabled />
        ) : null}
      </View>
    </Modal>
  );
}

function HtmlPreview({ fragment, labels }: { fragment: string; labels: NativePreviewLabels }) {
  const html = useMemo(() => inlineHtmlDocument(fragment), [fragment]);
  const [height, setHeight] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const frameHeight = Math.min(HTML_MAX_HEIGHT, Math.max(120, height ?? HTML_INITIAL_HEIGHT));
  return (
    <>
      <PreviewFrame
        height={frameHeight}
        loading={!ready || height === null}
        failed={failed}
        failedLabel={labels.previewFailed}
        onRetry={() => {
          setFailed(false);
          setReady(false);
          setHeight(null);
          setAttempt((value) => value + 1);
        }}
        onExpand={() => setExpanded(true)}
        labels={labels}
      >
        <PreviewWebView
          key={attempt}
          html={html}
          height={frameHeight}
          scrollEnabled={(height ?? 0) > HTML_MAX_HEIGHT}
          onHeight={setHeight}
          onReady={() => setReady(true)}
          onFailed={() => setFailed(true)}
        />
      </PreviewFrame>
      <FullScreenPreview
        html={html}
        visible={expanded}
        onClose={() => setExpanded(false)}
        labels={labels}
      />
    </>
  );
}

type SiteState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "unpublished"; title: string }
  | { status: "ready"; title: string; html: string };

function SitePreview({
  content,
  options,
  labels,
}: {
  content: string;
  options: NativePreviewOptions;
  labels: NativePreviewLabels;
}) {
  const theme = useNativeTimelineTheme();
  const reference = useMemo(() => parseSiteFence(content), [content]);
  const [state, setState] = useState<SiteState>({ status: "loading" });
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const { client, workspaceId, onOpenLink } = options;
  useEffect(() => {
    if (!reference) return;
    const abort = new AbortController();
    setState({ status: "loading" });
    setReady(false);
    void loadSiteSnapshot(client, workspaceId, reference.siteId, {
      signal: abort.signal,
      ...(reference.versionId ? { versionId: reference.versionId } : {}),
    })
      .then((snapshot) => {
        if (abort.signal.aborted) return;
        const title = snapshot.detail.artifact.title;
        setState(
          snapshot.content
            ? { status: "ready", title, html: snapshot.content.html }
            : { status: "unpublished", title },
        );
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ status: "failed" });
      });
    return () => abort.abort();
  }, [attempt, client, reference, workspaceId]);
  if (!reference) {
    return (
      <Text
        style={{ ...fontStyle(theme), color: theme.colors["fg-muted"], fontSize: theme.size.sm }}
      >
        {labels.siteInvalid}
      </Text>
    );
  }
  const open = onOpenLink
    ? () => onOpenLink({ kind: "site", artifactId: reference.siteId, workspaceId })
    : undefined;
  const title =
    state.status === "ready" || state.status === "unpublished" ? state.title : labels.siteLoading;
  return (
    <>
      <PreviewFrame
        title={title}
        height={state.status === "unpublished" ? 120 : SITE_HEIGHT}
        loading={state.status === "loading" || (state.status === "ready" && !ready)}
        failed={state.status === "failed" || state.status === "unpublished"}
        failedLabel={state.status === "unpublished" ? labels.siteUnpublished : labels.siteFailed}
        onRetry={state.status === "failed" ? () => setAttempt((value) => value + 1) : undefined}
        onOpen={open}
        onExpand={state.status === "ready" ? () => setExpanded(true) : undefined}
        labels={labels}
      >
        {state.status === "ready" ? (
          <PreviewWebView
            html={state.html}
            height={SITE_HEIGHT}
            scrollEnabled
            onReady={() => setReady(true)}
            onFailed={() => setState({ status: "failed" })}
          />
        ) : null}
      </PreviewFrame>
      {state.status === "ready" ? (
        <FullScreenPreview
          html={state.html}
          title={state.title}
          visible={expanded}
          onClose={() => setExpanded(false)}
          labels={labels}
        />
      ) : null}
    </>
  );
}

/* Retained images ------------------------------------------------------------ */

type ImageState =
  | { status: "loading"; ratio: number | null }
  | { status: "image"; url: string; ratio: number | null }
  | { status: "file"; artifact: RetainedArtifactReference }
  | { status: "failed" };

function RetainedImage({
  options,
  labels,
  artifactId,
  alt,
}: {
  options: NativePreviewOptions;
  labels: NativePreviewLabels;
  artifactId: string;
  alt: string;
}) {
  const theme = useNativeTimelineTheme();
  const { client, workspaceId, onOpenLink } = options;
  const [state, setState] = useState<ImageState>({ status: "loading", ratio: null });
  const [attempt, setAttempt] = useState(0);
  const [viewer, setViewer] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const reveal = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const abort = new AbortController();
    setState({ status: "loading", ratio: null });
    setLoaded(false);
    reveal.setValue(0);
    void (async () => {
      try {
        const metadata = await client.getRetainedArtifact(workspaceId, artifactId);
        if (abort.signal.aborted) return;
        if (!metadata.available || metadata.artifactId !== artifactId) {
          setState({ status: "failed" });
          return;
        }
        const ratio = metadata.dimensions
          ? metadata.dimensions.width / Math.max(1, metadata.dimensions.height)
          : null;
        if (!metadata.contentType.startsWith("image/")) {
          setState({ status: "file", artifact: metadata });
          return;
        }
        setState({ status: "loading", ratio });
        const download = await client.createRetainedArtifactDownloadUrl(workspaceId, metadata, {
          signal: abort.signal,
        });
        if (!abort.signal.aborted) setState({ status: "image", url: download.url, ratio });
      } catch {
        if (!abort.signal.aborted) setState({ status: "failed" });
      }
    })();
    return () => abort.abort();
  }, [artifactId, attempt, client, reveal, workspaceId]);

  const label = alt || "Image";
  if (state.status === "failed") {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${labels.imageUnavailable}. ${labels.retry}`}
        onPress={() => setAttempt((value) => value + 1)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginVertical: 8,
          paddingHorizontal: 12,
          height: 44,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
        }}
      >
        <Icon name="image" size={15} color={theme.colors["fg-subtle"]} />
        <Text
          numberOfLines={1}
          style={{
            ...fontStyle(theme),
            flex: 1,
            color: theme.colors["fg-muted"],
            fontSize: theme.size.sm,
          }}
        >
          {labels.imageUnavailable}
        </Text>
        <Icon name="rotate-ccw" size={14} color={theme.colors["fg-muted"]} />
      </Pressable>
    );
  }
  if (state.status === "file") {
    const artifact = state.artifact;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${labels.open} ${label}`}
        disabled={!onOpenLink}
        onPress={() => onOpenLink?.({ kind: "file", fileId: artifact.artifactId, workspaceId })}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginVertical: 8,
          paddingHorizontal: 12,
          height: 44,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: pressed ? theme.colors.hover : "transparent",
        })}
      >
        <Icon name="file-text" size={15} color={theme.colors["fg-subtle"]} />
        <Text
          numberOfLines={1}
          style={{
            ...fontStyle(theme, 500),
            flex: 1,
            color: theme.colors.fg,
            fontSize: theme.size.sm,
          }}
        >
          {label}
        </Text>
        {onOpenLink ? (
          <Icon name="external-link" size={14} color={theme.colors["fg-muted"]} />
        ) : null}
      </Pressable>
    );
  }
  const ratio = state.ratio ?? 4 / 3;
  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={label}
        disabled={state.status !== "image" || !loaded}
        onPress={() => setViewer(true)}
        style={{
          width: "100%",
          aspectRatio: ratio,
          maxHeight: 460,
          marginVertical: 8,
          borderRadius: 12,
          overflow: "hidden",
          backgroundColor: theme.colors["surface-2"],
        }}
      >
        {!loaded ? <Skeleton /> : null}
        {state.status === "image" ? (
          <Animated.View style={{ flex: 1, opacity: reveal }}>
            <Image
              source={{ uri: state.url }}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
              onLoad={(event) => {
                const { width, height } = event.nativeEvent.source;
                if (!state.ratio && width > 0 && height > 0)
                  setState({ ...state, ratio: width / height });
                setLoaded(true);
                Animated.timing(reveal, {
                  toValue: 1,
                  duration: 220,
                  useNativeDriver: true,
                }).start();
              }}
              onError={() => setState({ status: "failed" })}
              style={{ width: "100%", height: "100%" }}
            />
          </Animated.View>
        ) : null}
      </Pressable>
      {state.status === "image" ? (
        <NativeImageViewer
          images={[{ url: state.url, alt: label }]}
          index={0}
          visible={viewer}
          onClose={() => setViewer(false)}
          labels={{ close: labels.close }}
        />
      ) : null}
    </>
  );
}
