import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { electronStub } from "./electron-stub";

mock.module("electron", () => electronStub);

import { DESKTOP_IPC, type DesktopMeetingRequest } from "../src/contract";
import {
  ENDED_AFTER_MS,
  identifyCallApp,
  isOwnApp,
  MeetingDetection,
  MeetingDetectionStore,
  MeetingPrompter,
  ownAppRoot,
  parseWatchLine,
  PROMPT_AFTER_MS,
  promptRequest,
  promptText,
  type MeetingPage,
  type MeetingPrompt,
  type MeetingPromptOutcome,
  type MicrophoneUser,
  type OwnApp,
} from "../src/main/meeting-detection";
import { MEETING_CARD_HTML, MEETING_CARD_MARGIN } from "../src/main/meeting-detection/card-page";
import { handleMeetingDetectionIpc } from "../src/main/meeting-detection/ipc";
import { ENGLISH_MEETING_WORDS } from "../src/main/meeting-detection/words";

// These import Electron, which the stub stands in for.
const { cardAction, cardBounds } = await import("../src/main/meeting-detection/card");
const { meetingDetectionFileLog } = await import("../src/main/meeting-detection/electron");
const { meetingDetectionBridge } = await import("../src/preload/meeting-detection");

function user(partial: Partial<MicrophoneUser> & { name: string }): MicrophoneUser {
  return { pid: 100, path: null, bundleId: null, owners: [], ...partial };
}

const own: OwnApp = {
  pid: 1,
  bundlePrefix: "com.example.desktop",
  root: "/Applications/Example.app/",
  platform: "darwin",
};

const zoom = user({ pid: 200, name: "zoom.us", bundleId: "us.zoom.xos" });
const chrome = user({
  pid: 300,
  name: "Google Chrome Helper",
  bundleId: "com.google.Chrome.helper",
});

describe("identifyCallApp", () => {
  test("names call apps by bundle id, path, name or owner", () => {
    expect(identifyCallApp(zoom)?.id).toBe("zoom");
    expect(identifyCallApp(chrome)).toMatchObject({ id: "chrome", browser: true });
    expect(
      identifyCallApp(
        user({ name: "Slack Helper", path: "/Applications/Slack.app/Contents/Frameworks/x" }),
      )?.id,
    ).toBe("slack");
    expect(identifyCallApp(user({ name: "ms-teams.exe" }))?.title).toBe("Teams meeting");
    expect(
      identifyCallApp(user({ name: "renderer", owners: ["C:\\Program Files\\Zoom\\Zoom.exe"] }))
        ?.id,
    ).toBe("zoom");
  });

  test("leaves other microphone users alone", () => {
    expect(identifyCallApp(user({ name: "Voice Memos", bundleId: "com.apple.VoiceMemos" }))).toBe(
      null,
    );
    expect(identifyCallApp(user({ name: "obs" }))).toBe(null);
  });
});

describe("own app", () => {
  test("finds the app's root folder", () => {
    expect(ownAppRoot("/Applications/Example.app/Contents/MacOS/Example", "darwin")).toBe(
      "/Applications/Example.app/",
    );
    expect(ownAppRoot("C:\\Apps\\Example\\Example.exe", "win32")).toBe("C:\\Apps\\Example\\");
    expect(ownAppRoot("/opt/Example/example", "linux")).toBe("/opt/Example/");
  });

  test("its own processes and helpers never count", () => {
    expect(isOwnApp(user({ pid: 1, name: "Example" }), own)).toBe(true);
    expect(isOwnApp(user({ name: "x", bundleId: "com.example.desktop.helper" }), own)).toBe(true);
    expect(
      isOwnApp(user({ name: "x", path: "/Applications/Example.app/Contents/Frameworks/h" }), own),
    ).toBe(true);
    expect(isOwnApp(zoom, own)).toBe(false);
    // Only the nearest owner: further up is a shell or the desktop.
    expect(
      isOwnApp(user({ name: "x", owners: ["/bin/zsh", "/Applications/Example.app/"] }), own),
    ).toBe(false);
  });
});

describe("parseWatchLine", () => {
  test("reads microphone users and errors", () => {
    expect(
      parseWatchLine(
        '{"event":"microphone","users":[{"pid":5,"name":"zoom.us","bundleId":"us.zoom.xos","owners":["/a"]},{"pid":"bad"}]}',
      ),
    ).toEqual({
      kind: "users",
      users: [{ pid: 5, name: "zoom.us", path: null, bundleId: "us.zoom.xos", owners: ["/a"] }],
    });
    expect(parseWatchLine('{"event":"error","code":"sound_server_unavailable"}')).toEqual({
      kind: "error",
      code: "sound_server_unavailable",
      message: "",
    });
    expect(parseWatchLine("not json")).toBe(null);
    expect(parseWatchLine('{"event":"other"}')).toBe(null);
  });
});

