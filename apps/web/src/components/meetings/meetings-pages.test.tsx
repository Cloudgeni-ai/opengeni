import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const { MeetingsListPage } = await import("./meetings-list-page");
const { MeetingDetailPage } = await import("./meeting-detail-page");
const { createMeetingRecorderStore, MeetingRecorderStoreProvider } =
  await import("./recorder-context");
const { createMeetingsFixture } = await import("../../dev/ui-kit/pages/meetings/fixture");

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const store = createMeetingRecorderStore();
  await act(async () => {
    root.render(<MeetingRecorderStoreProvider value={store}>{node}</MeetingRecorderStoreProvider>);
  });
  return {
    container,
    store,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function settle(milliseconds = 400) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}

/** Wait until the page shows `text`: each read in the fixture takes 120 ms. */
async function waitForText(container: HTMLElement, text: string, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!(container.textContent ?? "").includes(text)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for "${text}"`);
    await settle(50);
  }
}

describe("Meetings list", () => {
  test("lists meetings with their state and opens one", async () => {
    const fixture = createMeetingsFixture();
    const opened: string[] = [];
    const view = await render(
      <MeetingsListPage
        workspaceId={fixture.workspaceId}
        recordings={fixture.client}
        meetingHref={(id) => `/meetings/${id}`}
        onOpen={(id) => opened.push(id)}
      />,
    );
    try {
      await settle();
      const text = view.container.textContent ?? "";
      expect(text).toContain("Weekly product sync");
      expect(text).toContain("Transcribing");
      expect(text).toContain("Transcript failed");
      // The recorder waits for its capture code before offering Start recording.
      const start = [...view.container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Start recording"),
      );
      expect(start?.disabled).toBe(true);
      const row = view.container.querySelector(`a[href="/meetings/${fixture.readyId}"]`);
      expect(row).not.toBeNull();
      await act(async () => {
        row!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      expect(opened).toEqual([fixture.readyId]);
    } finally {
      await view.unmount();
    }
  });

  test("an empty workspace explains how to start", async () => {
    const fixture = createMeetingsFixture({ state: "empty" });
    const view = await render(
      <MeetingsListPage
        workspaceId={fixture.workspaceId}
        recordings={fixture.client}
        meetingHref={(id) => `/meetings/${id}`}
        onOpen={() => {}}
      />,
    );
    try {
      await settle();
      expect(view.container.textContent).toContain("No meetings yet");
    } finally {
      await view.unmount();
    }
  });
});

describe("Meeting page", () => {
  test("shows the transcript with named and unnamed speakers", async () => {
    const fixture = createMeetingsFixture();
    const view = await render(
      <MeetingDetailPage
        workspaceId={fixture.workspaceId}
        recordingId={fixture.readyId}
        viewerSubjectId={fixture.viewerSubjectId}
        recordings={fixture.client}
        onBack={() => {}}
      />,
    );
    try {
      await waitForText(view.container, "Tomas Eriksen");
      const text = view.container.textContent ?? "";
      expect(text).toContain("Weekly product sync");
      expect(text).toContain("Ingrid Solberg");
      expect(text).toContain("Tomas Eriksen");
      expect(text).toContain("Speaker 2");
      expect(text).toContain("Version 1");
      expect(text).toContain("4 speakers");
      // The owner controls who can see it.
      expect(view.container.querySelector('[aria-label^="Who can see this"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("a voice suggestion is marked and can be turned down", async () => {
    const fixture = createMeetingsFixture();
    const view = await render(
      <MeetingDetailPage
        workspaceId={fixture.workspaceId}
        recordingId={fixture.readyId}
        viewerSubjectId={fixture.viewerSubjectId}
        voiceRecognition
        recordings={fixture.client}
        onBack={() => {}}
      />,
    );
    try {
      await waitForText(view.container, "Lea Haugen");
      const text = view.container.textContent ?? "";
      expect(text).toContain("Suggested from their voice");
      const notThem = view.container.querySelector<HTMLButtonElement>(
        '[aria-label="Not Lea Haugen"]',
      );
      expect(notThem).not.toBeNull();
      await act(async () => notThem!.click());
      await settle(400);
      const after = view.container.textContent ?? "";
      expect(after).not.toContain("Suggested from their voice");
      expect(after).toContain("Speaker 3");
    } finally {
      await view.unmount();
    }
  });

  test("someone else's shared meeting has no visibility control", async () => {
    const fixture = createMeetingsFixture();
    const view = await render(
      <MeetingDetailPage
        workspaceId={fixture.workspaceId}
        recordingId={fixture.readyId}
        viewerSubjectId="user:someone-else"
        recordings={fixture.client}
        onBack={() => {}}
      />,
    );
    try {
      await settle(700);
      expect(view.container.querySelector('[aria-label^="Who can see this"]')).toBeNull();
      expect(view.container.textContent).toContain("Shared with the workspace");
    } finally {
      await view.unmount();
    }
  });
});

describe("Recorder errors", () => {
  test("the desktop app points to the computer's settings, not the browser's", async () => {
    const { recorderErrorText } = await import("./recorder-panel");
    const denied = { code: "microphone_denied", message: "Permission denied" } as Parameters<
      typeof recorderErrorText
    >[0];
    expect(recorderErrorText(denied, "desktop").body).toContain("your computer's privacy settings");
    expect(recorderErrorText(denied, "display").body).toContain("browser");
    const helper = {
      code: "system_audio_unavailable",
      message: "Turn on System Audio Recording for Opengeni in System Settings.",
    } as Parameters<typeof recorderErrorText>[0];
    expect(recorderErrorText(helper, "desktop")).toEqual({
      title: "Can't record computer audio",
      body: "Turn on System Audio Recording for Opengeni in System Settings.",
    });
  });
});

describe("Live transcript", () => {
  test("a meeting recorded elsewhere shows the saved live text as a preview", async () => {
    const { LIVE_RECORDING_ID } = await import("../../dev/ui-kit/pages/meetings/fixture");
    const fixture = createMeetingsFixture();
    const view = await render(
      <MeetingDetailPage
        workspaceId={fixture.workspaceId}
        recordingId={LIVE_RECORDING_ID}
        viewerSubjectId="user:someone-else"
        recordings={fixture.client}
        onBack={() => {}}
      />,
    );
    try {
      await waitForText(view.container, "Let's keep this one short.");
      const text = view.container.textContent ?? "";
      expect(text).toContain("Not finished yet");
      expect(text).toContain("In progress");
      expect(text).toContain("this page updates by itself");
      // Someone else's microphone isn't "You".
      expect(text).toContain("Microphone");
      expect(text).not.toContain("You0:04");
      expect(view.container.querySelector('[role="log"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("the recorder offers live text when the workspace has a live model", async () => {
    const fixture = createMeetingsFixture();
    const view = await render(
      <MeetingsListPage
        workspaceId={fixture.workspaceId}
        recordings={fixture.client}
        liveTranscriptDefault
        meetingHref={(id) => `/meetings/${id}`}
        onOpen={() => {}}
      />,
    );
    try {
      await waitForText(view.container, "Live transcript");
      const box = [
        ...view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
      ].find((element) => element.closest("label")?.textContent?.includes("Live transcript"));
      expect(box?.checked).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  test("turns from one track read as one turn, in time order", async () => {
    const { groupLiveTurns } = await import("./live-transcript");
    const turns = groupLiveTurns([
      { trackNumber: 1, startMilliseconds: 9_000, text: "Morning." },
      { trackNumber: 0, startMilliseconds: 4_000, text: "Hi all." },
      { trackNumber: 1, startMilliseconds: 12_000, text: "Release went out." },
      { trackNumber: 1, startMilliseconds: 14_000, text: "  " },
    ]);
    expect(turns.map((turn) => [turn.trackNumber, turn.texts.join(" ")])).toEqual([
      [0, "Hi all."],
      [1, "Morning. Release went out."],
    ]);
  });
});
