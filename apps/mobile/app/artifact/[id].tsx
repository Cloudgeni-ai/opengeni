import {
  Button,
  fontStyle,
  IconButton,
  useNativeTimelineTheme,
} from "@opengeni/react-native/timeline";
import type { ArtifactCatalogItem, ArtifactCatalogKind } from "@opengeni/sdk";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  ScrollView,
  Share,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { useAccount } from "@/account";
import { appSessionPath } from "@/app-links";
import { downloadArtifact } from "@/artifact-download";
import { artifactChanged, cachedArtifact, loadArtifactItem } from "@/artifact-library";
import {
  artifactMenu,
  artifactWebUrl,
  deleteConfirmation,
  fileOpensInline,
  nativeViewPath,
  viewerKeepsNavigation,
  viewerMode,
  viewerPath,
  type ArtifactMenuAction,
  type ArtifactMenuItem,
} from "@/artifacts";
import { signInWebViews } from "@/artifact-web-session";
import { copyText } from "@/clipboard";
import { NativeMenu, type MenuAction } from "@/native-menu";
import { AppThemeProvider } from "@/theme";
import { openOnWeb, webUrl } from "@/web-links";

const KINDS: readonly ArtifactCatalogKind[] = [
  "site",
  "document",
  "presentation",
  "spreadsheet",
  "image",
  "file",
];

export default function ArtifactViewerScreen() {
  return (
    <AppThemeProvider>
      <ArtifactViewer />
    </AppThemeProvider>
  );
}

const themed = (node: React.ReactNode) => <AppThemeProvider>{node}</AppThemeProvider>;

/* One artifact, full screen: a Site or editor in the web app's own page, an
   image zoomable, a file as the system draws it. Share in the header, and the
   web library's ⋯ menu beside it. */
