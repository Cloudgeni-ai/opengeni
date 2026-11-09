import { afterEach, expect, mock, test } from "bun:test";
import type { FileAsset, ResourceRef, SessionTurn } from "@opengeni/sdk";
import type { StoredFileClientLike, StoredFileSource, useTurnQueue } from "@opengeni/react/session";
import { createOpenGeniText } from "@opengeni/react/messages";
import { createElement, type ComponentType, type ReactNode } from "react";
import {
  flush,
  registerDom,
  renderComponent,
  type RenderedComponent,
} from "../../react/test/render-hook";
import type { NativeAttachment, NativeFileAttachmentsResult } from "../src/attachments";

/*
 * An attached image always shows as an image on the phone too: a draft
 * restored from another device or a reload, and a queued message, carry only
 * the stored file, so their pictures load from the server. Bun cannot parse
 * react-native's Flow sources, so host components are DOM stand-ins; an
 * Image renders as an <img> with its source URI.
 */
function host(tag: string) {
  return function Host(props: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) {
    return createElement(
      tag,
      { "aria-label": props.accessibilityLabel, "data-role": props.accessibilityRole },
      props.children,
    );
  };
}

mock.module("react-native", () => {
  function Pressable(props: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    accessibilityRole?: string;
  }) {
    return createElement(
      "button",
      {
        type: "button",
        disabled: props.disabled,
        onClick: () => props.onPress?.(),
        "aria-label": props.accessibilityLabel,
        "data-role": props.accessibilityRole,
      },
      typeof props.children === "function" ? props.children({ pressed: false }) : props.children,
    );
  }
  function Image(props: { source?: { uri?: string } }) {
    return createElement("img", { src: props.source?.uri });
  }
  return {
    View: host("div"),
    Text: host("span"),
    ScrollView: host("div"),
    ActivityIndicator: () => null,
    Pressable,
    Modal: host("div"),
    KeyboardAvoidingView: host("div"),
    Animated: {
      View: host("div"),
      Value: function AnimatedValue() {},
      timing: () => ({ start: () => {} }),
    },
    Easing: { out: () => (value: number) => value, cubic: (value: number) => value },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    ActionSheetIOS: { showActionSheetWithOptions: () => {} },
    Alert: { alert: () => {} },
    AppState: { addEventListener: () => ({ remove: () => {} }), currentState: "active" },
    FlatList: host("div"),
    Image,
    Linking: { openURL: async () => {} },
    Share: { share: async () => ({}) },
    TextInput: host("input"),
    AccessibilityInfo: { isReduceMotionEnabled: async () => false },
    useWindowDimensions: () => ({ width: 390, height: 844 }),
    Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  };
});
mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
mock.module("react-native-svg", () => {
  const nothing = () => null;
  return {
    default: nothing,
    Circle: nothing,
    Defs: nothing,
    Line: nothing,
    LinearGradient: nothing,
    Path: nothing,
    Polyline: nothing,
    Rect: nothing,
    Stop: nothing,
  };
});
const layoutAnimation = { duration: () => layoutAnimation, delay: () => layoutAnimation };
mock.module("react-native-reanimated", () => ({
  default: { View: host("div"), Text: host("span"), ScrollView: host("div") },
  cancelAnimation: () => undefined,
  Easing: { linear: (value: number) => value, inOut: () => (value: number) => value },
  FadeIn: layoutAnimation,
  FadeInDown: layoutAnimation,
  FadeOut: layoutAnimation,
  FadeOutDown: layoutAnimation,
  FadeOutUp: layoutAnimation,
  LinearTransition: layoutAnimation,
  interpolateColor: () => "#000",
  useAnimatedKeyboard: () => ({ height: { value: 0 } }),
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => true,
  useSharedValue: (value: unknown) => ({ value }),
  withRepeat: (value: unknown) => value,
  withTiming: (value: unknown) => value,
}));

registerDom();

// The screen's heavy neighbours are stood in for; the chips under test are real.
for (const [path, stand] of [
  ["../src/timeline/message-timeline.tsx", { MessageTimeline: () => null }],
  [
    "../src/timeline/annotations.tsx",
    { AnnotationsChip: () => null, AnnotationsSheet: () => null },
  ],
  ["../src/timeline/composer.tsx", { SessionComposer: () => null }],
  ["../src/timeline/message-attachments.tsx", { NativeMessageAttachments: () => null }],
] as const) {
  mock.module(new URL(path, import.meta.url).pathname, () => stand);
}

