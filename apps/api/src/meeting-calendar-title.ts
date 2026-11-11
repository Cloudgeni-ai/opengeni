// A meeting started without a name is named after the event on its owner's
// own connected calendar at the time it started (docs/recordings.md, "Names").
// Google Calendar (personal connection, through the reviewed Calendar REST
// routes) and Outlook Calendar (Microsoft Graph, when connected with a
// calendar scope) are asked at once. It never holds up a recording: every
// failure, a slow provider or no calendar at all leaves the date name, and
// the conversation names the meeting later.
import type { Settings } from "@opengeni/config";
import { firstMeetingJoinLink } from "./meeting-join-links";
import {
  buildConnectionTokenResolver,
  listConnectionsMetadata,
  type ConnectionMetadataWithVerification,
  type Database,
} from "@opengeni/db";

export const GOOGLE_CALENDAR_PROVIDER_DOMAIN = "calendarmcp.googleapis.com";
export const MICROSOFT_GRAPH_PROVIDER_DOMAIN = "graph.microsoft.com";
const GOOGLE_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GRAPH_CALENDAR_VIEW_URL = "https://graph.microsoft.com/v1.0/me/calendarView";
const MICROSOFT_CALENDAR_SCOPES = new Set(["calendars.read", "calendars.readwrite"]);

/** How long the lookup may take in all; a recording is created regardless. */
export const MEETING_CALENDAR_LOOKUP_TIMEOUT_MS = 3_000;
/** An event that starts this soon after recording began is the meeting being joined early. */
const STARTS_SOON_MS = 10 * 60_000;
/** An event that ends this soon after recording began is the previous one running over. */
const ENDS_SOON_MS = 60_000;

/** The calendars events are read from. */
export type MeetingCalendarProvider = "google" | "microsoft";

/** One calendar event, as much of it as naming or joining a meeting needs. */
export type MeetingCalendarEvent = {
  /** The provider's id for the event (one occurrence of a recurring one). */
  id?: string;
  provider?: MeetingCalendarProvider;
  title: string;
  start: Date;
  end: Date;
  /** All-day events, out of office, focus time and working location are not meetings. */
  meeting: boolean;
  /** Private, personal or confidential: its name must not reach a meeting others may see. */
  private: boolean;
  /** The owner declined it, or it was cancelled. */
  declined: boolean;
  /**
   * The owner hasn't answered the invitation. Such an event still names a
   * meeting, but one they accepted or organized comes first: an unanswered
   * one may be an invitation nobody expected.
   */
  unanswered?: boolean;
  /** The link that joins its call, when it has one. */
  joinUrl?: string;
  /** The service that link joins, e.g. "Google Meet". */
  service?: string;
};

/** A calendar event named by its provider and id, such as the one a recording was started for. */
export type MeetingCalendarEventRef = { provider: MeetingCalendarProvider; id: string };

function nameable(event: MeetingCalendarEvent): boolean {
  return (
    event.meeting &&
    !event.private &&
    !event.declined &&
    calendarTitle(event.title) !== null &&
    event.end.getTime() > event.start.getTime()
  );
}

/**
 * The event a recording that started at `at` is most likely of: the one it
 * was started for, when given and still on the calendar; else one under way
 * or about to start; one the owner answered first, then the one whose start
 * is nearest, then the shorter. Null when none fits.
 */
export function meetingEventAt(
  events: readonly MeetingCalendarEvent[],
  at: Date,
  chosen?: MeetingCalendarEventRef,
): MeetingCalendarEvent | null {
  if (chosen) {
    // The person chose this meeting: its own name or none, never another event's.
    const found = events.find(
      (event) => event.id === chosen.id && event.provider === chosen.provider,
    );
    if (found) return nameable(found) ? found : null;
  }
  const time = at.getTime();
  const fitting = events.filter(
    (event) =>
      nameable(event) &&
      event.start.getTime() <= time + STARTS_SOON_MS &&
      event.end.getTime() > time + ENDS_SOON_MS,
  );
  fitting.sort(
    (a, b) =>
      Number(a.unanswered === true) - Number(b.unanswered === true) ||
      Math.abs(a.start.getTime() - time) - Math.abs(b.start.getTime() - time) ||
      a.end.getTime() - a.start.getTime() - (b.end.getTime() - b.start.getTime()),
  );
  return fitting[0] ?? null;
}

