// Reminders before calendar meetings: about a minute before a meeting on the
// signed-in person's own calendar starts, the card in the corner of the
// screen offers to join it and start its recording in one click, the way a
// meeting notes app does. Only the active account's calendar is read (from
// its server, `GET …/upcoming-meetings`), so only that account reminds, and
// the meeting is recorded there. Each meeting is offered once: choosing it,
// closing the card or letting it time out all end the offer, and a meeting
// already under way for a while is not offered at all.

import type { MeetingPromptOutcome, ShownPrompt } from "./index";

/** A meeting about to start on the person's calendar, with the link that joins it. */
export interface CalendarMeeting {
  id: string;
  provider: "google" | "microsoft";
  title: string;
  /** Private on the calendar: its title is shown on the person's own card only. */
  private: boolean;
  startsAt: number;
  endsAt: number;
  joinUrl: string;
  /** The service the link joins, e.g. "Google Meet". */
  service: string;
}

/** Whether the account has a calendar its server can read, and its meetings about to start. */
export interface UpcomingMeetings {
  calendar: "connected" | "none";
  /** False when a calendar couldn't be read: meetings may be missing, not cancelled. */
  complete: boolean;
  meetings: CalendarMeeting[];
}

/** The card shows this long before a meeting starts. */
export const REMIND_BEFORE_MS = 60_000;
/** A meeting that started this long ago is no longer offered, and its card goes away then. */
export const JOIN_LATE_MS = 5 * 60_000;
/** How often the calendar is read. */
export const POLL_MS = 5 * 60_000;
/** How often once a meeting is about to be offered, so a moved or cancelled one isn't. */
export const POLL_SOON_MS = 60_000;
/** A meeting is "about to be offered" when its card is due within this long. */
const SOON_MS = 3 * 60_000;
/** A recording started this long before a meeting's start is of that meeting, joined early. */
export const EARLY_JOIN_MS = 10 * 60_000;
/** Run about this often: the cards depend on the time. */
export const REMINDER_TICK_MS = 15_000;
/** The shortest a card stays up, however late it shows. */
const MIN_CARD_MS = 30_000;
/** Without a calendar, read again at most this often when a window comes to the front. */
export const RECHECK_CALENDAR_MS = 30_000;

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function time(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The server's answer as upcoming meetings, leniently; null when it isn't one. */
export function parseUpcomingMeetings(body: unknown): UpcomingMeetings | null {
  if (!body || typeof body !== "object") return null;
  const value = body as { calendar?: unknown; complete?: unknown; meetings?: unknown };
  if (value.calendar !== "connected" && value.calendar !== "none") return null;
  const meetings: CalendarMeeting[] = [];
  for (const entry of Array.isArray(value.meetings) ? value.meetings : []) {
    if (!entry || typeof entry !== "object") continue;
    const meeting = entry as Record<string, unknown>;
    const startsAt = time(meeting.startsAt);
    const endsAt = time(meeting.endsAt);
    if (
      typeof meeting.id !== "string" ||
      !meeting.id ||
      (meeting.provider !== "google" && meeting.provider !== "microsoft") ||
      startsAt === null ||
      endsAt === null ||
      !isHttpsUrl(meeting.joinUrl)
    ) {
      continue;
    }
    meetings.push({
      id: meeting.id,
      provider: meeting.provider,
      title: typeof meeting.title === "string" ? meeting.title.trim().slice(0, 300) : "",
      private: meeting.private === true,
      startsAt,
      endsAt,
      joinUrl: meeting.joinUrl,
      service:
        typeof meeting.service === "string" && meeting.service.trim()
          ? meeting.service.trim().slice(0, 60)
          : "Meeting",
    });
  }
  meetings.sort((a, b) => a.startsAt - b.startsAt);
  return { calendar: value.calendar, complete: value.complete !== false, meetings };
}

function key(accountId: string, meeting: CalendarMeeting): string {
  // A meeting moved to another time is a new offer.
  return `${accountId}|${meeting.provider}|${meeting.id}|${meeting.startsAt}`;
}

/** Whether `meeting`'s card is due at `now`: within a minute of its start, and not long started. */
export function reminderDue(meeting: CalendarMeeting, now: number): boolean {
  return (
    meeting.startsAt - now <= REMIND_BEFORE_MS &&
    now - meeting.startsAt < JOIN_LATE_MS &&
    now < meeting.endsAt
  );
}

/** A reminder on the card: the meeting, whose account it is, and whether it switches recordings. */
export interface JoinReminder {
  accountId: string;
  meeting: CalendarMeeting;
  /** A recording of an earlier meeting is going on: joining stops it and starts this one's. */
  replace: boolean;
  /** When the card showed, for "starts in 1 min". */
  shownAt: number;
  /** How long the card stays up: until a few minutes after the meeting started. */
  timeoutMs: number;
}

export interface CalendarReminderOptions {
  /** The active, signed-in account, or null. Only it is read and reminds. */
  account(): { id: string } | null;
  /** Its upcoming meetings from its server; null (or a throw) when they can't be read now. */
  upcoming(accountId: string): Promise<UpcomingMeetings | null>;
  /** Whether reminders are on and a page here can record. */
  enabled(): boolean;
  /** Since when the page has been recording a meeting, or null when it isn't. */
  recordingSince(): number | null;
  /** Another question is on the card that a reminder must not replace (a call just started). */
  busy(): boolean;
  /** Put a reminder on the card; `done` runs once when the person acts or it times out. */
  present(reminder: JoinReminder, done: (outcome: MeetingPromptOutcome) => void): ShownPrompt;
  /** The person chose to join: open the meeting and start its recording. */
  join(reminder: JoinReminder): void;
  /** Whether the active account has a calendar changed. */
  onCalendar?(calendar: "connected" | "none" | null): void;
  log(message: string, error?: unknown): void;
  now?: () => number;
}

/**
 * Reads the active account's calendar now and then, and shows one reminder
 * at a time for the meeting about to start. With several meetings at once,
 * the soonest (the server lists the one the person answered first at the
 * same start) is offered; once the person chooses, closes or lets it time
 * out, every meeting due then counts as offered.
 */
export class CalendarReminders {
  private timer: NodeJS.Timeout | null = null;
  private accountId: string | null = null;
  private upcoming: UpcomingMeetings | null = null;
  private fetchedAt = 0;
  private fetching: Promise<void> | null = null;
  /** Bumped when the account changes, so a read for the one before is ignored. */
  private generation = 0;
  private readonly offered = new Set<string>();
  private shown: { key: string; reminder: JoinReminder; handle: ShownPrompt } | null = null;

  constructor(private readonly options: CalendarReminderOptions) {}

  get running(): boolean {
    return this.timer !== null;
  }

  /** The active account's calendar, as last read: null before the first read. */
  calendar(): "connected" | "none" | null {
    return this.upcoming?.calendar ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), REMINDER_TICK_MS);
    this.timer.unref?.();
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // A read still on its way is for reminders that are off now.
    this.generation += 1;
    this.close();
  }

  /** Read the calendar at the next tick, e.g. after the computer wakes. */
  refresh(): void {
    this.fetchedAt = 0;
    if (this.timer) this.tick();
  }

  /**
   * The person may have just connected a calendar (an app window came to the
   * front): read again soon, while there is none, so settings stop offering it.
   */
  recheckCalendar(): void {
    if (this.upcoming?.calendar !== "none") return;
    if (this.now() - this.fetchedAt < RECHECK_CALENDAR_MS) return;
    this.refresh();
  }

  /** The active account may have changed: its card goes, and the new one's calendar is read. */
  accountChanged(): void {
    const id = this.options.account()?.id ?? null;
    if (id === this.accountId) return;
    this.generation += 1;
    this.accountId = id;
    this.upcoming = null;
    this.fetchedAt = 0;
    this.close();
    this.options.onCalendar?.(null);
    if (this.timer) this.tick();
  }

  /** Run about every {@link REMINDER_TICK_MS}: read the calendar when it's time, then decide. */
  tick(): void {
    const now = this.now();
    if (!this.options.enabled()) {
      this.close();
      return;
    }
    this.accountChanged();
    if (this.accountId && !this.fetching && now - this.fetchedAt >= this.pollInterval(now)) {
      void this.read(this.accountId);
    }
    this.evaluate(now);
  }

  /** Show, keep or take back the card for what the calendar says at `now`. */
  evaluate(now: number): void {
    const accountId = this.accountId;
    if (!this.timer || !this.options.enabled() || !accountId || !this.upcoming) {
      this.close();
      return;
    }
    const meetings = this.upcoming.meetings;
    if (this.shown) {
      // Cancelled or moved: its card goes.
      const still = meetings.some((meeting) => key(accountId, meeting) === this.shown?.key);
      if (!still) this.close();
      return;
    }
    if (this.options.busy()) return;
    const since = this.options.recordingSince();
    const due = meetings.filter(
      (meeting) =>
        reminderDue(meeting, now) &&
        !this.offered.has(key(accountId, meeting)) &&
        // Recording since just before it started: the person joined it early.
        !(since !== null && since >= meeting.startsAt - EARLY_JOIN_MS),
    );
    const meeting = due[0];
    if (!meeting) return;
    const reminder: JoinReminder = {
      accountId,
      meeting,
      replace: since !== null,
      shownAt: now,
      timeoutMs: Math.max(MIN_CARD_MS, meeting.startsAt + JOIN_LATE_MS - now),
    };
    const shownKey = key(accountId, meeting);
    this.options.log(`Meeting reminders: offered a meeting (${meeting.provider}).`);
    let open = true;
    const handle = this.options.present(reminder, (outcome) => {
      if (!open) return;
      open = false;
      if (this.shown?.key === shownKey) this.shown = null;
      // Every meeting due now was offered with it: "Not now" means not now.
      for (const other of this.upcoming?.meetings ?? []) {
        if (reminderDue(other, this.now())) this.remember(key(accountId, other));
      }
      this.remember(shownKey);
      this.options.log(`Meeting reminders: ${OUTCOMES[outcome]}.`);
      if (outcome === "chosen") {
        if (this.options.account()?.id !== accountId) {
          this.options.log("Meeting reminders: the account changed; not joining.");
          return;
        }
        this.options.join(reminder);
      }
    });
    this.shown = {
      key: shownKey,
      reminder,
      handle: {
        close: () => {
          if (!open) return;
          open = false;
          // Taken back (cancelled, account changed, turned off) is not offered again either.
          this.remember(shownKey);
          handle.close();
        },
      },
    };
  }

  /** The reminder on the card, if any. */
  showing(): JoinReminder | null {
    return this.shown?.reminder ?? null;
  }

  private pollInterval(now: number): number {
    const accountId = this.accountId;
    const soon = (this.upcoming?.meetings ?? []).some(
      (meeting) =>
        accountId !== null &&
        !this.offered.has(key(accountId, meeting)) &&
        meeting.startsAt - REMIND_BEFORE_MS - now <= SOON_MS &&
        now - meeting.startsAt < JOIN_LATE_MS,
    );
    return soon ? POLL_SOON_MS : POLL_MS;
  }

  private read(accountId: string): Promise<void> {
    const generation = this.generation;
    this.fetchedAt = this.now();
    this.fetching = (async () => {
      let upcoming: UpcomingMeetings | null = null;
      try {
        upcoming = await this.options.upcoming(accountId);
      } catch (error) {
        this.options.log("Meeting reminders: couldn't read the calendar.", error);
      }
      if (generation !== this.generation || upcoming === null) return;
      const before = this.upcoming?.calendar ?? null;
      // A calendar that couldn't be read now: meetings known before stay, so a
      // card already showing isn't taken for cancelled.
      const known = this.upcoming;
      if (!upcoming.complete && known) {
        const listed = new Set(upcoming.meetings.map((meeting) => key(accountId, meeting)));
        const kept = known.meetings.filter((meeting) => !listed.has(key(accountId, meeting)));
        upcoming = {
          ...upcoming,
          meetings: [...upcoming.meetings, ...kept].sort((a, b) => a.startsAt - b.startsAt),
        };
      }
      this.upcoming = upcoming;
      if (before !== upcoming.calendar) this.options.onCalendar?.(upcoming.calendar);
      this.evaluate(this.now());
    })().finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  private remember(offeredKey: string): void {
    this.offered.add(offeredKey);
    // Only today's matter; keep the set small.
    if (this.offered.size > 500) {
      const oldest = this.offered.values().next().value;
      if (oldest !== undefined) this.offered.delete(oldest);
    }
  }

  private close(): void {
    const shown = this.shown;
    this.shown = null;
    shown?.handle.close();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

const OUTCOMES: Record<MeetingPromptOutcome, string> = {
  chosen: "the person chose to join",
  dismissed: "the person closed the reminder",
  expired: "the reminder timed out",
};
