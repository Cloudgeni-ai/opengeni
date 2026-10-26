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
const {
  createMeetingRecorderStore,
  MeetingRecorderProvider,
  MeetingRecorderStoreProvider,
  useMeetingRecorder,
} = await import("./recorder-context");
const { createMeetingsFixture, FAILED_RECORDING_ID } = await import("../testing/meetings-fixture");

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

async function waitFor(check: () => boolean, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
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

  test("search finds meetings by transcript words and says what it searches", async () => {
    const fixture = createMeetingsFixture();
    const view = await render(
      <MeetingsListPage
        workspaceId={fixture.workspaceId}
        recordings={fixture.client}
        meetingHref={(id) => `/meetings/${id}`}
        onOpen={() => {}}
      />,
    );
    const search = async (text: string) => {
      const input = view.container.querySelector<HTMLInputElement>(
        'input[aria-label="Search meetings"]',
      )!;
      await act(async () => {
        // react-dom watches the focused field for typing.
        input.focus();
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
          input,
          text,
        );
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        // react-dom loads before the DOM here, so it reads typing from key events.
        input.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }));
      });
      // Past the typing pause, then until the new list has loaded.
      await settle(400);
      const deadline = Date.now() + 3_000;
      while ((view.container.textContent ?? "").includes("Loading meetings")) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for the search");
        await settle(50);
      }
    };
    try {
      await waitForText(view.container, "Weekly product sync");
      // Spoken in the meeting, not in any title, and only the start of a word.
      await search("annual disc");
      const found = view.container.textContent ?? "";
      expect(found).toContain("Weekly product sync");
      expect(found).not.toContain("Transcript failed");
      await search("zzz");
      expect(view.container.textContent).toContain("Searches titles and transcripts.");
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

  test("a host can show only its own meetings inside its page, with a reminder at Start", async () => {
    const fixture = createMeetingsFixture();
    await fixture.client.updateRecording(fixture.workspaceId, fixture.readyId, {
      externalRef: "project:42",
    });
    const view = await render(
      <MeetingsListPage
        workspaceId={fixture.workspaceId}
        recordings={fixture.client}
        meetingHref={(id) => `/meetings/${id}`}
        onOpen={() => {}}
        externalRef="project:42"
        header={false}
        notice="Tell the people present that you're recording."
      />,
    );
    try {
      await waitForText(view.container, "Weekly product sync");
      const text = view.container.textContent ?? "";
      expect(text).not.toContain("Transcript failed");
      expect(text).toContain("Tell the people present that you're recording.");
      expect(view.container.querySelector("h1")).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("a host that doesn't let this person record says why, and still lists the meetings", async () => {
    const fixture = createMeetingsFixture();
    const view = await render(
      <MeetingsListPage
        workspaceId={fixture.workspaceId}
        recordings={fixture.client}
        meetingHref={(id) => `/meetings/${id}`}
        onOpen={() => {}}
        recordingOff="An administrator has to turn on meeting recording."
      />,
    );
    try {
      await waitForText(view.container, "Weekly product sync");
      const text = view.container.textContent ?? "";
      expect(text).toContain("An administrator has to turn on meeting recording.");
      const start = [...view.container.querySelectorAll("button")].find((button) =>
        /start recording/i.test(button.textContent ?? ""),
      );
      expect(start).toBeUndefined();
    } finally {
      await view.unmount();
    }
  });
});

describe("Recorder provider", () => {
  test("records with the host's own client, once the host knows its workspace", async () => {
    const requests: string[] = [];
    const client = {
      requestJson: async (method: string, path: string) => {
        requests.push(`${method} ${path}`);
        return {};
      },
    };
    const seen: { recorder: ReturnType<typeof useMeetingRecorder>["recorder"] } = {
      recorder: null,
    };
    function Probe() {
      seen.recorder = useMeetingRecorder().recorder;
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const mount = (workspaceId: string | null) =>
      act(async () => {
        root.render(
          <MeetingRecorderProvider workspaceId={workspaceId} client={client}>
            <Probe />
          </MeetingRecorderProvider>,
        );
      });
    await mount(null);
    await settle(100);
    expect(seen.recorder).toBeNull();
    await mount("workspace-1");
    const deadline = Date.now() + 3_000;
    while (!seen.recorder && Date.now() < deadline) await settle(50);
    expect(seen.recorder?.state).toBe("idle");
    await act(async () => root.unmount());
    container.remove();
  });
});

describe("Meeting page", () => {
  test("shows the host's own details beside the transcript", async () => {
    const fixture = createMeetingsFixture();
    const view = await render(
      <MeetingDetailPage
        workspaceId={fixture.workspaceId}
        recordingId={fixture.readyId}
        viewerSubjectId={fixture.viewerSubjectId}
        recordings={fixture.client}
        onBack={() => {}}
        details={(recording) => [
          { id: "project", label: "Project", content: `Linked to ${recording.title}` },
        ]}
      />,
    );
    try {
      await waitForText(view.container, "Linked to Weekly product sync");
      expect(view.container.textContent).toContain("Project");
    } finally {
      await view.unmount();
    }
  });

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
      // Speakers still to name sit at the top of the transcript, and each
      // unnamed turn says it can be named.
      const review = view.container.querySelector('[aria-label="Speakers to review"]');
      expect(review?.textContent).toContain("Speaker 2");
      expect(review?.textContent).not.toContain("Tomas Eriksen");
      expect(text).toContain("Who spoke? 1 speaker to name, 1 name to confirm.");
      expect(
        view.container.querySelectorAll('ol [aria-label="Speaker 2, name this speaker"]').length,
      ).toBeGreaterThan(0);
      // The owner controls who can see it.
      expect(view.container.querySelector('[aria-label^="Who can see this"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("notes an agent wrote show above the transcript, and the notepad saves as you type", async () => {
    const fixture = createMeetingsFixture();
    const opened: string[] = [];
    const view = await render(
      <MeetingDetailPage
        workspaceId={fixture.workspaceId}
        recordingId={fixture.readyId}
        viewerSubjectId={fixture.viewerSubjectId}
        recordings={fixture.client}
        onBack={() => {}}
        onOpenChat={(sessionId) => opened.push(sessionId)}
      />,
    );
    try {
      await waitForText(view.container, "Tomas reviews the schema change today");
      const text = view.container.textContent ?? "";
      expect(text).toContain("Written by an agent");
      expect(text.indexOf("Action items")).toBeLessThan(text.indexOf("Tomas Eriksen"));
      const openChat = [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Open the chat",
      )!;
      await act(async () => openChat.click());
      expect(opened).toEqual(["7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"]);

      const notepad = view.container.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder^="Jot down"]',
      )!;
      expect(notepad.value).toContain("Tomas: schema review");
      await act(async () => {
        // react-dom watches the focused field for typing.
        notepad.focus();
        const setValue = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setValue.call(notepad, `${notepad.value}\n- follow up on onboarding`);
        notepad.dispatchEvent(new window.Event("input", { bubbles: true }));
        // react-dom loads before the DOM here, so it reads typing from key events.
        notepad.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }));
      });
      await waitForText(view.container, "Saved");
      const saved = await fixture.client.listRecordingNotes(fixture.workspaceId, fixture.readyId);
      expect(saved.notes.find((note) => note.kind === "notepad")?.body).toContain(
        "follow up on onboarding",
      );
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
      expect(text).toContain("Suggested by voice");
      const notThem = view.container.querySelector<HTMLButtonElement>(
        '[aria-label="Not Lea Haugen"]',
      );
      expect(notThem).not.toBeNull();
      await act(async () => notThem!.click());
      await settle(400);
      const after = view.container.textContent ?? "";
      expect(after).not.toContain("Suggested by voice");
      expect(after).toContain("Speaker 3");
      expect(after).toContain("Who spoke? 2 speakers have no name yet.");
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

  test("a meeting whose audio retention deleted keeps its transcript and says why", async () => {
    const fixture = createMeetingsFixture();
    const view = await render(
      <MeetingDetailPage
        workspaceId={fixture.workspaceId}
        recordingId="7f8a9b0c-1d2e-4f3a-8b4c-5d6e7f8a9b0c"
        viewerSubjectId={fixture.viewerSubjectId}
        recordings={fixture.client}
        onBack={() => {}}
      />,
    );
    try {
      await waitForText(view.container, "The audio was deleted on");
      expect(view.container.textContent).toContain("retention setting");
      const again = [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Transcribe again",
      );
      expect(again?.disabled).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  test("a transcript that failed before the audio was prepared can be made again", async () => {
    const fixture = createMeetingsFixture();
    const view = await render(
      <MeetingDetailPage
        workspaceId={fixture.workspaceId}
        recordingId={FAILED_RECORDING_ID}
        viewerSubjectId={fixture.viewerSubjectId}
        recordings={fixture.client}
        onBack={() => {}}
      />,
    );
    try {
      await waitForText(view.container, "The transcript failed");
      await settle(300);
      expect(view.container.textContent).not.toContain("isn't available anymore");
      const again = [...view.container.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Transcribe again",
      );
      expect(again.length).toBeGreaterThan(0);
      for (const button of again) expect(button.disabled).toBe(false);
    } finally {
      await view.unmount();
    }
  });
});

describe("Retention settings", () => {
  test("names periods and warns only when a change deletes sooner", async () => {
    const { retentionPeriodName, retentionChangeWarning } = await import("./meeting-settings");
    expect(retentionPeriodName(30)).toBe("30 days");
    expect(retentionPeriodName(365)).toBe("1 year");
    expect(retentionPeriodName(730)).toBe("2 years");
    expect(retentionChangeWarning(undefined, { transcriptDays: 365 })?.confirmLabel).toBe(
      "Delete old meetings",
    );
    expect(retentionChangeWarning(undefined, { audioDays: 0 })?.title).toBe(
      "Delete audio once transcribed?",
    );
    expect(retentionChangeWarning({ audioDays: 7 }, { audioDays: 30 })).toBeNull();
    expect(retentionChangeWarning({ transcriptDays: 90 }, {})).toBeNull();
  });
});

describe("Transcription model picker", () => {
  test("says who pays for each model, and what makes an unavailable one pickable", async () => {
    const { transcriptionModelMeta, transcriptionModelUnavailableReason } =
      await import("./meeting-settings");
    const entry = {
      providerId: "codex-subscription",
      providerName: "ChatGPT subscription",
      model: "chatgpt-dictation",
      name: "ChatGPT dictation",
      available: false,
      funding: "workspace_subscription" as const,
      usdPerHour: 0,
      capabilities: {
        batch: true,
        live: false,
        diarization: false,
        liveDiarization: false,
        multichannel: false,
        maxSpeakers: null,
        wordTimestamps: false,
        languages: [],
        languageDetection: true,
        keyterms: false,
        speakerLibrary: false,
        maxDurationSeconds: 600,
        maxFileBytes: null,
      },
    };
    expect(transcriptionModelMeta(entry)).toBe("Your subscription");
    expect(transcriptionModelUnavailableReason(entry)).toBe(
      "Connect your ChatGPT subscription first",
    );
    const scribe = { ...entry, providerName: "ElevenLabs", funding: "workspace_key" as const };
    expect(transcriptionModelMeta({ ...scribe, usdPerHour: 0.22 })).toBe("$0.22 per hour");
    expect(transcriptionModelUnavailableReason(scribe)).toBe("Connect ElevenLabs first");
    const azure = { ...entry, providerName: "Azure Speech", funding: "deployment" as const };
    expect(transcriptionModelMeta(azure)).toBe("Azure Speech");
    expect(transcriptionModelUnavailableReason(azure)).toBe(
      "Azure Speech isn't available here right now",
    );
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
  });

  test("the desktop app's reason for no computer audio is said in the viewer's words", async () => {
    const { recorderErrorText } = await import("./recorder-panel");
    const failure = (reason?: string) =>
      ({
        code: "system_audio_unavailable",
        message: "The desktop app's own English sentence.",
        ...(reason ? { reason } : {}),
      }) as Parameters<typeof recorderErrorText>[0];
    expect(recorderErrorText(failure("permission_denied"), "desktop")).toEqual({
      title: "Computer audio isn't allowed",
      body: "Allow this app under System Settings > Privacy & Security > Screen & System Audio Recording, then start again.",
    });
    expect(recorderErrorText(failure("sound_server_unavailable"), "desktop").body).toBe(
      "No sound server (PipeWire or PulseAudio) is running. Start one, or record without computer audio.",
    );
    expect(recorderErrorText(failure("unavailable"), "desktop").body).toBe(
      "This computer can't record its own audio. Record without computer audio instead.",
    );
    for (const reason of ["capture_failed", undefined]) {
      expect(recorderErrorText(failure(reason), "desktop")).toEqual({
        title: "Can't record computer audio",
        body: "Computer audio didn't start. Start again, or record without computer audio.",
      });
    }
    const translated = (key: string) => `nb:${key}`;
    expect(
      recorderErrorText(failure("sound_server_unavailable"), "desktop", translated as never),
    ).toEqual({
      title: "nb:meetings.recorderPanel.canTRecordComputerAudio",
      body: "nb:meetings.recorderPanel.noSoundServerIsRunning",
    });
  });

  test("a used-up usage allowance says so in the person's words", async () => {
    const { uploadFailureReason } = await import("./recorder-panel");
    expect(uploadFailureReason("The workspace usage allowance is exhausted.")).toBe(
      "The usage allowance is used up, so new meetings can't be transcribed until it renews.",
    );
  });
});

describe("Live transcript", () => {
  /** A recorder on this device, recording the fixture's meeting in progress. */
  async function fakeRecorder(
    state: "recording" | "paused" | "stopping" | "stopped",
    upload: { pendingChunks?: number; finalized?: boolean; retryingAfterError?: string } = {},
  ) {
    const { LIVE_RECORDING_ID } = await import("../testing/meetings-fixture");
    const calls: string[] = [];
    const recorder = {
      state,
      recordingId: LIVE_RECORDING_ID,
      title: "Platform standup",
      elapsedMilliseconds: 754_000,
      tracks: [{ trackNumber: 0, source: "microphone", label: "Microphone" }],
      upload: {
        recordingId: LIVE_RECORDING_ID,
        created: true,
        pendingChunks: upload.pendingChunks ?? 1,
        pendingBytes: 4_000,
        uploading: true,
        retryingAfterError: upload.retryingAfterError ?? null,
        failed: null,
        finalized: upload.finalized ?? false,
        discarded: false,
      },
      error: null,
      live: null,
      supported: true,
      systemAudioSupported: false,
      systemAudioKind: null,
      recovered: [],
      start: async () => {},
      pause: () => calls.push("pause"),
      resume: () => calls.push("resume"),
      stop: async () => {
        calls.push("stop");
      },
      discard: async () => {},
      rename: async () => {},
      levels: () => ({}),
    } as unknown as NonNullable<ReturnType<typeof useMeetingRecorder>["recorder"]>;
    return { recorder, calls, recordingId: LIVE_RECORDING_ID };
  }

  test("taking notes while recording shows it's recording, with Stop, not Uploading", async () => {
    const fixture = createMeetingsFixture();
    const { recorder, calls, recordingId } = await fakeRecorder("recording");
    const view = await render(
      <MeetingDetailPage
        workspaceId={fixture.workspaceId}
        recordingId={recordingId}
        viewerSubjectId={fixture.viewerSubjectId}
        recordings={fixture.client}
        onBack={() => {}}
      />,
    );
    try {
      await act(async () => view.store.set(recorder));
      await waitForText(view.container, "Platform standup");
      const text = view.container.textContent ?? "";
      expect(text).not.toContain("Uploading");
      expect(text).not.toContain("Not finished yet");
      const bar = view.container.querySelector('section[aria-label="Recording"]');
      expect(bar?.textContent).toContain("12:34");
      const stop = [...bar!.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Stop",
      );
      expect(stop).toBeDefined();
      await act(async () => stop!.click());
      expect(calls).toEqual(["stop"]);
      // Said once, by the bar, not again beside the title.
      expect(text.split("Recording").length - 1).toBe(1);

      await act(async () => view.store.set({ ...recorder, state: "paused" }));
      expect(view.container.textContent).toContain("Paused");
      expect(view.container.textContent).toContain("Resume");
    } finally {
      await view.unmount();
    }
  });

  test("after Stop the meeting reads Transcribing, never Uploading", async () => {
    const fixture = createMeetingsFixture();
    // Stop waits for the last few seconds of audio, then the recorder is stopped.
    const { recorder, recordingId } = await fakeRecorder("stopping", { pendingChunks: 1 });
    const view = await render(
      <MeetingDetailPage
        workspaceId={fixture.workspaceId}
        recordingId={recordingId}
        viewerSubjectId={fixture.viewerSubjectId}
        recordings={fixture.client}
        onBack={() => {}}
      />,
    );
    try {
      await act(async () => view.store.set(recorder));
      await waitForText(view.container, "Platform standup");
      let text = view.container.textContent ?? "";
      expect(text).toContain("Transcribing");
      expect(text).not.toContain("Uploading");
      expect(view.container.querySelector('section[aria-label="Recording"]')).toBeNull();
      await act(async () =>
        view.store.set({
          ...recorder,
          state: "stopped",
          upload: { ...recorder.upload!, pendingChunks: 0, finalized: true },
        }),
      );
      expect(view.container.textContent).toContain("Transcribing");

      // Only a lost connection keeps it from transcribing, and it says so.
      await act(async () =>
        view.store.set({
          ...recorder,
          upload: { ...recorder.upload!, retryingAfterError: "Failed to fetch" },
        }),
      );
      text = view.container.textContent ?? "";
      expect(text).toContain("Offline");
      expect(text).not.toContain("Transcribing.");
    } finally {
      await view.unmount();
    }
  });

  test("the list says Transcribing for a meeting just stopped here", async () => {
    const fixture = createMeetingsFixture();
    const { recorder } = await fakeRecorder("stopping", { pendingChunks: 1 });
    const view = await render(
      <MeetingsListPage
        workspaceId={fixture.workspaceId}
        recordings={fixture.client}
        meetingHref={(id) => `/meetings/${id}`}
        onOpen={() => {}}
      />,
    );
    try {
      await act(async () => view.store.set(recorder));
      await waitForText(view.container, "Platform standup");
      await settle();
      // The widest box around the meeting's title that holds no other meeting.
      let row: Element | null = [...view.container.querySelectorAll("a")].find((link) =>
        link.textContent?.includes("Platform standup"),
      )!;
      while (row.parentElement && row.parentElement.querySelectorAll("a").length === 1) {
        row = row.parentElement;
      }
      expect(row.textContent).toContain("Transcribing");
      expect(view.container.textContent).not.toContain("Uploading");
    } finally {
      await view.unmount();
    }
  });

  test("a meeting can be named while it records", async () => {
    const { RecorderPanel } = await import("./recorder-panel");
    const renamed: string[] = [];
    const recorder = {
      state: "recording",
      recordingId: "r1",
      title: null,
      elapsedMilliseconds: 61_000,
      tracks: [],
      upload: null,
      error: null,
      live: null,
      supported: true,
      systemAudioSupported: false,
      systemAudioKind: null,
      recovered: [],
      start: async () => {},
      pause: () => {},
      resume: () => {},
      stop: async () => {},
      discard: async () => {},
      rename: async (title: string) => {
        renamed.push(title);
      },
      levels: () => ({}),
    } as unknown as Parameters<typeof RecorderPanel>[0]["recorder"];
    const view = await render(<RecorderPanel recorder={recorder} />);
    try {
      expect(view.container.textContent).toContain("No name yet");
      const nameIt = [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Name it",
      )!;
      await act(async () => nameIt.click());
      const input = view.container.querySelector<HTMLInputElement>("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "  Customer call  ",
        );
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
        // react-dom loads before the DOM here, so it reads typing from key events.
        input.dispatchEvent(new window.KeyboardEvent("keyup", { bubbles: true }));
      });
      const save = [...view.container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Save",
      )!;
      await act(async () => save.click());
      await settle(50);
      expect(renamed).toEqual(["Customer call"]);
    } finally {
      await view.unmount();
    }
  });

  test("a meeting recorded elsewhere shows the saved live text as a preview", async () => {
    const { LIVE_RECORDING_ID } = await import("../testing/meetings-fixture");
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
      expect(text).toContain("still being recorded on another device");
      // Someone else's microphone isn't "You".
      expect(text).toContain("Microphone");
      expect(text).not.toContain("You0:04");
      expect(view.container.querySelector('[role="log"]')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("the recorder bar keeps live text and its cost in its options menu", async () => {
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
      await waitForText(view.container, "Start recording");
      // It waits in the options menu beside Start, not as another control in the bar.
      expect(view.container.textContent).not.toContain("Live transcript");
      expect(view.container.textContent).not.toContain("per hour");
    } finally {
      await view.unmount();
    }
  });

  test("the recorder starts in the workspace's meeting language", async () => {
    const fixture = createMeetingsFixture();
    const view = await render(
      <MeetingsListPage
        workspaceId={fixture.workspaceId}
        recordings={fixture.client}
        defaultLanguage="no"
        meetingHref={(id) => `/meetings/${id}`}
        onOpen={() => {}}
      />,
    );
    try {
      await waitForText(view.container, "Start recording");
      expect(
        view.container.querySelector('button[aria-label="Recording options, Norwegian"]'),
      ).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  test("without a language from the host, the recorder starts in the one the server reports", async () => {
    const fixture = createMeetingsFixture({ language: "no" });
    const view = await render(
      <MeetingsListPage
        workspaceId={fixture.workspaceId}
        recordings={fixture.client}
        meetingHref={(id) => `/meetings/${id}`}
        onOpen={() => {}}
      />,
    );
    try {
      await waitForText(view.container, "Start recording");
      await waitFor(
        () =>
          view.container.querySelector('button[aria-label="Recording options, Norwegian"]') !==
          null,
      );
    } finally {
      await view.unmount();
    }
  });

  test("streamed pieces are joined without doubled or stray punctuation", async () => {
    const { tidyLiveText, tidyPartialText } = await import("./live-transcript");
    expect(tidyLiveText(["It's between you…", ". And the dog ."])).toBe(
      "It's between you. And the dog.",
    );
    expect(tidyLiveText(["Well...", "maybe,,", "yes!!"])).toBe("Well... maybe, yes!");
    expect(tidyPartialText("so we were thinking…")).toBe("so we were thinking");
  });

  test("unavailable live text says why and that nothing is lost", async () => {
    const { liveUnavailableText } = await import("./recorder-panel");
    const text = liveUnavailableText([
      { error: { code: "quota_exceeded", message: "The live transcript stopped" } },
    ]);
    expect(text).toContain("out of credit");
    expect(text).toContain("You still get the transcript");
    expect(liveUnavailableText([{ error: null }])).not.toContain("  ");
  });

  test("a stopped upload says why the server refused it", async () => {
    const { recorderErrorText } = await import("./recorder-panel");
    expect(
      recorderErrorText({ code: "upload_failed", message: "Recording not found" }).body,
    ).toContain("The meeting was deleted, or you no longer have access to it.");
    expect(
      recorderErrorText({ code: "upload_failed", message: "Chunk index out of range." }).body,
    ).toContain("The server refused the audio: Chunk index out of range.");
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