/** An event's title as a meeting name: one line, at most 300 characters. Null when blank. */
export function calendarTitle(title: string): string | null {
  const text = title.replace(/\s+/gu, " ").trim().slice(0, 300).trim();
  return text.length > 0 ? text : null;
}

type GoogleEvent = {
  id?: unknown;
  summary?: unknown;
  hangoutLink?: unknown;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: unknown; uri?: unknown }> };
  location?: unknown;
  description?: unknown;
  status?: unknown;
  visibility?: unknown;
  eventType?: unknown;
  start?: { dateTime?: unknown; date?: unknown };
  end?: { dateTime?: unknown; date?: unknown };
  attendees?: Array<{ self?: unknown; responseStatus?: unknown }>;
};

/** Google Calendar `events.list` items as calendar events; malformed ones are left out. */
export function googleCalendarEvents(body: unknown): MeetingCalendarEvent[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: GoogleEvent) => {
    const start = typeof item?.start?.dateTime === "string" ? new Date(item.start.dateTime) : null;
    const end = typeof item?.end?.dateTime === "string" ? new Date(item.end.dateTime) : null;
    const allDay = typeof item?.start?.date === "string";
    if (typeof item?.summary !== "string") return [];
    if (!allDay && (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())))
      return [];
    const eventType = typeof item.eventType === "string" ? item.eventType : "default";
    const self = Array.isArray(item.attendees)
      ? item.attendees.find((attendee) => attendee?.self === true)
      : undefined;
    const video = Array.isArray(item.conferenceData?.entryPoints)
      ? item.conferenceData.entryPoints
          .filter((entry) => entry?.entryPointType === "video")
          .map((entry) => entry.uri)
      : [];
    const join = firstMeetingJoinLink(
      [item.hangoutLink, ...video],
      [item.location, item.description],
    );
    return [
      {
        ...(typeof item.id === "string" && item.id ? { id: item.id } : {}),
        provider: "google" as const,
        title: item.summary,
        start: start ?? new Date(0),
        end: end ?? new Date(0),
        meeting: !allDay && (eventType === "default" || eventType === "fromGmail"),
        private: item.visibility === "private" || item.visibility === "confidential",
        declined: item.status === "cancelled" || self?.responseStatus === "declined",
        unanswered: self?.responseStatus === "needsAction",
        ...(join ? { joinUrl: join.url, service: join.service } : {}),
      },
    ];
  });
}

type GraphEvent = {
  id?: unknown;
  subject?: unknown;
  onlineMeeting?: { joinUrl?: unknown } | null;
  onlineMeetingUrl?: unknown;
  location?: { displayName?: unknown; locationUri?: unknown } | null;
  body?: { content?: unknown } | null;
  isAllDay?: unknown;
  isCancelled?: unknown;
  sensitivity?: unknown;
  showAs?: unknown;
  start?: { dateTime?: unknown; timeZone?: unknown };
  end?: { dateTime?: unknown; timeZone?: unknown };
  responseStatus?: { response?: unknown };
};

/** Graph's dateTime has no offset; it is in UTC, as the lookup asks. */
function graphTime(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const time = new Date(/[zZ]|[+-]\d{2}:\d{2}$/u.test(value) ? value : `${value}Z`);
  return Number.isNaN(time.getTime()) ? null : time;
}