function prompter() {
  const shown: MeetingPrompt[] = [];
  const closed: MeetingPrompt[] = [];
  const subject = new MeetingPrompter(own, (prompt) => {
    shown.push(prompt);
    return { close: () => closed.push(prompt) };
  });
  return { subject, shown, closed };
}

describe("MeetingPrompter", () => {
  test("asks once a call has held the microphone a few seconds", () => {
    const { subject, shown } = prompter();
    subject.observe([zoom], 0);
    subject.evaluate(PROMPT_AFTER_MS - 1);
    expect(shown).toEqual([]);
    subject.evaluate(PROMPT_AFTER_MS);
    expect(shown.map((prompt) => [prompt.kind, prompt.app.id])).toEqual([["record", "zoom"]]);
    // Once per call, even with the microphone muted and back.
    subject.observe([], PROMPT_AFTER_MS + 1_000);
    subject.observe([zoom], PROMPT_AFTER_MS + 2_000);
    subject.evaluate(PROMPT_AFTER_MS * 3);
    expect(shown).toHaveLength(1);
  });

  test("a short microphone use and the app itself are not calls", () => {
    const { subject, shown } = prompter();
    subject.observe([zoom, user({ pid: 1, name: "Example" })], 0);
    subject.observe([], 1_000);
    subject.evaluate(PROMPT_AFTER_MS + ENDED_AFTER_MS);
    expect(shown).toEqual([]);
    expect(subject.activeCalls()).toEqual([]);
  });

  test("doesn't ask while recording, and offers to stop when the recorded call ends", () => {
    const { subject, shown, closed } = prompter();
    subject.observe([zoom], 0);
    subject.evaluate(PROMPT_AFTER_MS);
    subject.setRecording(true, PROMPT_AFTER_MS + 100);
    // The record prompt no longer applies.
    expect(closed.map((prompt) => prompt.kind)).toEqual(["record"]);
    // A browser joining during the recording isn't asked about.
    subject.observe([zoom, chrome], 5_000);
    subject.evaluate(10_000);
    expect(shown).toHaveLength(1);
    // Zoom ends; Chrome still holds the microphone, so the recording goes on.
    subject.observe([chrome], 11_000);
    subject.evaluate(11_000 + ENDED_AFTER_MS);
    expect(shown).toHaveLength(1);
    subject.observe([], 20_000);
    subject.evaluate(20_000 + ENDED_AFTER_MS - 1);
    expect(shown).toHaveLength(1);
    subject.evaluate(20_000 + ENDED_AFTER_MS);
    expect(shown.at(-1)).toMatchObject({ kind: "stop", app: { id: "chrome" } });
  });

  test("a call already going on when recording starts isn't offered after it", () => {
    const { subject, shown } = prompter();
    subject.setRecording(true, 0);
    subject.observe([zoom], 1_000);
    subject.setRecording(false, 2_000);
    subject.evaluate(10_000);
    expect(shown).toEqual([]);
  });

  test("turned off, it forgets calls and closes its prompt", () => {
    const { subject, shown, closed } = prompter();
    subject.observe([zoom], 0);
    subject.evaluate(PROMPT_AFTER_MS);
    subject.setEnabled(false, PROMPT_AFTER_MS + 1);
    expect(closed).toHaveLength(1);
    subject.observe([chrome], PROMPT_AFTER_MS + 2);
    subject.evaluate(PROMPT_AFTER_MS * 4);
    expect(shown).toHaveLength(1);
  });
});

describe("prompt words", () => {
  const record: MeetingPrompt = { kind: "record", app: identifyCallApp(zoom)! };
  const browser: MeetingPrompt = { kind: "record", app: identifyCallApp(chrome)! };
  const stop: MeetingPrompt = { kind: "stop", app: identifyCallApp(chrome)! };

  test("the card asks, says why, and names its two buttons", () => {
    expect(promptText(record)).toEqual({
      question: "Record this meeting?",
      reason: "A call in Zoom started.",
      action: "Record",
      dismiss: "Not now",
    });
    expect(promptText(browser).reason).toBe("Google Chrome is using your microphone.");
    expect(promptText(stop)).toEqual({
      question: "Meeting over?",
      reason: "Google Chrome stopped using your microphone. Still recording.",
      action: "Stop recording",
      dismiss: "Keep recording",
    });
  });

  test("an app gives its own words", () => {
    const words = {
      ...ENGLISH_MEETING_WORDS,
      recordQuestion: "Ta opp dette møtet?",
      callStarted: "En samtale i {app} startet.",
      record: "Ta opp",
    };
    expect(promptText(record, words)).toMatchObject({
      question: "Ta opp dette møtet?",
      reason: "En samtale i Zoom startet.",
      action: "Ta opp",
    });
  });

  test("the page gets the app and a meeting name", () => {
    expect(promptRequest(record)).toEqual({ kind: "record", app: "Zoom", title: "Zoom meeting" });
    expect(promptRequest(stop)).toEqual({ kind: "stop", app: "Google Chrome" });
  });
});