type TurnQueue = ReturnType<typeof useTurnQueue>;
type ChipsProps = {
  attachments: NativeFileAttachmentsResult;
  restoredResources?: readonly ResourceRef[];
  onRemoveRestoredResource?: (index: number) => void;
  fileSource?: StoredFileSource;
};
const { AttachmentChips } = (await import("../src/timeline/session-screen")) as unknown as {
  AttachmentChips: ComponentType<ChipsProps>;
};
const { QueueDock } = (await import("../src/timeline/queue-dock")) as unknown as {
  QueueDock: ComponentType<{ queue: TurnQueue; fileSource?: StoredFileSource }>;
};
const { OpenGeniNativeAttachmentStrip } = (await import("../src/session-view")) as unknown as {
  OpenGeniNativeAttachmentStrip: ComponentType<{
    attachments: NativeFileAttachmentsResult;
    labels: unknown;
    theme: unknown;
    restoredResources?: readonly unknown[];
    onRemoveRestoredResource?: (index: number) => void;
    fileSource?: StoredFileSource;
  }>;
};
const { DEFAULT_OPENGENI_NATIVE_LABELS, DEFAULT_OPENGENI_NATIVE_THEME } =
  await import("../src/presentation");

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const PHOTO_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCREENSHOT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function storedFile(id: string, filename: string): FileAsset {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    status: "ready",
    filename,
    safeFilename: filename,
    contentType: "image/png",
    sizeBytes: 2048,
    sha256: null,
    bucket: "private",
    objectKey: `objects/${id}`,
    createdAt: "2026-11-05T00:00:00.000Z",
    updatedAt: "2026-11-05T00:00:00.000Z",
  };
}

const FILES = new Map([
  [PHOTO_ID, storedFile(PHOTO_ID, "site-photo.png")],
  [SCREENSHOT_ID, storedFile(SCREENSHOT_ID, "screenshot.png")],
]);

function fileSource(): StoredFileSource {
  const client = {
    getFile: async (_workspaceId: string, fileId: string) => {
      const file = FILES.get(fileId);
      if (!file) throw new Error("not found");
      return file;
    },
    createFileDownloadUrl: async (_workspaceId: string, fileId: string) => ({
      url: `https://files.example/${fileId}`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  } as unknown as StoredFileClientLike;
  return { client, workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };
}

function attachmentsResult(
  source: StoredFileSource,
  attachments: NativeAttachment[] = [],
): NativeFileAttachmentsResult {
  return {
    attachments,
    readyResources: [],
    uploading: false,
    hasUnresolved: false,
    error: null,
    pickDocuments: async () => {},
    pickImages: async () => {},
    addFiles: async () => {},
    retry: async () => {},
    remove: () => {},
    removeReadyFiles: () => {},
    clear: () => {},
    clearError: () => {},
    restoreReady: () => {},
    fileSource: source,
  };
}

let mounted: RenderedComponent | null = null;
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

async function imageSources(view: RenderedComponent, count: number): Promise<string[]> {
  const read = () =>
    [...view.container.querySelectorAll("img")].map((image) => image.getAttribute("src") ?? "");
  for (let attempt = 0; attempt < 100 && read().length < count; attempt += 1) await flush(5);
  return read();
}

test("composer chips show restored images as pictures from the server, with no local photo", async () => {
  const source = fileSource();
  // A new-chat draft restored on this phone: a ready upload with no local preview.
  const restoredUpload: NativeAttachment = {
    id: `restored:${PHOTO_ID}`,
    name: "site-photo.png",
    contentType: "image/png",
    sizeBytes: 2048,
    kind: "image",
    status: "ready",
    file: FILES.get(PHOTO_ID),
  };
  const removed: number[] = [];
  mounted = await renderComponent(
    <AttachmentChips
      attachments={attachmentsResult(source, [restoredUpload])}
      // An existing chat's draft written on another device.
      restoredResources={[{ kind: "file", fileId: SCREENSHOT_ID }]}
      onRemoveRestoredResource={(index) => removed.push(index)}
      fileSource={source}
    />,
  );
  expect(await imageSources(mounted, 2)).toEqual([
    `https://files.example/${PHOTO_ID}`,
    `https://files.example/${SCREENSHOT_ID}`,
  ]);
  const remove = mounted.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Remove screenshot.png"]',
  );
  expect(remove).not.toBeNull();
  remove!.click();
  expect(removed).toEqual([0]);
});

test("the queue dock shows a queued message's image", async () => {
  const source = fileSource();
  const turn = {
    id: "turn-1",
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    version: 1,
    status: "queued",
    prompt: "Compare with this",
    resources: [{ kind: "file", fileId: PHOTO_ID }],
    metadata: { delivery: "send" },
  } as unknown as SessionTurn;
  mounted = await renderComponent(
    <QueueDock
      queue={
        {
          queue: [turn],
          pendingInputs: [],
          mutationFor: () => null,
          mutating: false,
          mutationError: null,
          clearMutationError: () => {},
        } as unknown as TurnQueue
      }
      fileSource={source}
    />,
  );
  expect(await imageSources(mounted, 1)).toEqual([`https://files.example/${PHOTO_ID}`]);
  expect(mounted.container.textContent).toContain("Compare with this");
});

test("the session view's attachment strip names restored files and shows their pictures", async () => {
  const source = fileSource();
  mounted = await renderComponent(
    <OpenGeniNativeAttachmentStrip
      attachments={attachmentsResult(source)}
      labels={DEFAULT_OPENGENI_NATIVE_LABELS(createOpenGeniText())}
      theme={DEFAULT_OPENGENI_NATIVE_THEME}
      restoredResources={[{ kind: "file", fileId: SCREENSHOT_ID }]}
      onRemoveRestoredResource={() => {}}
      fileSource={source}
    />,
  );
  expect(await imageSources(mounted, 1)).toEqual([`https://files.example/${SCREENSHOT_ID}`]);
  expect(mounted.container.textContent).toContain("screenshot.png");
});
