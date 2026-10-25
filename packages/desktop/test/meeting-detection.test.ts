import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENDED_AFTER_MS,
  identifyCallApp,
  isOwnApp,
  MeetingDetectionStore,
  MeetingPrompter,
  ownAppRoot,
  parseWatchLine,
  PROMPT_AFTER_MS,
  promptRequest,
  promptText,
  type MeetingPrompt,
  type MicrophoneUser,
  type OwnApp,
} from "../src/main/meeting-detection";

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
  const stop: MeetingPrompt = { kind: "stop", app: identifyCallApp(chrome)! };

  test("macOS has buttons; elsewhere the body says to click", () => {
    expect(promptText(record, "darwin")).toEqual({
      title: "Record this meeting?",
      body: "A call in Zoom started.",
      action: "Record",
    });
    expect(promptText(record, "win32").body).toBe("A call in Zoom started. Click to record it.");
    expect(promptText(stop, "linux").body).toBe(
      "Google Chrome stopped using your microphone. Click to stop recording.",
    );
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
