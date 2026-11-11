/**
 * How the ⌘K menu finds meetings: by title, by someone who spoke in them, by
 * words said in them (the server's search), and by roughly when they happened
 * ("yesterday", "friday", "30 oct", "last week"). English and Norwegian date
 * words both work, since meetings are often held in either.
 */
import { foldForSearch, LOOSE_MATCH_BELOW, rankLabel } from "./rank";
import type { MeetingRecord } from "./meeting-directory";

/** A stretch of time someone typed: from its start, up to but not including its end. */
export type MeetingDateRange = { from: Date; to: Date };

/** Sunday first, as `Date.getDay()` counts. */
const WEEKDAYS: readonly (readonly string[])[] = [
  ["sunday", "sun", "sondag", "son"],
  ["monday", "mon", "mandag", "man"],
  ["tuesday", "tue", "tues", "tirsdag", "tir"],
  ["wednesday", "wed", "onsdag", "ons"],
  ["thursday", "thu", "thur", "thurs", "torsdag", "tor"],
  ["friday", "fri", "fredag", "fre"],
  ["saturday", "sat", "lordag", "lor"],
];

const MONTHS: readonly (readonly string[])[] = [
  ["january", "jan", "januar"],
  ["february", "feb", "februar"],
  ["march", "mar", "mars"],
  ["april", "apr"],
  ["may", "mai"],
  ["june", "jun", "juni"],
  ["july", "jul", "juli"],
  ["august", "aug"],
  ["september", "sep", "sept"],
  ["october", "oct", "oktober", "okt"],
  ["november", "nov"],
  ["december", "dec", "desember", "des"],
];

/**
 * Month names that stand alone as a date. Abbreviations ("jan", "mar") only
 * count beside a day, since on their own they are often names or words.
 */
const FULL_MONTHS = new Set([
  "january",
  "januar",
  "february",
  "februar",
  "march",
  "mars",
  "april",
  "may",
  "mai",
  "june",
  "juni",
  "july",
  "juli",
  "august",
  "september",
  "october",
  "oktober",
  "november",
  "december",
  "desember",
]);

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function oneDay(day: Date): MeetingDateRange {
  return { from: day, to: addDays(day, 1) };
}

function weekday(word: string): number | null {
  const index = WEEKDAYS.findIndex((names) => names.includes(word));
  return index < 0 ? null : index;
}

function month(word: string): number | null {
  const cleaned = word.replace(/\.$/, "");
  const index = MONTHS.findIndex((names) => names.includes(cleaned));
  return index < 0 ? null : index;
}

/** A day of a month without a year: this year's, or last year's if that is still to come. */
function pastDate(today: Date, monthIndex: number, day: number, year?: number): Date | null {
  if (day < 1 || day > 31 || monthIndex < 0 || monthIndex > 11) return null;
  let date = new Date(year ?? today.getFullYear(), monthIndex, day);
  // 31 Feb and the like roll into the next month: not a date.
  if (date.getMonth() !== monthIndex) return null;
  if (year === undefined && date > today) date = new Date(today.getFullYear() - 1, monthIndex, day);
  return date;
}

function fullYear(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const value = Number(text);
  return text.length === 2 ? 2000 + value : value;
}

/** Monday-first weeks, as calendars in Norway and most of Europe count them. */
function startOfWeek(day: Date): Date {
  return addDays(day, -((day.getDay() + 6) % 7));
}

/**
 * The time a query names, when the whole query is a date: "today",
 * "yesterday", a weekday (the latest one, today included; "last friday" is the
 * one before today), "this week", "last week", a month ("october", the latest
 * one), a day of a month ("30 oct", "oct 30", "30. oktober", with or without
 * a year), "30.10", "30.10.2026" or "2026-10-30". Null otherwise.
 */
