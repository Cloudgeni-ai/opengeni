import { expect, test } from "bun:test";
import type { MeetingRecord } from "./meeting-directory";
import { meetingDateRange, rankMeetings, recentMeetings } from "./meeting-search";

// Monday 2 November 2026, 10:00 local time.
const now = new Date(2026, 10, 2, 10, 0);

function day(year: number, month: number, date: number): Date {
  return new Date(year, month - 1, date);
}

function expectRange(query: string, from: Date, to: Date) {
  const range = meetingDateRange(query, now);
  expect(range, query).not.toBeNull();
  expect(range!.from.getTime(), `${query} from`).toBe(from.getTime());
  expect(range!.to.getTime(), `${query} to`).toBe(to.getTime());
}

test("today and yesterday, in English and Norwegian", () => {
  expectRange("today", day(2026, 11, 2), day(2026, 11, 3));
  expectRange("Yesterday", day(2026, 11, 1), day(2026, 11, 2));
  expectRange("i går", day(2026, 11, 1), day(2026, 11, 2));
  expectRange("i dag", day(2026, 11, 2), day(2026, 11, 3));
});

test("a weekday is the latest one, today included; last means before today", () => {
  expectRange("friday", day(2026, 10, 30), day(2026, 10, 31));
  expectRange("fredag", day(2026, 10, 30), day(2026, 10, 31));
  expectRange("monday", day(2026, 11, 2), day(2026, 11, 3));
  expectRange("last monday", day(2026, 10, 26), day(2026, 10, 27));
  expectRange("forrige mandag", day(2026, 10, 26), day(2026, 10, 27));
  expectRange("on fri", day(2026, 10, 30), day(2026, 10, 31));
});

test("bare abbreviations and names are not dates", () => {
  for (const query of ["man", "tor", "sun", "jan", "mar", "dec", "halvor", "budget review"]) {
    expect(meetingDateRange(query, now), query).toBeNull();
  }
});

test("weeks start on Monday", () => {
  expectRange("this week", day(2026, 11, 2), day(2026, 11, 3));
  expectRange("last week", day(2026, 10, 26), day(2026, 11, 2));
  expectRange("forrige uke", day(2026, 10, 26), day(2026, 11, 2));
});

test("a month on its own is the latest one", () => {
  expectRange("october", day(2026, 10, 1), day(2026, 11, 1));
  expectRange("november", day(2026, 11, 1), day(2026, 12, 1));
  expectRange("desember", day(2025, 12, 1), day(2026, 1, 1));
});

test("a day of a month, in the past unless a year says otherwise", () => {
  expectRange("30 oct", day(2026, 10, 30), day(2026, 10, 31));
  expectRange("Oct 30", day(2026, 10, 30), day(2026, 10, 31));
  expectRange("30. oktober", day(2026, 10, 30), day(2026, 10, 31));
  expectRange("30.10", day(2026, 10, 30), day(2026, 10, 31));
  expectRange("30.10.2026", day(2026, 10, 30), day(2026, 10, 31));
  expectRange("2026-10-30", day(2026, 10, 30), day(2026, 10, 31));
  // Still to come this year, so last year's.
  expectRange("24 dec", day(2025, 12, 24), day(2025, 12, 25));
  expectRange("24 dec 2026", day(2026, 12, 24), day(2026, 12, 25));
  expect(meetingDateRange("31 feb", now)).toBeNull();
  expect(meetingDateRange("40.10", now)).toBeNull();
});

function meeting(id: string, title: string, started: Date): MeetingRecord {
  return { id, workspaceId: "w", title, startedAt: started.getTime() };
}

test("ranks a speaker's meetings above a date the same word names, and both above transcript words", () => {
  const august = meeting("a", "Weekly sync", day(2026, 8, 12));
  const said = meeting("b", "Planning", day(2026, 10, 1));
  const named = meeting("c", "Call with August", day(2026, 10, 20));
  const ranked = rankMeetings(
    [named],
    [
      { meeting: said, match: "words" },
      { meeting: august, match: "person" },
    ],
    "august",
    meetingDateRange("august", now),
  );
  expect(ranked.map((entry) => entry.meeting.id)).toEqual(["a", "c", "b"]);
});

test("a date query finds known meetings from that day without asking the server", () => {
  const friday = meeting("f", "Meeting, 30 Oct, 14:05", day(2026, 10, 30));
  const monday = meeting("m", "Standup", day(2026, 11, 2));
  const ranked = rankMeetings([monday, friday], [], "friday", meetingDateRange("friday", now));
  expect(ranked.map((entry) => entry.meeting.id)).toEqual(["f"]);
});

test("a server date answer outside the range doesn't count as a date match", () => {
  const other = meeting("o", "Retro", day(2026, 9, 1));
  expect(rankMeetings([], [{ meeting: other, match: "date" }], "friday", null)).toEqual([]);
});

test("recent meetings leave out the one on screen", () => {
  const list = [meeting("1", "A", now), meeting("2", "B", now), meeting("3", "C", now)];
  expect(recentMeetings(list, "2", 2).map((entry) => entry.id)).toEqual(["1", "3"]);
});