/** Microsoft Graph `calendarView` values as calendar events; malformed ones are left out. */
export function graphCalendarEvents(body: unknown): MeetingCalendarEvent[] {
  const values = (body as { value?: unknown } | null)?.value;
  if (!Array.isArray(values)) return [];
  return values.flatMap((item: GraphEvent) => {
    const start = graphTime(item?.start?.dateTime);
    const end = graphTime(item?.end?.dateTime);
    if (typeof item?.subject !== "string" || !start || !end) return [];
    const join = firstMeetingJoinLink(
      [item.onlineMeeting?.joinUrl, item.onlineMeetingUrl, item.location?.locationUri],
      [item.location?.displayName, item.body?.content],
    );
    return [
      {
        ...(typeof item.id === "string" && item.id ? { id: item.id } : {}),
        provider: "microsoft" as const,
        title: item.subject,
        start,
        end,
        meeting:
          item.isAllDay !== true && item.showAs !== "oof" && item.showAs !== "workingElsewhere",
        private:
          item.sensitivity === "private" ||
          item.sensitivity === "personal" ||
          item.sensitivity === "confidential",
        declined: item.isCancelled === true || item.responseStatus?.response === "declined",
        unanswered: item.responseStatus?.response === "notResponded",
        ...(join ? { joinUrl: join.url, service: join.service } : {}),
      },
    ];
  });
}

/** The owner's own calendar connections this deployment can read events from. */
export function meetingCalendarConnections(
  connections: readonly ConnectionMetadataWithVerification[],
  input: { subjectId: string; googleCalendarEnabled: boolean },
): ConnectionMetadataWithVerification[] {
  return connections.filter((connection) => {
    if (connection.subjectId !== input.subjectId) return false;
    if (connection.status !== "active" || connection.kind !== "oauth2") return false;
    const domain = connection.providerDomain.toLowerCase();
    if (domain === GOOGLE_CALENDAR_PROVIDER_DOMAIN) return input.googleCalendarEnabled;
    if (domain === MICROSOFT_GRAPH_PROVIDER_DOMAIN) {
      // Scopes may be stored short ("Calendars.Read") or as a URL.
      return connection.grantedScopes.some((scope) =>
        MICROSOFT_CALENDAR_SCOPES.has(
          scope.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//u, ""),
        ),
      );
    }
    return false;
  });
}

export type MeetingCalendarLookup = {
  /** The owner's connections, personal and shared, visible in this workspace. */
  listConnections: () => Promise<ConnectionMetadataWithVerification[]>;
  /** Authorization headers for one connection at one URL; null when it can't be used now. */
  credentialHeaders: (
    connection: ConnectionMetadataWithVerification,
    url: string,
  ) => Promise<Record<string, string> | null>;
  fetch: typeof fetch;
  googleCalendarEnabled: boolean;
  timeoutMs?: number;
  /**
   * Why a calendar couldn't be read, such as an HTTP status, so "why wasn't
   * it named?" can be answered. Never carries a credential or an event.
   */
  onProblem?: (problem: { providerDomain: string; reason: string }) => void;
};

const GOOGLE_FIELDS =
  "items(id,summary,status,visibility,eventType,start,end,attendees(self,responseStatus))";
/** With what joining needs: the call's link, wherever the event keeps it. */
const GOOGLE_JOIN_FIELDS =
  "items(id,summary,status,visibility,eventType,start,end,attendees(self,responseStatus)," +
  "hangoutLink,conferenceData(entryPoints(entryPointType,uri)),location,description)";
const GRAPH_SELECT = "id,subject,isAllDay,isCancelled,sensitivity,showAs,start,end,responseStatus";
const GRAPH_JOIN_SELECT = `${GRAPH_SELECT},onlineMeeting,onlineMeetingUrl,location,body`;

/** The events that end after `from` and start before `to`, with join links when `join`. */
function eventsRequest(
  connection: ConnectionMetadataWithVerification,
  window: { from: Date; to: Date; join: boolean },
) {
  const from = window.from.toISOString();
  const to = window.to.toISOString();
  if (connection.providerDomain.toLowerCase() === GOOGLE_CALENDAR_PROVIDER_DOMAIN) {
    const url = new URL(GOOGLE_EVENTS_URL);
    url.searchParams.set("timeMin", from);
    url.searchParams.set("timeMax", to);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("maxResults", "25");
    url.searchParams.set("fields", window.join ? GOOGLE_JOIN_FIELDS : GOOGLE_FIELDS);
    return { url: url.toString(), headers: {}, parse: googleCalendarEvents };
  }
  const url = new URL(GRAPH_CALENDAR_VIEW_URL);
  url.searchParams.set("startDateTime", from);
  url.searchParams.set("endDateTime", to);
  url.searchParams.set("$top", "25");
  url.searchParams.set("$select", window.join ? GRAPH_JOIN_SELECT : GRAPH_SELECT);
  return {
    url: url.toString(),
    // The body as text, where a join link written into the invitation is found.
    headers: {
      Prefer: window.join
        ? 'outlook.timezone="UTC", outlook.body-content-type="text"'
        : 'outlook.timezone="UTC"',
    },
    parse: graphCalendarEvents,
  };
}

