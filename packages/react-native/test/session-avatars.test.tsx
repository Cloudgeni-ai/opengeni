import { expect, mock, test } from "bun:test";
import type { RetainedArtifactMetadata, Session, SessionAvatar } from "@opengeni/sdk";
import {
  sessionAvatarFallbackHue,
  sessionAvatarTileHex,
} from "@opengeni/react/session-avatar-model";
import { createElement, type ReactNode } from "react";
import { flush, registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * A chat's and an agent's avatar on the phone, as the web SessionAvatar draws
 * it: emoji on a tint of their hue, icons and letters white on it, and image
 * avatars opened with the person's own access, showing the initials until
 * they load or when they cannot. Bun cannot parse react-native's Flow
 * sources, so host components are DOM stand-ins that keep the test id, the
 * tile colour and an image's source.
 */
type HostProps = {
  children?: ReactNode;
  testID?: string;
  accessibilityLabel?: string;
  style?: { backgroundColor?: string } | unknown;
};
function host(tag: string) {
  return function Host(props: HostProps) {
    const style = props.style as { backgroundColor?: string } | undefined;
    return createElement(
      tag,
      {
        "data-testid": props.testID,
        "aria-label": props.accessibilityLabel,
        "data-bg": typeof style === "object" && style ? style.backgroundColor : undefined,
      },
      props.children,
    );
  };
}

mock.module("react-native", () => ({
  View: host("div"),
  Text: host("span"),
  ScrollView: host("div"),
  Modal: host("div"),
  TextInput: host("input"),
  ActivityIndicator: () => null,
  Animated: {
    View: host("div"),
    Value: function AnimatedValue() {},
    timing: () => ({ start: () => {} }),
  },
  Easing: { out: () => (value: number) => value, cubic: (value: number) => value },
  AccessibilityInfo: { isReduceMotionEnabled: async () => false },
  AppState: { addEventListener: () => ({ remove: () => {} }), currentState: "active" },
  Linking: { openURL: async () => {} },
  Keyboard: { addListener: () => ({ remove: () => {} }), dismiss: () => {} },
  Pressable: (props: HostProps & { children?: unknown }) =>
    createElement(
      "button",
      { "aria-label": props.accessibilityLabel },
      typeof props.children === "function"
        ? (props.children as (state: { pressed: boolean }) => ReactNode)({ pressed: false })
        : (props.children as ReactNode),
    ),
  Image: (props: { source?: { uri?: string } }) => createElement("img", { src: props.source?.uri }),
  ActionSheetIOS: { showActionSheetWithOptions: () => {} },
  Alert: { alert: () => {} },
  Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
mock.module("react-native-svg", () => {
  const nothing = () => null;
  return {
    default: ({ children }: { children?: ReactNode }) => createElement("svg", null, children),
    Circle: nothing,
    Ellipse: nothing,
    Line: nothing,
    Path: nothing,
    Polygon: nothing,
    Polyline: nothing,
    Rect: nothing,
  };
});
const layoutAnimation = { duration: () => layoutAnimation, delay: () => layoutAnimation };
mock.module("react-native-reanimated", () => ({
  default: { View: host("div"), Text: host("span"), ScrollView: host("div") },
  cancelAnimation: () => undefined,
  Easing: {
    bezier: () => (value: number) => value,
    linear: (value: number) => value,
    inOut: () => (value: number) => value,
  },
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

const { SessionAvatar: NativeAvatar, useNativeSessionIdentity } =
  await import("../src/timeline/session-avatar");
const { SessionHeaderTitle, SessionRow } = await import("../src/timeline/session-list");

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const IMAGE_ID = "44444444-4444-4444-8444-444444444444";

function avatarClient(options: { contentType?: string; available?: boolean } = {}) {
  const reads: string[] = [];
  const client = {
    getRetainedArtifact: async (workspaceId: string, artifactId: string) => {
      reads.push(`metadata:${workspaceId}:${artifactId}`);
      return {
        artifactId,
        available: options.available ?? true,
        contentType: options.contentType ?? "image/png",
      } as unknown as RetainedArtifactMetadata;
    },
    createRetainedArtifactDownloadUrl: async (
      _workspaceId: string,
      artifact: { artifactId: string },
    ) => {
      reads.push(`download:${artifact.artifactId}`);
      return {
        url: `https://files.example/${artifact.artifactId}?signed=1`,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
    },
  };
  return { client, reads };
}

function tile(container: HTMLElement) {
  const element = container.querySelector<HTMLElement>("[data-testid^='session-avatar-']");
  return {
    kind: element?.dataset.testid?.slice("session-avatar-".length) ?? null,
    color: element?.dataset.bg ?? null,
    text: element?.textContent ?? "",
    image: element?.querySelector("img")?.getAttribute("src") ?? null,
  };
}

async function rendered(avatar: SessionAvatar, extra: Record<string, unknown> = {}) {
  const view = await renderComponent(
    createElement(NativeAvatar, {
      avatar,
      name: "Release desk",
      workspaceId: WORKSPACE_ID,
      ...extra,
    }),
  );
  await flush();
  return view;
}

test("emoji, icon and letter avatars draw the web's tiles", async () => {
  const emoji = await rendered({ kind: "emoji", emoji: "🦊", hue: 30 });
  expect(tile(emoji.container)).toMatchObject({
    kind: "emoji",
    text: "🦊",
    color: sessionAvatarTileHex("emojiLight", 30),
  });
  await emoji.unmount();

  const icon = await rendered({ kind: "icon", icon: "rocket", hue: 200 });
  expect(tile(icon.container)).toMatchObject({
    kind: "icon",
    color: sessionAvatarTileHex("solid", 200),
  });
  expect(icon.container.querySelector("svg")).not.toBeNull();
  await icon.unmount();

  const letters = await rendered({ kind: "letters", letters: "rd", hue: 120 });
  expect(tile(letters.container)).toMatchObject({
    kind: "letters",
    text: "RD",
    color: sessionAvatarTileHex("solid", 120),
  });
  await letters.unmount();
});

test("an image avatar loads with the person's access and is reused without a second read", async () => {
  const { client, reads } = avatarClient();
  const first = await renderComponent(
    createElement(NativeAvatar, {
      avatar: { kind: "image", artifactId: IMAGE_ID },
      name: "Release desk",
      workspaceId: WORKSPACE_ID,
      seed: SESSION_ID,
      client,
    }),
  );
  await flush();
  expect(tile(first.container)).toMatchObject({
    kind: "image",
    image: `https://files.example/${IMAGE_ID}?signed=1`,
  });
  await first.unmount();

  // Remounted (a scrolled or refreshed list), it shows the image at once.
  const again = await renderComponent(
    createElement(NativeAvatar, {
      avatar: { kind: "image", artifactId: IMAGE_ID },
      name: "Release desk",
      workspaceId: WORKSPACE_ID,
      client,
    }),
  );
  expect(tile(again.container).kind).toBe("image");
  await flush();
  expect(reads).toEqual([`metadata:${WORKSPACE_ID}:${IMAGE_ID}`, `download:${IMAGE_ID}`]);
  await again.unmount();
});

test("an image avatar the person cannot open, or that is not an image, shows the initials", async () => {
  for (const options of [{ available: false }, { contentType: "application/pdf" }]) {
    const { client } = avatarClient(options);
    const view = await rendered(
      { kind: "image", artifactId: crypto.randomUUID() },
      { client, seed: SESSION_ID },
    );
    // The chat's initials, on a colour kept stable by the chat's id.
    expect(tile(view.container)).toMatchObject({
      kind: "letters",
      text: "RD",
      color: sessionAvatarTileHex("solid", sessionAvatarFallbackHue(SESSION_ID)),
    });
    await view.unmount();
  }
  const withoutClient = await rendered({ kind: "image", artifactId: IMAGE_ID });
  expect(tile(withoutClient.container)).toMatchObject({ kind: "letters", text: "RD" });
  await withoutClient.unmount();
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    status: "idle",
    title: "Weekly release notes",
    titleSource: "user",
    model: "gpt-5",
    resources: [],
    metadata: {},
    updatedAt: "2026-11-08T10:00:00.000Z",
    ...overrides,
  } as unknown as Session;
}

test("a chat's row shows its avatar beside its title, and none without one", async () => {
  const withAvatar = await renderComponent(
    createElement(SessionRow, {
      session: session({ avatar: { kind: "emoji", emoji: "📣", hue: 280 } }),
      models: [],
      onPress: () => {},
    }),
  );
  expect(tile(withAvatar.container)).toMatchObject({ kind: "emoji", text: "📣" });
  await withAvatar.unmount();

  const plain = await renderComponent(
    createElement(SessionRow, { session: session(), models: [], onPress: () => {} }),
  );
  expect(tile(plain.container).kind).toBeNull();
  await plain.unmount();
});

function Header(props: { session: Session; client: unknown }) {
  const identity = useNativeSessionIdentity(props.session, props.client as never);
  return createElement(SessionHeaderTitle, {
    title: props.session.title ?? "",
    status: "idle",
    avatar: identity.avatar,
    agentName: identity.agentName,
  });
}

test("an agent's chat header shows the agent's current icon and name", async () => {
  const { client } = avatarClient();
  const agentReads: string[] = [];
  const withAgent = {
    ...client,
    getAgent: async (workspaceId: string, agentId: string) => {
      agentReads.push(`${workspaceId}:${agentId}`);
      return {
        id: agentId,
        name: "Release desk",
        avatar: { kind: "icon", icon: "megaphone", hue: 40 },
      };
    },
  };
  const view = await renderComponent(
    createElement(Header, {
      session: session({
        agentId: AGENT_ID,
        // The chat's own copy of the icon it started with is not what the header shows.
        avatar: { kind: "emoji", emoji: "🐢", hue: 10 },
      } as Partial<Session>),
      client: withAgent,
    }),
  );
  await flush();
  expect(agentReads).toEqual([`${WORKSPACE_ID}:${AGENT_ID}`]);
  expect(tile(view.container)).toMatchObject({
    kind: "icon",
    color: sessionAvatarTileHex("solid", 40),
  });
  expect(view.container.querySelector("[data-testid='session-header-agent']")?.textContent).toBe(
    "Release desk",
  );
  await view.unmount();
});

test("an ordinary chat header shows the chat's own avatar and no agent", async () => {
  const view = await renderComponent(
    createElement(Header, {
      session: session({ avatar: { kind: "letters", letters: "WR", hue: 90 } }),
      client: avatarClient().client,
    }),
  );
  await flush();
  expect(tile(view.container)).toMatchObject({ kind: "letters", text: "WR" });
  expect(view.container.querySelector("[data-testid='session-header-agent']")).toBeNull();
  await view.unmount();
});
