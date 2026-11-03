import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { electronStub } from "./electron-stub";

mock.module("electron", () => electronStub);

import { DESKTOP_IPC, type DesktopMeetingRequest } from "../src/contract";
import {
  ENDED_AFTER_MS,
  joinPrompt,
  MeetingDetection,
  MeetingDetectionStore,
  PROMPT_AFTER_MS,
  promptRequest,
  promptText,
  type MeetingPage,
  type MeetingPrompt,
  type MeetingPromptOutcome,
  type MicrophoneUser,
} from "../src/main/meeting-detection";
import {
  JOIN_LATE_MS,
  parseUpcomingMeetings,
  RECHECK_CALENDAR_MS,
  REMIND_BEFORE_MS,
  type CalendarMeeting,
  type JoinReminder,
} from "../src/main/meeting-detection/reminders";

const START = Date.parse("2026-11-03T10:00:00Z");
const MINUTE = 60_000;

function wire(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-sync",
    provider: "google",
    title: "Weekly sync",
    private: false,
    startsAt: new Date(START).toISOString(),
    endsAt: new Date(START + 30 * MINUTE).toISOString(),
    joinUrl: "https://meet.google.com/abc-defg-hij",
    service: "Google Meet",
    unanswered: false,
    ...overrides,
  };
}

function meeting(overrides: Partial<CalendarMeeting> = {}): CalendarMeeting {
  return parseUpcomingMeetings({ calendar: "connected", meetings: [wire()] })!.meetings.map(
    (parsed) => ({ ...parsed, ...overrides }),
  )[0]!;
}

function reminder(overrides: Partial<JoinReminder> = {}): JoinReminder {
  return {
    accountId: "account-a",
    meeting: meeting(),
    replace: false,
    shownAt: START - REMIND_BEFORE_MS,
    timeoutMs: REMIND_BEFORE_MS + JOIN_LATE_MS,
    ...overrides,
  };
}

describe("reading upcoming meetings", () => {
  test("keeps meetings with an https join link, soonest first; drops the rest", () => {
    const parsed = parseUpcomingMeetings({
      calendar: "connected",
      meetings: [
        wire({ id: "later", startsAt: new Date(START + 10 * MINUTE).toISOString() }),
        wire({ id: "first" }),
        wire({ id: "plain-http", joinUrl: "http://meet.google.com/abc-defg-hij" }),
        wire({ id: "scheme", joinUrl: "zoommtg://zoom.us/join" }),
        wire({ id: "other-calendar", provider: "yahoo" }),
        wire({ id: "no-time", startsAt: "soon" }),
        wire({ id: "", title: "no id" }),
        wire({ id: "no-service", service: " " }),
        null,
      ],
    });
    expect(parsed?.calendar).toBe("connected");
    expect(parsed?.meetings.map((item) => item.id)).toEqual(["first", "no-service", "later"]);
    expect(parsed?.meetings[1]!.service).toBe("Meeting");
    expect(parseUpcomingMeetings({ calendar: "none", meetings: [] })).toEqual({
      calendar: "none",
      complete: true,
      meetings: [],
    });
    expect(
      parseUpcomingMeetings({ calendar: "connected", complete: false, meetings: [] })?.complete,
    ).toBe(false);
    expect(parseUpcomingMeetings({ meetings: [] })).toBeNull();
    expect(parseUpcomingMeetings(null)).toBeNull();
  });
});