/**
 * The events between `from` and `to` on every calendar of the owner's this
 * deployment can read, and whether they have one at all. A calendar that
 * fails or answers too late adds no events and makes the read incomplete;
 * `null` once the time is up.
 */
async function readMeetingCalendars(
  lookup: MeetingCalendarLookup,
  input: { subjectId: string; from: Date; to: Date; join: boolean },
): Promise<{ connected: boolean; complete: boolean; events: MeetingCalendarEvent[] } | null> {
  const timeout = AbortSignal.timeout(lookup.timeoutMs ?? MEETING_CALENDAR_LOOKUP_TIMEOUT_MS);
  let settled = false;
  const problem = (providerDomain: string, reason: string) => {
    if (settled) return;
    try {
      lookup.onProblem?.({ providerDomain, reason });
    } catch {
      // Reporting never changes the outcome.
    }
  };
  const read = async () => {
    const connections = meetingCalendarConnections(await lookup.listConnections(), {
      subjectId: input.subjectId,
      googleCalendarEnabled: lookup.googleCalendarEnabled,
    });
    if (connections.length === 0) return { connected: false, complete: true, events: [] };
    let complete = true;
    const found = await Promise.all(
      connections.map(async (connection) => {
        try {
          const request = eventsRequest(connection, input);
          const credential = await lookup.credentialHeaders(connection, request.url);
          if (!credential) {
            complete = false;
            problem(connection.providerDomain, "credential unavailable");
            return [];
          }
          if (timeout.aborted) {
            complete = false;
            return [];
          }
          const response = await lookup.fetch(request.url, {
            headers: { ...credential, ...request.headers, Accept: "application/json" },
            redirect: "error",
            signal: timeout,
          });
          if (!response.ok) {
            complete = false;
            problem(connection.providerDomain, `HTTP ${response.status}`);
            return [];
          }
          return request.parse(await response.json());
        } catch (error) {
          complete = false;
          // A lookup cut off by the time limit is reported once, below.
          if (!timeout.aborted) {
            problem(connection.providerDomain, error instanceof Error ? error.name : "failed");
          }
          return [];
        }
      }),
    );
    return { connected: true, complete, events: found.flat() };
  };
  const expired = new Promise<null>((resolve) => {
    timeout.addEventListener(
      "abort",
      () => {
        problem("*", "timed out");
        resolve(null);
      },
      { once: true },
    );
  });
  try {
    return await Promise.race([read(), expired]);
  } catch (error) {
    problem("*", error instanceof Error ? error.name : "failed");
    return null;
  } finally {
    settled = true;
  }
}

/**
 * The name of the owner's calendar event at `at`, from every calendar of
 * theirs this deployment can read: `event` when the recording was started
 * for it, else the one at that time. Null when there is none, or on any
 * failure or once the time is up.
 */
export async function meetingCalendarTitle(
  lookup: MeetingCalendarLookup,
  input: { subjectId: string; at: Date; event?: MeetingCalendarEventRef },
): Promise<string | null> {
  const read = await readMeetingCalendars(lookup, {
    subjectId: input.subjectId,
    from: new Date(input.at.getTime() + ENDS_SOON_MS),
    to: new Date(input.at.getTime() + STARTS_SOON_MS),
    join: false,
  });
  const event = read ? meetingEventAt(read.events, input.at, input.event) : null;
  return event ? calendarTitle(event.title) : null;
}

/** How far ahead the upcoming meetings are read. */
export const UPCOMING_MEETINGS_AHEAD_MS = 20 * 60_000;
/** A meeting that started at most this long ago may still be joined. */
export const UPCOMING_MEETINGS_STARTED_MS = 5 * 60_000;