describe("MeetingDetectionStore", () => {
  test("on unless turned off, and remembered", () => {
    const dir = mkdtempSync(join(tmpdir(), "meetings-"));
    try {
      expect(new MeetingDetectionStore(dir).enabled()).toBe(true);
      new MeetingDetectionStore(dir).setEnabled(false);
      expect(new MeetingDetectionStore(dir).enabled()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

class FakePage implements MeetingPage {
  readonly sent: DesktopMeetingRequest[] = [];
  destroyed = false;
  constructor(readonly id: number) {}
  isDestroyed() {
    return this.destroyed;
  }
  send(channel: string, request: unknown) {
    if (channel === DESKTOP_IPC.meetingDetectionRequest)
      this.sent.push(request as DesktopMeetingRequest);
  }
}

/** Detection with a fake helper the test feeds, a fake card and a clock it sets. */
function detection(
  options: { chooseTarget?: (pages: readonly MeetingPage[]) => MeetingPage | undefined } = {},
) {
  let now = 0;
  let enabled = true;
  const helper = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
    stdin: { end() {} },
    exitCode: null,
    signalCode: null,
    kill() {},
  });
  const cards: Array<{
    prompt: MeetingPrompt;
    done: (outcome: MeetingPromptOutcome) => void;
    closed: boolean;
  }> = [];
  const log: string[] = [];
  let revealed = 0;
  const subject = new MeetingDetection({
    helperPath: "/fake/helper",
    available: true,
    own,
    store: {
      enabled: () => enabled,
      setEnabled: (value) => {
        enabled = value;
      },
    },
    view: {
      show: (prompt, done) => {
        const card = { prompt, done, closed: false };
        cards.push(card);
        return { close: () => (card.closed = true) };
      },
    },
    reveal: () => {
      revealed += 1;
    },
    ...(options.chooseTarget ? { chooseTarget: options.chooseTarget } : {}),
    log: (message) => log.push(message),
    spawnProcess: (() => helper) as never,
    now: () => now,
  });
  subject.start();
  const microphone = (users: MicrophoneUser[], at: number) => {
    now = at;
    helper.stdout.emit("data", `${JSON.stringify({ event: "microphone", users })}\n`);
  };
  return {
    subject,
    cards,
    log,
    microphone,
    revealed: () => revealed,
    /** A call in Zoom long enough to be asked about. */
    call: (app: MicrophoneUser = zoom, at = 0) => {
      microphone([app], at);
      microphone([app], at + PROMPT_AFTER_MS);
    },
  };
}

describe("MeetingDetection", () => {
  test("asks on the card, and Record goes to the page that listens, with the window up", () => {
    const { subject, cards, log, call, revealed } = detection();
    const older = new FakePage(1);
    const page = new FakePage(2);
    subject.listen(older, true);
    subject.listen(page, true);
    call();
    expect(cards.map((card) => card.prompt.kind)).toEqual(["record"]);
    expect(log).toContain("Meeting detection: asked to record a call (zoom).");
    cards[0]!.done("chosen");
    expect(revealed()).toBe(1);
    expect(page.sent).toEqual([{ kind: "record", app: "Zoom", title: "Zoom meeting" }]);
    expect(older.sent).toEqual([]);
    expect(log).toContain("Meeting detection: the person chose it (zoom).");
    subject.stop();
  });

  test("a choice waits for the page the app picks to listen", () => {
    const shown = new FakePage(2);
    const { subject, cards, call } = detection({
      chooseTarget: (pages) => pages.find((page) => page === shown),
    });
    const other = new FakePage(1);
    subject.listen(other, true);
    call();
    cards[0]!.done("chosen");
    expect(other.sent).toEqual([]);
    // The window opened; its page loads and listens.
    subject.listen(shown, true);
    expect(shown.sent.map((request) => request.kind)).toEqual(["record"]);
    // Delivered once.
    subject.listen(shown, true);
    expect(shown.sent).toHaveLength(1);
    subject.stop();
  });

  test("Stop recording goes to the page that records", () => {
    const { subject, cards, call, microphone } = detection();
    const recording = new FakePage(1);
    const newer = new FakePage(2);
    subject.listen(recording, true);
    subject.listen(newer, true);
    call();
    subject.setRecording(recording, true);
    // The question to record no longer applies once a recording starts.
    expect(cards[0]!.closed).toBe(true);
    microphone([], 10_000);
    microphone([], 10_000 + ENDED_AFTER_MS);
    expect(cards.at(-1)!.prompt.kind).toBe("stop");
    cards.at(-1)!.done("chosen");
    expect(recording.sent).toEqual([{ kind: "stop", app: "Zoom" }]);
    expect(newer.sent).toEqual([]);
    subject.stop();
  });

  test("a closed or timed out question doesn't hold back the next call's", () => {
    const { subject, cards, call, log } = detection();
    call(zoom, 0);
    cards[0]!.done("expired");
    expect(log).toContain("Meeting detection: the question timed out (zoom).");
    // Zoom's question is gone, so a browser call is asked about.
    call(chrome, 1_000);
    expect(cards.map((card) => card.prompt.app.id)).toEqual(["zoom", "chrome"]);
    cards[1]!.done("dismissed");
    expect(log).toContain("Meeting detection: the person closed the question (chrome).");
    // A late second outcome for the same card changes nothing.
    cards[1]!.done("chosen");
    expect(log.filter((line) => line.includes("chose"))).toEqual([]);
    subject.stop();
  });

  test("a page that goes away neither records nor takes choices", () => {
    const { subject, cards, call, microphone } = detection();
    const page = new FakePage(1);
    subject.listen(page, true);
    subject.setRecording(page, true);
    subject.pageGone(page);
    // Not recording any more: a new call is asked about.
    call(zoom, 1_000);
    expect(cards.map((card) => card.prompt.kind)).toEqual(["record"]);
    microphone([zoom], 10_000);
    cards[0]!.done("chosen");
    expect(page.sent).toEqual([]);
    subject.stop();
  });

  test("turning it off is remembered, logged and announced", () => {
    const { subject, log } = detection();
    let changes = 0;
    subject.onChange(() => (changes += 1));
    expect(subject.update({ enabled: false })).toMatchObject({ enabled: false, available: true });
    expect(changes).toBe(1);
    expect(log).toContain("Meeting detection: turned off.");
    subject.update({ enabled: false });
    expect(changes).toBe(1);
    subject.stop();
  });
});

describe("the card", () => {
  test("buttons report their outcome and the question they answer", () => {
    expect(cardAction("data:text/html,x#act/3/1700000000000")).toEqual({
      outcome: "chosen",
      token: 3,
    });
    expect(cardAction("data:text/html,x#dismiss/4/1")).toEqual({ outcome: "dismissed", token: 4 });
    expect(cardAction("data:text/html,x#expire/5/1")).toEqual({ outcome: "expired", token: 5 });
    expect(cardAction("data:text/html,x#act/zero/1")).toBe(null);
    expect(cardAction("data:text/html,x#other/1/1")).toBe(null);
    expect(cardAction("data:text/html,x")).toBe(null);
  });

  test("sits in the top right corner of the screen's work area", () => {
    const area = { x: 1440, y: 25, width: 1920, height: 1055 };
    const bounds = cardBounds(area, 120);
    expect(bounds.x + bounds.width).toBe(area.x + area.width);
    expect(bounds.y).toBe(area.y);
    expect(bounds.height).toBe(120);
    // The card inside keeps a margin from the screen's edges.
    expect(MEETING_CARD_MARGIN).toBeGreaterThan(8);
  });

  test("its page needs nothing but itself", () => {
    expect(MEETING_CARD_HTML).toContain("default-src 'none'");
    expect(MEETING_CARD_HTML).toContain(`padding: ${MEETING_CARD_MARGIN}px`);
    expect(MEETING_CARD_HTML).not.toMatch(/https?:\/\//u);
  });
});

describe("the record of what it asked", () => {
  test("appends timed lines and starts a new file past its size", () => {
    const dir = mkdtempSync(join(tmpdir(), "meetings-log-"));
    try {
      const log = meetingDetectionFileLog(dir);
      log("Meeting detection: asked to record a call (zoom).");
      log("Meeting detection: its helper failed.", new Error("gone"));
      const lines = readFileSync(join(dir, "meeting-detection.log"), "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(
        /^\d{4}-\d\d-\d\dT[\d:.]+Z Meeting detection: asked to record a call \(zoom\)\.$/u,
      );
      expect(lines[1]).toEndWith("its helper failed. gone");
      writeFileSync(join(dir, "meeting-detection.log"), "x".repeat(300 * 1024));
      log("after");
      expect(readFileSync(join(dir, "meeting-detection.log"), "utf8")).toEndWith(" after\n");
      expect(readFileSync(join(dir, "meeting-detection.log.old"), "utf8")).toHaveLength(300 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

class FakeContents extends EventEmitter {
  readonly sent: Array<[string, unknown]> = [];
  destroyed = false;
  constructor(readonly id: number) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  send(channel: string, payload?: unknown) {
    this.sent.push([channel, payload]);
  }
}

describe("handleMeetingDetectionIpc", () => {
  test("answers allowed pages, follows them, and tells them about changes", async () => {
    const { subject, cards, call } = detection();
    const handlers = new Map<string, (event: unknown, arg?: unknown) => unknown>();
    const ipcMain = {
      handle: (channel: string, run: (event: unknown, arg?: unknown) => unknown) =>
        handlers.set(channel, run),
      on: (channel: string, run: (event: unknown, arg?: unknown) => unknown) =>
        handlers.set(channel, run),
    };
    handleMeetingDetectionIpc({
      ipcMain: ipcMain as never,
      detection: subject,
      allow: (event) => {
        if ((event.sender as unknown as FakeContents).id === 99) throw new Error("Not allowed");
      },
    });
    const page = new FakeContents(1);
    const stranger = new FakeContents(99);
    expect(() => handlers.get(DESKTOP_IPC.meetingDetectionStatus)!({ sender: stranger })).toThrow();
    expect(await handlers.get(DESKTOP_IPC.meetingDetectionStatus)!({ sender: page })).toMatchObject(
      {
        enabled: true,
      },
    );
    handlers.get(DESKTOP_IPC.meetingDetectionListen)!({ sender: stranger }, true);
    handlers.get(DESKTOP_IPC.meetingDetectionListen)!({ sender: page }, true);
    call();
    cards[0]!.done("chosen");
    expect(page.sent).toContainEqual([
      DESKTOP_IPC.meetingDetectionRequest,
      { kind: "record", app: "Zoom", title: "Zoom meeting" },
    ]);
    expect(stranger.sent).toEqual([]);
    handlers.get(DESKTOP_IPC.meetingDetectionUpdate)!({ sender: page }, { enabled: false });
    expect(page.sent.at(-1)).toEqual([DESKTOP_IPC.meetingDetectionChanged, undefined]);
    // A closed page records nothing.
    handlers.get(DESKTOP_IPC.meetingDetectionUpdate)!({ sender: page }, { enabled: true });
    handlers.get(DESKTOP_IPC.meetingDetectionRecording)!({ sender: page }, true);
    page.emit("destroyed");
    call(chrome, 50_000);
    expect(cards.at(-1)!.prompt).toMatchObject({ kind: "record", app: { id: "chrome" } });
    subject.stop();
  });
});

describe("meetingDetectionBridge", () => {
  test("the page's newest listener gets the choices, and the app knows whether one listens", () => {
    const ipc = Object.assign(new EventEmitter(), {
      sent: [] as Array<[string, unknown]>,
      send(channel: string, value: unknown) {
        this.sent.push([channel, value]);
      },
      invoke: async () => undefined,
    });
    const bridge = meetingDetectionBridge(ipc as never);
    const first: DesktopMeetingRequest[] = [];
    const second: DesktopMeetingRequest[] = [];
    const stopFirst = bridge.onRequest((request) => first.push(request));
    const stopSecond = bridge.onRequest((request) => second.push(request));
    // An older listener's unsubscribe doesn't stop the newer one.
    stopFirst();
    ipc.emit(DESKTOP_IPC.meetingDetectionRequest, {}, { kind: "stop", app: "Zoom" });
    expect(first).toEqual([]);
    expect(second).toEqual([{ kind: "stop", app: "Zoom" }]);
    stopSecond();
    expect(ipc.sent).toEqual([
      [DESKTOP_IPC.meetingDetectionListen, true],
      [DESKTOP_IPC.meetingDetectionListen, true],
      [DESKTOP_IPC.meetingDetectionListen, false],
    ]);
    bridge.setRecording(true);
    expect(ipc.sent.at(-1)).toEqual([DESKTOP_IPC.meetingDetectionRecording, true]);
  });
});