describe("the reminder's card", () => {
  test("names the meeting, when it starts and its service, with one action", () => {
    expect(promptText(joinPrompt(reminder()))).toEqual({
      question: "Weekly sync",
      reason: "Starts in 1 min · Google Meet",
      action: "Join and start recording",
      dismiss: "Not now",
    });
    expect(promptText(joinPrompt(reminder({ shownAt: START - 10_000 }))).reason).toBe(
      "Starting now · Google Meet",
    );
    expect(promptText(joinPrompt(reminder({ shownAt: START + 3 * MINUTE + 5_000 }))).reason).toBe(
      "Started 3 min ago · Google Meet",
    );
    expect(promptText(joinPrompt(reminder({ replace: true }))).action).toBe(
      "Join and record this one",
    );
    expect(promptText(joinPrompt(reminder({ meeting: meeting({ title: "" }) }))).question).toBe(
      "Meeting",
    );
  });

  test("joining records that calendar event; a private one isn't named after it", () => {
    expect(promptRequest(joinPrompt(reminder()))).toEqual({
      kind: "record",
      app: "Google Meet",
      title: "Weekly sync",
      calendarEvent: { provider: "google", id: "evt-sync" },
    });
    expect(
      promptRequest(
        joinPrompt(
          reminder({ meeting: meeting({ private: true, title: "Doctor" }), replace: true }),
        ),
      ),
    ).toEqual({
      kind: "record",
      app: "Google Meet",
      title: "Google Meet",
      calendarEvent: { provider: "google", id: "evt-sync" },
      replace: true,
    });
  });
});