function ArtifactViewer() {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const { client, account, accessContext, workspaceId: currentWorkspaceId } = useAccount();
  const params = useLocalSearchParams<{
    id: string;
    kind?: string;
    workspaceId?: string;
    title?: string;
    from?: string;
  }>();
  const workspaceId = params.workspaceId || currentWorkspaceId || "";
  const kind = KINDS.find((each) => each === params.kind) ?? "file";
  const [item, setItem] = useState<ArtifactCatalogItem | null>(() =>
    workspaceId ? cachedArtifact(client, workspaceId, kind, params.id) : null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    setProblem(null);
    void loadArtifactItem(client, workspaceId, item?.kind ?? kind, params.id, params.title)
      .then((next) => active && setItem(next))
      .catch((caught: unknown) => {
        if (!active) return;
        // A row already shown stays; only a first open says it couldn't.
        setProblem(caught instanceof Error ? caught.message : "This artifact couldn't open.");
      });
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the address names what is loaded
  }, [attempt, client, params.id, workspaceId]);

  const url = item && account ? artifactWebUrl(account.baseUrl, workspaceId, item) : null;
  const menu = item
    ? artifactMenu(item, {
        accessContext,
        workspaceId,
        fromSessionId: params.from ?? null,
        pinKnown: item.pinned !== undefined,
      })
    : [];

  const share = useCallback(() => {
    if (!url) return;
    void Share.share(Platform.OS === "ios" ? { url } : { message: url });
  }, [url]);

  const run = useCallback(
    async (action: ArtifactMenuAction) => {
      if (!item) return;
      switch (action) {
        case "open-chat":
          if (item.sourceSessionId)
            router.push(appSessionPath(item.sourceSessionId, workspaceId, null));
          return;
        case "pin":
        case "unpin": {
          const pinned = action === "pin";
          await client.updateArtifactPin(workspaceId, item.kind, item.id, pinned);
          const next = { ...item, pinned };
          setItem(next);
          artifactChanged(client, workspaceId, item, next);
          void Haptics.selectionAsync();
          return;
        }
        case "duplicate": {
          const copy = await client.duplicateWorkspaceArtifact(workspaceId, item.id, {
            idempotencyKey: Crypto.randomUUID(),
          });
          Alert.alert("Duplicated", copy.artifact.title, [
            { text: "Done", style: "cancel" },
            {
              text: "Open",
              onPress: () =>
                router.push(
                  viewerPath({
                    id: copy.artifact.id,
                    kind: "site",
                    workspaceId,
                    title: copy.artifact.title,
                  }),
                ),
            },
          ]);
          return;
        }
        case "copy-link":
          if (url) {
            await copyText(url);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
          return;
        case "download":
          setBusy(true);
          try {
            await downloadArtifact(client, workspaceId, item);
          } finally {
            setBusy(false);
          }
          return;
        case "delete": {
          const words = deleteConfirmation(item);
          Alert.alert(words.title, words.message, [
            { text: "Cancel", style: "cancel" },
            {
              text: words.confirm,
              style: "destructive",
              onPress: () =>
                void client
                  .archiveEditableArtifact(workspaceId, item.id)
                  .then(() => {
                    artifactChanged(client, workspaceId, item, null);
                    router.back();
                  })
                  .catch((caught: unknown) => failed("Couldn't delete", caught)),
            },
          ]);
          return;
        }
      }
    },
    [client, item, url, workspaceId],
  );
  const runAction = useRef(run);
  runAction.current = run;
  const press = (action: ArtifactMenuAction) =>
    void runAction.current(action).catch((caught: unknown) => failed(failureTitle(action), caught));

  const menuKey = menu.map((entry) => entry.id).join("|");
  const androidRight = useCallback(
    () => (
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <IconButton icon="share" accessibilityLabel="Share" onPress={share} />
        {menu.length > 0 ? (
          <NativeMenu
            actions={menu.map(menuAction)}
            onPressAction={({ nativeEvent }) => press(nativeEvent.event as ArtifactMenuAction)}
          >
            <IconButton icon="ellipsis" accessibilityLabel="More" busy={busy} />
          </NativeMenu>
        ) : null}
      </View>
    ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- handlers are read live
    [menuKey, share, busy],
  );

  const header = (
    <Stack.Screen
      options={{
        title: item?.title ?? params.title ?? "",
        headerStyle: { backgroundColor: c.bg },
        headerTintColor: c.fg,
        headerShadowVisible: false,
        ...(item
          ? Platform.OS === "ios"
            ? {
                unstable_headerRightItems: () => [
                  {
                    type: "button" as const,
                    label: "Share",
                    accessibilityLabel: "Share",
                    icon: { type: "sfSymbol" as const, name: "square.and.arrow.up" as const },
                    onPress: share,
                  },
                  ...(menu.length > 0
                    ? [
                        {
                          type: "menu" as const,
                          label: "More",
                          accessibilityLabel: "More",
                          icon: { type: "sfSymbol" as const, name: "ellipsis" as const },
                          menu: { items: iosMenuItems(menu, press) },
                        },
                      ]
                    : []),
                ],
              }
            : { headerRight: () => themed(androidRight()) }
          : {}),
      }}
    />
  );

  let content: React.ReactNode;
  if (!item) {
    content = problem ? (
      <Problem message={problem} onRetry={() => setAttempt((value) => value + 1)} />
    ) : (
      <ActivityIndicator style={{ marginTop: 48 }} color={c["fg-muted"]} />
    );
  } else {
    const mode = viewerMode(item.kind);
    content =
      mode === "image" ? (
        <ImageView workspaceId={workspaceId} item={item} />
      ) : mode === "file" ? (
        <FileView workspaceId={workspaceId} item={item} />
      ) : account ? (
        <WebPageView
          account={account}
          path={nativeViewPath(workspaceId, item)!}
          fallbackPath={url ? new URL(url).pathname : "/"}
        />
      ) : null;
  }
  return (
    <>
      {header}
      <View style={{ flex: 1, backgroundColor: c.bg, paddingBottom: insets.bottom }}>
        {content}
        {busy ? (
          <View
            pointerEvents="none"
            style={{ position: "absolute", top: 12, left: 0, right: 0, alignItems: "center" }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 18,
                backgroundColor: c["surface-2"],
              }}
            >
              <ActivityIndicator size="small" color={c["fg-muted"]} />
              <Text style={{ ...fontStyle(theme, 500), fontSize: 13, color: c.fg }}>
                Preparing download
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </>
  );
}

function failureTitle(action: ArtifactMenuAction): string {
  switch (action) {
    case "download":
      return "Couldn't download";
    case "duplicate":
      return "Couldn't duplicate";
    case "pin":
      return "Couldn't pin";
    case "unpin":
      return "Couldn't unpin";
    default:
      return "Something went wrong";
  }
}

function failed(title: string, caught: unknown) {
  Alert.alert(title, caught instanceof Error ? caught.message : undefined);
}

function menuAction(entry: ArtifactMenuItem): MenuAction {
  return {
    id: entry.id,
    title: entry.title,
    image: entry.symbol as MenuAction["image"],
    ...(entry.destructive ? { attributes: { destructive: true } } : {}),
  };
}

/** The ⋯ menu as iOS header items, its groups as inline sections. */
function iosMenuItems(menu: ArtifactMenuItem[], press: (action: ArtifactMenuAction) => void) {
  const sections: ArtifactMenuItem[][] = [];
  for (const entry of menu) {
    const last = sections.at(-1);
    if (last && last[0]!.section === entry.section) last.push(entry);
    else sections.push([entry]);
  }
  const action = (entry: ArtifactMenuItem) => ({
    type: "action" as const,
    label: entry.title,
    icon: { type: "sfSymbol" as const, name: entry.symbol },
    ...(entry.destructive ? { destructive: true } : {}),
    onPress: () => press(entry.id),
  });
  return sections.length === 1
    ? sections[0]!.map(action)
    : sections.map((group) => ({
        type: "submenu" as const,
        label: "",
        inline: true,
        items: group.map(action),
      }));
}

function Problem({
  message,
  onRetry,
  action,
}: {
  message: string;
  onRetry?: (() => void) | undefined;
  action?: { label: string; onPress: () => void } | undefined;
}) {
  const theme = useNativeTimelineTheme();
  return (
    <View style={{ alignItems: "center", gap: 14, marginTop: 56, paddingHorizontal: 32 }}>
      <Text
        style={{
          ...fontStyle(theme),
          fontSize: 14,
          color: theme.colors["fg-muted"],
          textAlign: "center",
        }}
      >
        {message}
      </Text>
      {onRetry ? <Button label="Try again" onPress={onRetry} /> : null}
      {action ? <Button label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

/** A Site or editor: the web app's chromeless page, signed in from the device session. */
function WebPageView({
  account,
  path,
  fallbackPath,
}: {
  account: { id: string; baseUrl: string };
  path: string;
  fallbackPath: string;
}) {
  const theme = useNativeTimelineTheme();
  const [session, setSession] = useState<"pending" | "ready" | "failed">("pending");
  const [painted, setPainted] = useState(false);
  const [failedLoad, setFailedLoad] = useState(false);
  useEffect(() => {
    let active = true;
    void signInWebViews(account).then((ok) => active && setSession(ok ? "ready" : "failed"));
    return () => {
      active = false;
    };
  }, [account]);
  if (session === "failed" || failedLoad) {
    return (
      <Problem
        message="This can't open in the app right now."
        action={{
          label: "Open in browser",
          onPress: () => openOnWeb(account.baseUrl, fallbackPath),
        }}
      />
    );
  }
  return (
    <View style={{ flex: 1 }}>
      {session === "ready" ? (
        <WebView
          source={{ uri: webUrl(account.baseUrl, path) }}
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          allowsInlineMediaPlayback
          allowsBackForwardNavigationGestures={false}
          setSupportMultipleWindows={false}
          onShouldStartLoadWithRequest={(request) => {
            if (viewerKeepsNavigation(account.baseUrl, request)) return true;
            // Only web and mail links leave for the system; a Site can't open other apps.
            if (/^(https?|mailto):/iu.test(request.url)) void Linking.openURL(request.url);
            return false;
          }}
          onLoadEnd={() => setPainted(true)}
          onError={() => setFailedLoad(true)}
          style={{ flex: 1, backgroundColor: theme.colors.bg, opacity: painted ? 1 : 0 }}
        />
      ) : null}
      {!painted ? (
        <View
          pointerEvents="none"
          style={{ position: "absolute", top: 0, left: 0, right: 0, alignItems: "center" }}
        >
          <ActivityIndicator style={{ marginTop: 48 }} color={theme.colors["fg-muted"]} />
        </View>
      ) : null}
    </View>
  );
}

function useDownloadUrl(workspaceId: string, item: ArtifactCatalogItem) {
  const { client } = useAccount();
  const [state, setState] = useState<{ url: string } | { failed: true } | null>(null);
  useEffect(() => {
    if (!item.file) {
      setState({ failed: true });
      return;
    }
    let active = true;
    void client
      .createRetainedArtifactDownloadUrl(workspaceId, item.file)
      .then((link) => active && setState({ url: link.url }))
      .catch(() => active && setState({ failed: true }));
    return () => {
      active = false;
    };
  }, [client, item.file, workspaceId]);
  return state;
}

/** An image, fitted to the screen and zoomable. */
function ImageView({ workspaceId, item }: { workspaceId: string; item: ArtifactCatalogItem }) {
  const theme = useNativeTimelineTheme();
  const link = useDownloadUrl(workspaceId, item);
  if (!link)
    return <ActivityIndicator style={{ marginTop: 48 }} color={theme.colors["fg-muted"]} />;
  if ("failed" in link) return <Problem message="This image couldn't load." />;
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ flexGrow: 1 }}
      maximumZoomScale={4}
      minimumZoomScale={1}
      centerContent
      bouncesZoom
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
    >
      <Image
        accessibilityLabel={item.title}
        source={{ uri: link.url }}
        resizeMode="contain"
        style={{ flex: 1, minHeight: 320 }}
      />
    </ScrollView>
  );
}

/**
 * Any other file: a passive type (PDF, text, media) is drawn in place on iOS,
 * without scripts and without leaving its own URL; markup and other types,
 * and every file on Android, open outside.
 */
function FileView({ workspaceId, item }: { workspaceId: string; item: ArtifactCatalogItem }) {
  const theme = useNativeTimelineTheme();
  const link = useDownloadUrl(workspaceId, item);
  if (!link)
    return <ActivityIndicator style={{ marginTop: 48 }} color={theme.colors["fg-muted"]} />;
  if ("failed" in link) return <Problem message="This file couldn't load." />;
  if (Platform.OS !== "ios" || !fileOpensInline(item.contentType))
    return (
      <Problem
        message={item.filename ?? item.title}
        action={{ label: "Open", onPress: () => void Linking.openURL(link.url) }}
      />
    );
  return (
    <WebView
      source={{ uri: link.url }}
      originWhitelist={["https://*"]}
      javaScriptEnabled={false}
      onShouldStartLoadWithRequest={(request) => request.url === link.url}
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
    />
  );
}