/** A meeting about to start, with the link that joins it. */
export type UpcomingMeeting = {
  id: string;
  provider: MeetingCalendarProvider;
  title: string;
  /** Private, personal or confidential: shown only to its owner, never a meeting's name. */
  private: boolean;
  startsAt: string;
  endsAt: string;
  joinUrl: string;
  service: string;
  /** The owner hasn't answered the invitation. */
  unanswered: boolean;
};

/**
 * The meetings with a join link that start in the next minutes (or started a
 * few minutes ago), soonest first; at the same start one the owner answered
 * comes first, then the shorter. All-day, declined, cancelled and
 * out-of-office events are no meetings to join.
 */
export function upcomingMeetingsAt(
  events: readonly MeetingCalendarEvent[],
  now: Date,
): UpcomingMeeting[] {
  const time = now.getTime();
  const seen = new Set<string>();
  return events
    .filter(
      (event) =>
        event.meeting &&
        !event.declined &&
        event.id !== undefined &&
        event.provider !== undefined &&
        event.joinUrl !== undefined &&
        event.end.getTime() > time &&
        event.end.getTime() > event.start.getTime() &&
        event.start.getTime() >= time - UPCOMING_MEETINGS_STARTED_MS &&
        event.start.getTime() <= time + UPCOMING_MEETINGS_AHEAD_MS,
    )
    .sort(
      (a, b) =>
        a.start.getTime() - b.start.getTime() ||
        Number(a.unanswered === true) - Number(b.unanswered === true) ||
        a.end.getTime() - a.start.getTime() - (b.end.getTime() - b.start.getTime()),
    )
    .flatMap((event) => {
      const key = `${event.provider}:${event.id}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [
        {
          id: event.id!,
          provider: event.provider!,
          title: calendarTitle(event.title) ?? "",
          private: event.private,
          startsAt: event.start.toISOString(),
          endsAt: event.end.toISOString(),
          joinUrl: event.joinUrl!,
          service: event.service ?? "Meeting",
          unanswered: event.unanswered === true,
        },
      ];
    });
}

/**
 * The owner's meetings about to start, for a reminder that joins one and
 * starts its recording. `calendar` says whether they have a calendar this
 * deployment can read; a calendar that can't be read now lists nothing and
 * makes the answer incomplete (`complete: false`), so a reminder already
 * showing isn't taken for cancelled.
 */
export async function upcomingMeetings(
  lookup: MeetingCalendarLookup,
  input: { subjectId: string; now: Date },
): Promise<{ calendar: "connected" | "none"; complete: boolean; meetings: UpcomingMeeting[] }> {
  const read = await readMeetingCalendars(lookup, {
    subjectId: input.subjectId,
    from: input.now,
    to: new Date(input.now.getTime() + UPCOMING_MEETINGS_AHEAD_MS),
    join: true,
  });
  if (read === null) return { calendar: "connected", complete: false, meetings: [] };
  return {
    calendar: read.connected ? "connected" : "none",
    complete: read.complete,
    meetings: upcomingMeetingsAt(read.events, input.now),
  };
}

/** The lookup against this deployment's database and connection broker. */
export function meetingCalendarLookup(input: {
  db: Database;
  settings: Settings;
  workspaceId: string;
  subjectId: string;
  fetch?: typeof fetch;
  onProblem?: MeetingCalendarLookup["onProblem"];
}): MeetingCalendarLookup {
  const resolve = buildConnectionTokenResolver(input.db, input.settings);
  return {
    listConnections: () => listConnectionsMetadata(input.db, input.workspaceId, input.subjectId),
    credentialHeaders: async (connection, url) => {
      const result = await resolve({
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        serverId: "meeting-calendar-title",
        toolName: "meeting_calendar_title",
        connectionRef: {
          connectionId: connection.id,
          providerDomain: connection.providerDomain,
          kind: connection.kind,
          subjectScope: "subject",
        },
        destinationUrl: url,
        credentialTarget: "http_api",
      });
      return result.status === "ok" ? result.headers : null;
    },
    fetch: input.fetch ?? fetch,
    googleCalendarEnabled: input.settings.googleCalendarEnabled === true,
    ...(input.onProblem ? { onProblem: input.onProblem } : {}),
  };
}