describe("the reminders switch", () => {
  test("on unless turned off, kept beside the others", () => {
    const dir = mkdtempSync(join(tmpdir(), "meetings-"));
    try {
      expect(new MeetingDetectionStore(dir).calendarReminders()).toBe(true);
      new MeetingDetectionStore(dir).setCalendarReminders(false);
      new MeetingDetectionStore(dir).setEnabled(false);
      expect(new MeetingDetectionStore(dir).calendarReminders()).toBe(false);
      expect(new MeetingDetectionStore(dir).enabled()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

class FakePage implements MeetingPage {
  readonly sent: DesktopMeetingRequest[] = [];
  constructor(readonly id: number) {}
  isDestroyed() {
    return false;
  }
  send(channel: string, request: unknown) {
    if (channel === DESKTOP_IPC.meetingDetectionRequest)
      this.sent.push(request as DesktopMeetingRequest);
  }
}

const zoom: MicrophoneUser = {
  pid: 200,
  name: "zoom.us",
  path: null,
  bundleId: "us.zoom.xos",
  owners: [],
};

/** Detection with reminders from a calendar the test sets, a fake card and a clock it sets. */
function reminders(
  options: { calendar?: "connected" | "none"; meetings?: unknown[]; on?: boolean } = {},
) {
  let now = START - 10 * MINUTE;
  let on = options.on ?? true;
  let active: string | null = "account-a";
  let body: unknown = {
    calendar: options.calendar ?? "connected",
    meetings: options.meetings ?? [wire()],
  };
  const reads: string[] = [];
  const opened: string[] = [];
  const cards: Array<{
    prompt: MeetingPrompt;
    done: (outcome: MeetingPromptOutcome) => void;
    closed: boolean;
  }> = [];
  const log: string[] = [];
  let revealed = 0;
  const helper = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
    stdin: { end() {} },
    exitCode: null,
    signalCode: null,
    kill() {},
  });
  const subject = new MeetingDetection({
    helperPath: "/fake/helper",
    available: true,
    own: {
      pid: 1,
      bundlePrefix: "com.example.desktop",
      root: "/Applications/E.app/",
      platform: "darwin",
    },
    store: {
      enabled: () => true,
      setEnabled: () => {},
      calendarReminders: () => on,
      setCalendarReminders: (value) => {
        on = value;
      },
      canRecord: () => true,
      setCanRecord: () => {},
    },
    view: {
      show: (prompt, done) => {
        // Answering it puts it away, as the real card does.
        const card = {
          prompt,
          done: (outcome: MeetingPromptOutcome) => {
            card.closed = true;
            done(outcome);
          },
          closed: false,
        };
        cards.push(card);
        return { close: () => (card.closed = true) };
      },
    },
    reveal: () => {
      revealed += 1;
    },
    calendar: {
      account: () => (active ? { id: active } : null),
      upcoming: async (accountId) => {
        reads.push(accountId);
        return body;
      },
      openUrl: (url) => opened.push(url),
    },
    log: (message) => log.push(message),
    spawnProcess: (() => helper) as never,
    now: () => now,
  });
  subject.start();
  /** Let the read the reminders started settle. */
  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  };
  /** The clock moves to `at`, and the reminders look again. */
  const at = async (time: number) => {
    now = time;
    subject.refreshCalendar();
    await settle();
  };
  const shown = () => cards.filter((card) => !card.closed && card.prompt.kind === "join");
  return {
    subject,
    cards,
    shown,
    reads,
    opened,
    log,
    at,
    settle,
    revealed: () => revealed,
    setBody: (next: unknown) => {
      body = next;
    },
    setActive: (id: string | null) => {
      active = id;
    },
    /** The clock moves, and nothing else happens. */
    setNow: (time: number) => {
      now = time;
    },
    microphone: (users: MicrophoneUser[], time: number) => {
      now = time;
      helper.stdout.emit("data", `${JSON.stringify({ event: "microphone", users })}\n`);
    },
  };
}

describe("reminders before calendar meetings", () => {
  test("a minute before, the card offers to join; choosing it opens the link and starts its recording", async () => {
    const run = reminders();
    const page = new FakePage(1);
    run.subject.listen(page, true);
    await run.settle();
    expect(run.reads).toEqual(["account-a"]);
    await run.at(START - REMIND_BEFORE_MS - 1_000);
    expect(run.shown()).toHaveLength(0);
    await run.at(START - REMIND_BEFORE_MS);
    expect(run.shown()).toHaveLength(1);
    const card = run.shown()[0]!;
    expect(promptText(card.prompt).reason).toBe("Starts in 1 min · Google Meet");
    // It stays until a few minutes after the start, unless dismissed.
    expect(card.prompt.kind === "join" && card.prompt.reminder.timeoutMs).toBe(
      REMIND_BEFORE_MS + JOIN_LATE_MS,
    );
    card.done("chosen");
    expect(run.opened).toEqual(["https://meet.google.com/abc-defg-hij"]);
    // A page records in the background: the window doesn't jump in front of the meeting.
    expect(run.revealed()).toBe(0);
    expect(page.sent).toEqual([
      {
        kind: "record",
        app: "Google Meet",
        title: "Weekly sync",
        calendarEvent: { provider: "google", id: "evt-sync" },
      },
    ]);
    // Offered once.
    await run.at(START);
    expect(run.shown()).toHaveLength(0);
    run.subject.shutdown();
  });

  test("with the app's window closed, the choice waits for the page that opens", async () => {
    const run = reminders();
    await run.at(START - REMIND_BEFORE_MS);
    run.shown()[0]!.done("chosen");
    expect(run.opened).toHaveLength(1);
    expect(run.revealed()).toBe(1);
    const page = new FakePage(1);
    run.subject.listen(page, true);
    expect(page.sent.map((request) => request.kind)).toEqual(["record"]);
    run.subject.shutdown();
  });

  test("Not now ends the offer for every meeting due then; a later one is still offered", async () => {
    const run = reminders({
      meetings: [
        wire({ id: "a", title: "Design review" }),
        wire({ id: "b", title: "Also now" }),
        wire({
          id: "c",
          title: "Next",
          startsAt: new Date(START + 30 * MINUTE).toISOString(),
          endsAt: new Date(START + 60 * MINUTE).toISOString(),
        }),
      ],
    });
    await run.at(START - REMIND_BEFORE_MS);
    expect(run.shown().map((card) => promptText(card.prompt).question)).toEqual(["Design review"]);
    run.shown()[0]!.done("dismissed");
    await run.at(START + MINUTE);
    expect(run.shown()).toHaveLength(0);
    await run.at(START + 29 * MINUTE);
    expect(run.shown().map((card) => promptText(card.prompt).question)).toEqual(["Next"]);
    expect(run.opened).toEqual([]);
    run.subject.shutdown();
  });

  test("a meeting long started, or cancelled while its card shows, isn't offered", async () => {
    const run = reminders();
    await run.at(START + JOIN_LATE_MS);
    expect(run.shown()).toHaveLength(0);
    const fresh = reminders();
    await fresh.at(START - 30_000);
    expect(fresh.shown()).toHaveLength(1);
    fresh.setBody({ calendar: "connected", meetings: [] });
    await fresh.at(START - 20_000);
    expect(fresh.cards.filter((card) => card.prompt.kind === "join")[0]!.closed).toBe(true);
    run.subject.shutdown();
    fresh.subject.shutdown();
  });

  test("a calendar that couldn't be read doesn't take a showing card for cancelled", async () => {
    const run = reminders();
    await run.at(START - 30_000);
    const card = run.shown()[0]!;
    run.setBody({ calendar: "connected", complete: false, meetings: [] });
    await run.at(START - 20_000);
    expect(card.closed).toBe(false);
    // A complete answer without it: cancelled.
    run.setBody({ calendar: "connected", complete: true, meetings: [] });
    await run.at(START - 10_000);
    expect(card.closed).toBe(true);
    run.subject.shutdown();
  });

  test("a calendar read that finishes after shutdown shows nothing", async () => {
    const run = reminders();
    // The first read is still on its way.
    run.subject.shutdown();
    await run.at(START - REMIND_BEFORE_MS);
    expect(run.cards).toHaveLength(0);
  });

  test("a recording's question to stop isn't covered by a reminder", async () => {
    const run = reminders();
    const page = new FakePage(1);
    run.subject.listen(page, true);
    await run.at(START - 20 * MINUTE);
    run.microphone([zoom], START - 20 * MINUTE);
    run.microphone([zoom], START - 20 * MINUTE + PROMPT_AFTER_MS);
    run.cards[0]!.done("chosen");
    run.subject.setRecording(page, true);
    run.microphone([], START - 2 * MINUTE);
    run.microphone([], START - 2 * MINUTE + ENDED_AFTER_MS);
    const stop = run.cards.find((card) => card.prompt.kind === "stop")!;
    expect(stop.closed).toBe(false);
    await run.at(START - REMIND_BEFORE_MS);
    expect(run.shown()).toHaveLength(0);
    expect(stop.closed).toBe(false);
    // Once it's answered, the reminder shows.
    stop.done("chosen");
    run.subject.setRecording(page, false);
    await run.at(START - 30_000);
    expect(run.shown().map((card) => promptText(card.prompt).action)).toEqual([
      "Join and start recording",
    ]);
    run.subject.shutdown();
  });

  test("without a calendar, a window coming to the front checks again, not too often", async () => {
    const run = reminders({ calendar: "none", meetings: [] });
    await run.settle();
    const reads = run.reads.length;
    run.subject.windowFocused();
    await run.settle();
    expect(run.reads).toHaveLength(reads);
    await run.at(START - 9 * MINUTE);
    const after = run.reads.length;
    run.subject.windowFocused();
    await run.settle();
    expect(run.reads).toHaveLength(after);
    // A while later, a focus reads again; once a calendar is connected, focus doesn't.
    run.setNow(START - 9 * MINUTE + RECHECK_CALENDAR_MS);
    run.setBody({ calendar: "connected", meetings: [] });
    run.subject.windowFocused();
    await run.settle();
    expect(run.reads).toHaveLength(after + 1);
    expect(run.subject.status()).toMatchObject({ calendar: "connected" });
    run.setNow(START - 8 * MINUTE);
    run.subject.windowFocused();
    await run.settle();
    expect(run.reads).toHaveLength(after + 1);
    run.subject.shutdown();
  });

  test("no calendar: no card, and the status says so", async () => {
    const run = reminders({ calendar: "none", meetings: [] });
    await run.at(START - REMIND_BEFORE_MS);
    expect(run.cards).toHaveLength(0);
    expect(run.subject.status()).toMatchObject({ calendarReminders: true, calendar: "none" });
    run.subject.shutdown();
  });

  test("turned off, the calendar isn't read and nothing shows", async () => {
    const run = reminders({ on: false });
    await run.at(START - REMIND_BEFORE_MS);
    expect(run.reads).toEqual([]);
    expect(run.cards).toHaveLength(0);
    expect(run.subject.update({ calendarReminders: true })).toMatchObject({
      calendarReminders: true,
    });
    await run.settle();
    expect(run.reads).toEqual(["account-a"]);
    expect(run.shown()).toHaveLength(1);
    run.subject.update({ calendarReminders: false });
    expect(run.cards.every((card) => card.closed)).toBe(true);
    run.subject.shutdown();
  });

  test("while an earlier meeting is recorded, joining switches recordings; one joined early isn't offered", async () => {
    const run = reminders();
    const page = new FakePage(1);
    run.subject.listen(page, true);
    await run.at(START - 40 * MINUTE);
    run.subject.setRecording(page, true);
    await run.at(START - REMIND_BEFORE_MS);
    const card = run.shown()[0]!;
    expect(promptText(card.prompt).action).toBe("Join and record this one");
    card.done("chosen");
    expect(page.sent.at(-1)).toMatchObject({ kind: "record", replace: true });

    const early = reminders();
    const earlyPage = new FakePage(2);
    early.subject.listen(earlyPage, true);
    await early.at(START - 3 * MINUTE);
    early.subject.setRecording(earlyPage, true);
    await early.at(START - REMIND_BEFORE_MS);
    expect(early.shown()).toHaveLength(0);
    run.subject.shutdown();
    early.subject.shutdown();
  });

  test("only the active account reminds: switching takes its card back and reads the new one", async () => {
    const run = reminders();
    const page = new FakePage(1);
    run.subject.listen(page, true);
    await run.at(START - REMIND_BEFORE_MS);
    const card = run.shown()[0]!;
    run.setActive("account-b");
    run.subject.accountChanged();
    expect(card.closed).toBe(true);
    await run.settle();
    expect(run.reads.at(-1)).toBe("account-b");
    // A choice that arrives for the account before is not carried out.
    card.done("chosen");
    expect(run.opened).toEqual([]);
    expect(page.sent).toEqual([]);
    // Signed out: nothing is read.
    run.setActive(null);
    run.subject.accountChanged();
    const reads = run.reads.length;
    await run.at(START);
    expect(run.reads).toHaveLength(reads);
    run.subject.shutdown();
  });

  test("a call that starts is asked about first; the reminder doesn't cover its question", async () => {
    const run = reminders();
    await run.at(START - 2 * MINUTE);
    run.microphone([zoom], START - 2 * MINUTE);
    run.microphone([zoom], START - 2 * MINUTE + PROMPT_AFTER_MS);
    expect(run.cards.map((card) => card.prompt.kind)).toEqual(["record"]);
    await run.at(START - REMIND_BEFORE_MS);
    expect(run.shown()).toHaveLength(0);
    // And a call's question takes a reminder's place, which then counts as offered.
    const other = reminders();
    await other.at(START - REMIND_BEFORE_MS);
    expect(other.shown()).toHaveLength(1);
    other.microphone([zoom], START - 50_000);
    other.microphone([zoom], START - 50_000 + PROMPT_AFTER_MS);
    expect(other.cards.map((card) => card.prompt.kind)).toEqual(["join", "record"]);
    expect(other.log).toContain("Meeting reminders: the reminder timed out.");
    other.cards[1]!.done("dismissed");
    await other.at(START);
    expect(other.cards.filter((card) => card.prompt.kind === "join")).toHaveLength(1);
    run.subject.shutdown();
    other.subject.shutdown();
  });
});
