import { describe, expect, test } from "bun:test";
import type { ConnectionMetadataWithVerification } from "@opengeni/db";
import {
  googleCalendarEvents,
  graphCalendarEvents,
  meetingCalendarConnections,
  meetingCalendarTitle,
  meetingEventAt,
  type MeetingCalendarEvent,
  type MeetingCalendarLookup,
} from "../src/meeting-calendar-title";

const at = new Date("2026-10-30T13:02:00Z");
const owner = "user:owner";

function event(overrides: Partial<MeetingCalendarEvent> = {}): MeetingCalendarEvent {
  return {
    title: "Acme renewal",
    start: new Date("2026-10-30T13:00:00Z"),
    end: new Date("2026-10-30T13:30:00Z"),
    meeting: true,
    private: false,
    declined: false,
    ...overrides,
  };
}

function connection(
  overrides: Partial<ConnectionMetadataWithVerification> = {},
): ConnectionMetadataWithVerification {
  return {
    id: crypto.randomUUID(),
    subjectId: owner,
    providerDomain: "calendarmcp.googleapis.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: [],
    ...overrides,
  } as ConnectionMetadataWithVerification;
}

describe("the calendar event a meeting is of", () => {
  test("the event under way when recording started", () => {
    expect(meetingEventAt([event()], at)?.title).toBe("Acme renewal");
  });

  test("an event about to start, when recording began early", () => {
    const soon = event({
      title: "Board prep",
      start: new Date("2026-10-30T13:10:00Z"),
      end: new Date("2026-10-30T14:00:00Z"),
    });
    expect(meetingEventAt([soon], at)?.title).toBe("Board prep");
  });

  test("the nearest start wins over a long block and over the previous one running over", () => {
    const block = event({
      title: "Offsite",
      start: new Date("2026-10-30T09:00:00Z"),
      end: new Date("2026-10-30T17:00:00Z"),
    });
    const previous = event({
      title: "Standup",
      start: new Date("2026-10-30T12:45:00Z"),
      end: new Date("2026-10-30T13:02:30Z"),
    });
    expect(meetingEventAt([block, previous, event()], at)?.title).toBe("Acme renewal");
    // The standup ends within a minute of the start: it is the one running over.
    expect(meetingEventAt([previous], at)).toBeNull();
  });

  test("never a private, declined, all-day or later event, or a blank one", () => {
    expect(meetingEventAt([event({ private: true })], at)).toBeNull();
    expect(meetingEventAt([event({ declined: true })], at)).toBeNull();
    expect(meetingEventAt([event({ meeting: false })], at)).toBeNull();
    expect(meetingEventAt([event({ title: "  \n " })], at)).toBeNull();
    expect(
      meetingEventAt(
        [
          event({
            start: new Date("2026-10-30T13:20:00Z"),
            end: new Date("2026-10-30T14:00:00Z"),
          }),
        ],
        at,
      ),
    ).toBeNull();
  });
});