export function meetingDateRange(query: string, now: Date = new Date()): MeetingDateRange | null {
  const text = foldForSearch(query).replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const today = startOfDay(now);
  if (text === "today" || text === "i dag" || text === "idag") return oneDay(today);
  if (text === "yesterday" || text === "i gar" || text === "igar")
    return oneDay(addDays(today, -1));
  if (text === "this week" || text === "denne uken" || text === "denne uka") {
    return { from: startOfWeek(today), to: addDays(today, 1) };
  }
  if (text === "last week" || text === "forrige uke" || text === "sist uke") {
    const thisWeek = startOfWeek(today);
    return { from: addDays(thisWeek, -7), to: thisWeek };
  }
  const words = text.split(" ");
  // A weekday: "friday", "on friday", "last friday", "fredag", "forrige fredag", "pa fredag".
  const last = words[0] === "last" || words[0] === "forrige" || words[0] === "sist";
  const dayWords = words[0] === "on" || words[0] === "pa" || last ? words.slice(1) : words;
  // Bare abbreviations ("man", "tor", "sun") are ordinary words too; they need "last" or "on".
  if (dayWords.length === 1 && (dayWords !== words || dayWords[0]!.length >= 6)) {
    const day = weekday(dayWords[0]!);
    if (day !== null) {
      let back = (today.getDay() - day + 7) % 7;
      if (last && back === 0) back = 7;
      return oneDay(addDays(today, -back));
    }
  }
  // A month on its own: the latest one, this month included.
  if (words.length === 1 && FULL_MONTHS.has(words[0]!)) {
    const monthIndex = month(words[0]!);
    if (monthIndex !== null) {
      const year = monthIndex <= today.getMonth() ? today.getFullYear() : today.getFullYear() - 1;
      return { from: new Date(year, monthIndex, 1), to: new Date(year, monthIndex + 1, 1) };
    }
  }
  // 2026-10-30
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const date = pastDate(today, Number(iso[2]) - 1, Number(iso[3]), Number(iso[1]));
    return date ? oneDay(date) : null;
  }
  // 30.10, 30.10.2026, 30.10.26
  const dotted = /^(\d{1,2})\.(\d{1,2})\.?(\d{2}|\d{4})?$/.exec(text);
  if (dotted) {
    const date = pastDate(today, Number(dotted[2]) - 1, Number(dotted[1]), fullYear(dotted[3]));
    return date ? oneDay(date) : null;
  }
  // 30 oct, 30. oktober, 30 october 2026
  const dayFirst = /^(\d{1,2})\.? ([a-z]+\.?)(?: (\d{4}))?$/.exec(text);
  if (dayFirst) {
    const monthIndex = month(dayFirst[2]!);
    const date =
      monthIndex === null
        ? null
        : pastDate(today, monthIndex, Number(dayFirst[1]), fullYear(dayFirst[3]));
    return date ? oneDay(date) : null;
  }
  // oct 30, october 30 2026
  const monthFirst = /^([a-z]+\.?) (\d{1,2})(?: (\d{4}))?$/.exec(text);
  if (monthFirst) {
    const monthIndex = month(monthFirst[1]!);
    const date =
      monthIndex === null
        ? null
        : pastDate(today, monthIndex, Number(monthFirst[2]), fullYear(monthFirst[3]));
    return date ? oneDay(date) : null;
  }
  return null;
}

/** How the server found a meeting for the query. */
export type MeetingMatch = "words" | "person" | "date";

export type FoundMeeting = { meeting: MeetingRecord; match: MeetingMatch };

export type RankedMeeting = { meeting: MeetingRecord; rank: number; loose: boolean };

/**
 * Someone who spoke in it, by name: a deliberate match, ahead of a date the
 * same word could name ("August", "May").
 */
const PERSON_RANK = 850;
/** A date the query names outranks the title words it happens to share. */
const DATE_RANK = 800;
/** Every word found in its title or transcript, but not as a title match here. */
const WORDS_RANK = 450;

/**
 * Ranks meetings for a query. `known` are the newest meetings the menu already
 * holds (their titles match at once); `found` are the server's answers, each
 * with how it matched. A meeting keeps its best reason, and newer meetings win
 * ties.
 */
export function rankMeetings(
  known: readonly MeetingRecord[],
  found: readonly FoundMeeting[],
  query: string,
  range: MeetingDateRange | null,
): RankedMeeting[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const best = new Map<string, RankedMeeting>();
  const consider = (meeting: MeetingRecord, rank: number | null, loose = false) => {
    if (rank === null) return;
    const current = best.get(meeting.id);
    if (!current || rank > current.rank) best.set(meeting.id, { meeting, rank, loose });
  };
  const inRange = (meeting: MeetingRecord) =>
    range !== null &&
    meeting.startedAt >= range.from.getTime() &&
    meeting.startedAt < range.to.getTime();
  for (const meeting of [...known, ...found.map((entry) => entry.meeting)]) {
    const rank = rankLabel(meeting.title, trimmed);
    consider(meeting, rank, rank !== null && rank < LOOSE_MATCH_BELOW);
    if (inRange(meeting)) consider(meeting, DATE_RANK);
  }
  for (const { meeting, match } of found) {
    consider(
      meeting,
      match === "date"
        ? inRange(meeting)
          ? DATE_RANK
          : null
        : match === "person"
          ? PERSON_RANK
          : WORDS_RANK,
    );
  }
  return [...best.values()].sort(
    (a, b) => b.rank - a.rank || b.meeting.startedAt - a.meeting.startedAt,
  );
}

/** Meetings for the empty menu: the newest ones, without the one on screen. */
export function recentMeetings(
  known: readonly MeetingRecord[],
  currentMeetingId: string | null,
  limit: number,
): MeetingRecord[] {
  return known.filter((meeting) => meeting.id !== currentMeetingId).slice(0, limit);
}
