import { describe, expect, mock, test } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { registerDom, renderComponent } from "../../react/test/render-hook";

/*
 * Bun cannot parse react-native's Flow sources, so its host components are
 * stood in for by DOM elements. The meeting screen, its speaker sheet and the
 * recordings hooks are the real ones, over the shared meetings fixture.
 */
function host(tag: string) {
  return function Host(props: { children?: ReactNode; accessibilityLabel?: string }) {
    return createElement(tag, { "aria-label": props.accessibilityLabel }, props.children);
  };
}

type AlertButton = { text: string; style?: string; onPress?: () => void };
const alerts: { title: string; message?: string; buttons?: AlertButton[] }[] = [];
const announced: string[] = [];

class AnimatedValue {
  setValue() {}
  interpolate() {
    return this;
  }
}

mock.module("react-native", () => ({
  View: host("div"),
  Text: host("span"),
  ScrollView: host("div"),
  Modal: host("div"),
  KeyboardAvoidingView: host("div"),
  RefreshControl: () => null,
  ActivityIndicator: () => null,
  Pressable(props: {
    children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) {
    return createElement(
      "button",
      {
        type: "button",
        disabled: props.disabled,
        onClick: () => props.onPress?.(),
        "aria-label": props.accessibilityLabel,
      },
      typeof props.children === "function" ? props.children({ pressed: false }) : props.children,
    );
  },
  TextInput(props: { accessibilityLabel?: string; onChangeText?: (value: string) => void }) {
    return createElement("input", {
      "aria-label": props.accessibilityLabel,
      onChange: (event: { target: { value: string } }) => props.onChangeText?.(event.target.value),
    });
  },
  Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Animated: {
    View: host("div"),
    Value: AnimatedValue,
    add: (value: unknown) => value,
    timing: () => ({
      start: (done?: (result: { finished: boolean }) => void) => done?.({ finished: true }),
    }),
    spring: () => ({ start: () => {} }),
  },
  Easing: {
    bezier: () => (value: number) => value,
    in: () => (value: number) => value,
    out: () => (value: number) => value,
    quad: (value: number) => value,
    cubic: (value: number) => value,
  },
  PanResponder: { create: () => ({ panHandlers: {} }) },
  Alert: {
    alert: (title: string, message?: string, buttons?: AlertButton[]) =>
      void alerts.push({ title, ...(message ? { message } : {}), ...(buttons ? { buttons } : {}) }),
  },
  AccessibilityInfo: {
    isReduceMotionEnabled: async () => true,
    announceForAccessibility: (text: string) => void announced.push(text),
  },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
mock.module("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
mock.module("react-native-svg", () => {
  const nothing = () => null;
  return {
    default: nothing,
    Circle: nothing,
    Line: nothing,
    Path: nothing,
    Polyline: nothing,
    Rect: nothing,
  };
});
// Recording on the phone is not what these tests are about.
mock.module(new URL("../src/recordings/index.ts", import.meta.url).pathname, () => ({
  useNativeRecorderPlatform: () => ({}),
}));
// The screen needs a few timeline pieces, not the whole session timeline.
const timeline = {
  ...(await import("../src/timeline/sheet")),
  ...(await import("../src/timeline/controls")),
  ...(await import("../src/timeline/icon")),
  ...(await import("../src/timeline/theme")),
};
mock.module(new URL("../src/timeline/index.ts", import.meta.url).pathname, () => timeline);

registerDom();

const { useMeetingView } = await import("../src/meetings/meeting-view");
const { createMeetingsFixture } = await import("../../react/src/testing/meetings-fixture");

const INGRID = "8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d";

function Screen(props: {
  fixture: ReturnType<typeof createMeetingsFixture>;
  recordings: object;
  voiceRecognition?: boolean;
}) {
  const view = useMeetingView({
    recordings: props.recordings,
    workspaceId: props.fixture.workspaceId,
    recordingId: props.fixture.readyId,
    viewer: { subjectId: props.fixture.viewerSubjectId, name: "Ingrid Solberg" },
    ...(props.voiceRecognition === undefined ? {} : { voiceRecognition: props.voiceRecognition }),
  });
  return <>{view.content}</>;
}

async function settle(milliseconds: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}

async function waitFor(check: () => boolean, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await settle(40);
  }
}

async function renderMeeting(options: { voiceRecognition?: boolean; forgetMine?: boolean } = {}) {
  alerts.length = 0;
  announced.length = 0;
  const fixture = createMeetingsFixture();
  const remembered: { personId: string; consent: string }[] = [];
  const forgotten: string[] = [];
  const recordings = {
    ...fixture.client,
    rememberRecordingPersonVoice: async (
      workspaceId: string,
      personId: string,
      request: { consent: "self" | "attested" },
    ) => {
      remembered.push({ personId, consent: request.consent });
      return await fixture.client.rememberRecordingPersonVoice(workspaceId, personId, request);
    },
    forgetRecordingPersonVoice: async (workspaceId: string, personId: string) => {
      forgotten.push(personId);
      return await fixture.client.forgetRecordingPersonVoice(workspaceId, personId);
    },
  };
  if (options.forgetMine)
    await fixture.client.forgetRecordingPersonVoice(fixture.workspaceId, INGRID);
  const view = await renderComponent(
    <Screen
      fixture={fixture}
      recordings={recordings}
      {...(options.voiceRecognition === undefined
        ? {}
        : { voiceRecognition: options.voiceRecognition })}
    />,
  );
  const text = () => view.container.textContent ?? "";
  const sheet = () => view.container.querySelector('[aria-label="Name speaker"]');
  const sheetText = () => sheet()?.textContent ?? "";
  const buttonIn = (scope: Element | null, name: string) =>
    [...(scope?.querySelectorAll("button") ?? [])].find(
      (element) =>
        element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
    );
  const button = (name: string) => buttonIn(view.container, name);
  const tap = async (name: string) => {
    await waitFor(() => button(name) !== undefined);
    await act(async () => button(name)!.click());
    await settle(20);
  };
  /** Tap a row of the open speaker sheet. */
  const choose = async (name: string) => {
    await waitFor(() => buttonIn(sheet(), name) !== undefined);
    await act(async () => buttonIn(sheet(), name)!.click());
    await settle(20);
  };
  await waitFor(() => button("Speaker 2, name this speaker") !== undefined);
  /** Open a speaker's sheet and wait for the people directory. */
  const openSpeaker = async (name: string) => {
    await tap(name);
    await waitFor(() => buttonIn(sheet(), "Tomas Eriksen") !== undefined);
  };
  return { view, text, sheet, sheetText, button, tap, choose, openSpeaker, remembered, forgotten };
}

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  const props = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
  (input as unknown as Record<string, { onChange: (event: unknown) => void }>)[props]!.onChange({
    target: input,
  });
}

describe("meeting screen voices", () => {
  test("naming yourself offers to remember your voice", async () => {
    const screen = await renderMeeting({ voiceRecognition: true, forgetMine: true });
    try {
      await screen.openSpeaker("Speaker 2, name this speaker");
      await screen.choose("It's me");
      await waitFor(() => screen.text().includes("Named you"));
      expect(screen.sheet()).toBeNull();
      expect(screen.text()).toContain("Later meetings will suggest your name when you speak.");
      expect(announced.at(-1)).toContain("Named you");
      await screen.tap("Remember my voice");
      await waitFor(() => screen.text().includes("Your voice will be remembered"));
      expect(screen.remembered).toEqual([{ personId: INGRID, consent: "self" }]);
    } finally {
      await screen.view.unmount();
    }
  });

  test("someone new is added to the people directory and asked about before remembering", async () => {
    const screen = await renderMeeting({ voiceRecognition: true });
    try {
      await screen.openSpeaker("Speaker 2, name this speaker");
      const input = screen.view.container.querySelector<HTMLInputElement>(
        'input[aria-label="Speaker name"]',
      )!;
      await act(async () => typeInto(input, "Ola Nordmann"));
      await screen.choose("Use “Ola Nordmann”");
      await waitFor(() => screen.text().includes("Named Ola Nordmann"));
      // A new name joins the people directory, so the chip is a person now.
      expect(screen.button("Ola Nordmann, change who this is")).toBeDefined();
      await screen.tap("Remember voice…");
      // Someone outside the workspace: only with their agreement.
      const asked = alerts.at(-1)!;
      expect(asked.title).toBe("Remember Ola Nordmann's voice?");
      await act(async () =>
        asked.buttons!.find((choice) => choice.text === "They agreed. Remember")!.onPress!(),
      );
      await waitFor(() => screen.text().includes("Ola Nordmann's voice will be remembered"));
      expect(screen.remembered.map((entry) => entry.consent)).toEqual(["attested"]);
    } finally {
      await screen.view.unmount();
    }
  });

  test("a name suggested from a voice is confirmed or turned down, with Undo", async () => {
    const screen = await renderMeeting({ voiceRecognition: true });
    try {
      const suggested = "Lea Haugen, suggested from their voice. Confirm or correct";
      await waitFor(() => screen.button(suggested) !== undefined);
      await screen.tap(suggested);
      await waitFor(() => screen.text().includes("Is this Lea Haugen?"));
      expect(screen.text()).toContain("Sounds like them (86% match)");
      expect(screen.sheetText()).toContain("Yes, it's Lea Haugen");
      await screen.choose("No, leave unnamed");
      await waitFor(() => screen.text().includes("Suggestion dismissed"));
      expect(screen.button(suggested)).toBeUndefined();
      await screen.tap("Undo");
      await waitFor(() => screen.button("Lea Haugen, change who this is") !== undefined);
    } finally {
      await screen.view.unmount();
    }
  });

  test("a remembered voice can be forgotten from its speaker", async () => {
    const screen = await renderMeeting({ voiceRecognition: true });
    try {
      await screen.openSpeaker("Ingrid Solberg, change who this is");
      expect(screen.sheetText()).toContain("Remembered voice");
      // It's already me, so "It's me" isn't offered.
      expect(screen.sheetText()).not.toContain("It's me");
      await screen.choose("Forget my voice");
      await waitFor(() => screen.text().includes("Your voice is forgotten"));
      expect(screen.forgotten).toEqual([INGRID]);
    } finally {
      await screen.view.unmount();
    }
  });

  test("without voice recognition, naming says names aren't suggested later", async () => {
    const screen = await renderMeeting({ voiceRecognition: false });
    try {
      await screen.openSpeaker("Speaker 2, name this speaker");
      await screen.choose("Tomas Eriksen");
      await waitFor(() => screen.text().includes("Names aren't suggested in later meetings"));
      expect(screen.text()).not.toContain("Remember");
    } finally {
      await screen.view.unmount();
    }
  });

  test("without a known setting, naming offers nothing", async () => {
    const screen = await renderMeeting({ forgetMine: true });
    try {
      await screen.openSpeaker("Speaker 2, name this speaker");
      await screen.choose("It's me");
      await waitFor(() => screen.sheet() === null);
      await settle(100);
      expect(screen.text()).not.toContain("Named you");
      expect(screen.text()).not.toContain("Names aren't suggested");
    } finally {
      await screen.view.unmount();
    }
  });
});