describe("reading providers' events", () => {
  test("Google Calendar items", () => {
    const events = googleCalendarEvents({
      items: [
        {
          summary: "Acme renewal",
          start: { dateTime: "2026-10-30T14:00:00+01:00" },
          end: { dateTime: "2026-10-30T14:30:00+01:00" },
          attendees: [{ self: true, responseStatus: "accepted" }],
        },
        { summary: "Holiday", start: { date: "2026-10-30" }, end: { date: "2026-10-31" } },
        {
          summary: "Focus",
          eventType: "focusTime",
          start: { dateTime: "2026-10-30T13:00:00Z" },
          end: { dateTime: "2026-10-30T14:00:00Z" },
        },
        {
          summary: "Therapist",
          visibility: "private",
          start: { dateTime: "2026-10-30T13:00:00Z" },
          end: { dateTime: "2026-10-30T14:00:00Z" },
        },
        {
          summary: "Skipped",
          start: { dateTime: "2026-10-30T13:00:00Z" },
          end: { dateTime: "2026-10-30T14:00:00Z" },
          attendees: [{ self: true, responseStatus: "declined" }],
        },
        { start: { dateTime: "2026-10-30T13:00:00Z" } },
      ],
    });
    expect(events.map((item) => [item.title, item.meeting, item.private, item.declined])).toEqual([
      ["Acme renewal", true, false, false],
      ["Holiday", false, false, false],
      ["Focus", false, false, false],
      ["Therapist", true, true, false],
      ["Skipped", true, false, true],
    ]);
    expect(events[0]!.start.toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(googleCalendarEvents({ error: "nope" })).toEqual([]);
  });

  test("Microsoft Graph calendarView values, in UTC", () => {
    const events = graphCalendarEvents({
      value: [
        {
          subject: "Quarterly review",
          start: { dateTime: "2026-10-30T13:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-10-30T14:00:00.0000000", timeZone: "UTC" },
          responseStatus: { response: "accepted" },
        },
        {
          subject: "Out",
          showAs: "oof",
          start: { dateTime: "2026-10-30T13:00:00" },
          end: { dateTime: "2026-10-30T14:00:00" },
        },
        {
          subject: "HR",
          sensitivity: "confidential",
          start: { dateTime: "2026-10-30T13:00:00" },
          end: { dateTime: "2026-10-30T14:00:00" },
        },
      ],
    });
    expect(events[0]!.start.toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(events.map((item) => [item.title, item.meeting, item.private])).toEqual([
      ["Quarterly review", true, false],
      ["Out", false, false],
      ["HR", true, true],
    ]);
  });
});

describe("which connections are asked", () => {
  test("only the owner's own active calendar grants", () => {
    const google = connection();
    const graph = connection({
      providerDomain: "graph.microsoft.com",
      grantedScopes: ["Calendars.ReadWrite", "offline_access"],
    });
    const mailOnly = connection({
      providerDomain: "graph.microsoft.com",
      grantedScopes: ["Mail.Read"],
    });
    const shared = connection({ subjectId: null });
    const someoneElses = connection({ subjectId: "user:other" });
    const broken = connection({ status: "needs_reauth" } as never);
    const all = [google, graph, mailOnly, shared, someoneElses, broken];
    expect(
      meetingCalendarConnections(all, { subjectId: owner, googleCalendarEnabled: true }).map(
        (item) => item.id,
      ),
    ).toEqual([google.id, graph.id]);
    expect(
      meetingCalendarConnections(all, { subjectId: owner, googleCalendarEnabled: false }).map(
        (item) => item.id,
      ),
    ).toEqual([graph.id]);
  });
});

describe("the lookup", () => {
  const googleBody = {
    items: [
      {
        summary: "Acme renewal",
        start: { dateTime: "2026-10-30T13:00:00Z" },
        end: { dateTime: "2026-10-30T13:30:00Z" },
      },
    ],
  };

  function lookup(overrides: Partial<MeetingCalendarLookup> = {}) {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const value: MeetingCalendarLookup = {
      listConnections: async () => [connection()],
      credentialHeaders: async () => ({ Authorization: "Bearer calendar-token" }),
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, headers: init.headers as Record<string, string> });
        return Response.json(googleBody);
      }) as unknown as typeof fetch,
      googleCalendarEnabled: true,
      ...overrides,
    };
    return { value, requests };
  }

  test("names the meeting after the event, asking only for the minutes around its start", async () => {
    const { value, requests } = lookup();
    expect(await meetingCalendarTitle(value, { subjectId: owner, at })).toBe("Acme renewal");
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!.url);
    expect(url.origin + url.pathname).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    );
    expect(url.searchParams.get("timeMin")).toBe("2026-10-30T13:03:00.000Z");
    expect(url.searchParams.get("timeMax")).toBe("2026-10-30T13:12:00.000Z");
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(requests[0]!.headers.Authorization).toBe("Bearer calendar-token");
  });

  test("no calendar, an unusable credential or a provider error leaves no name", async () => {
    expect(
      await meetingCalendarTitle(lookup({ listConnections: async () => [] }).value, {
        subjectId: owner,
        at,
      }),
    ).toBeNull();
    expect(
      await meetingCalendarTitle(lookup({ credentialHeaders: async () => null }).value, {
        subjectId: owner,
        at,
      }),
    ).toBeNull();
    expect(
      await meetingCalendarTitle(
        lookup({
          fetch: (async () => new Response("no", { status: 403 })) as unknown as typeof fetch,
        }).value,
        { subjectId: owner, at },
      ),
    ).toBeNull();
    expect(
      await meetingCalendarTitle(
        lookup({
          listConnections: async () => {
            throw new Error("database down");
          },
        }).value,
        { subjectId: owner, at },
      ),
    ).toBeNull();
  });

  test("a slow calendar never holds the recording up", async () => {
    const started = Date.now();
    const title = await meetingCalendarTitle(
      lookup({
        timeoutMs: 50,
        fetch: ((_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })) as unknown as typeof fetch,
      }).value,
      { subjectId: owner, at },
    );
    expect(title).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("both calendars are asked, and the nearest event wins", async () => {
    const graph = connection({
      providerDomain: "graph.microsoft.com",
      grantedScopes: ["Calendars.Read"],
    });
    const { value, requests } = lookup({
      listConnections: async () => [connection(), graph],
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, headers: init.headers as Record<string, string> });
        return url.startsWith("https://graph.microsoft.com/")
          ? Response.json({
              value: [
                {
                  subject: "Pricing sync",
                  start: { dateTime: "2026-10-30T13:01:00.0000000" },
                  end: { dateTime: "2026-10-30T13:30:00.0000000" },
                },
              ],
            })
          : Response.json(googleBody);
      }) as unknown as typeof fetch,
    });
    expect(await meetingCalendarTitle(value, { subjectId: owner, at })).toBe("Pricing sync");
    const graphRequest = requests.find((request) => request.url.includes("graph.microsoft.com"))!;
    expect(new URL(graphRequest.url).pathname).toBe("/v1.0/me/calendarView");
    expect(graphRequest.headers.Prefer).toBe('outlook.timezone="UTC"');
  });
});
