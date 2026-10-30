// A meeting started without a name is named after the event on its owner's
// own connected calendar at the time it started (docs/recordings.md, "Names").
// Google Calendar (personal connection, through the reviewed Calendar REST
// routes) and Outlook Calendar (Microsoft Graph, when connected with a
// calendar scope) are asked at once. It never holds up a recording: every
// failure, a slow provider or no calendar at all leaves the date name, and
// the conversation names the meeting later.
import type { Settings } from "@opengeni/config";
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

/** One calendar event, as much of it as naming a meeting needs. */
export type MeetingCalendarEvent = {
  title: string;
  start: Date;
  end: Date;
  /** All-day events, out of office, focus time and working location are not meetings. */
  meeting: boolean;
  /** Private or confidential: its name must not reach a meeting others may see. */
  private: boolean;
  /** The owner declined it, or it was cancelled. */
  declined: boolean;
};

/**
 * The event a recording that started at `at` is most likely of: one under
 * way or about to start, the one whose start is nearest, then the shorter.
 * Null when none fits.
 */
export function meetingEventAt(
  events: readonly MeetingCalendarEvent[],
  at: Date,
): MeetingCalendarEvent | null {
  const time = at.getTime();
  const fitting = events.filter(
    (event) =>
      event.meeting &&
      !event.private &&
      !event.declined &&
      calendarTitle(event.title) !== null &&
      event.start.getTime() <= time + STARTS_SOON_MS &&
      event.end.getTime() > time + ENDS_SOON_MS &&
      event.end.getTime() > event.start.getTime(),
  );
  fitting.sort(
    (a, b) =>
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
  summary?: unknown;
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
    return [
      {
        title: item.summary,
        start: start ?? new Date(0),
        end: end ?? new Date(0),
        meeting: !allDay && (eventType === "default" || eventType === "fromGmail"),
        private: item.visibility === "private" || item.visibility === "confidential",
        declined: item.status === "cancelled" || self?.responseStatus === "declined",
      },
    ];
  });
}

type GraphEvent = {
  subject?: unknown;
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
    return [
      {
        title: item.subject,
        start,
        end,
        meeting:
          item.isAllDay !== true && item.showAs !== "oof" && item.showAs !== "workingElsewhere",
        private: item.sensitivity === "private" || item.sensitivity === "confidential",
        declined: item.isCancelled === true || item.responseStatus?.response === "declined",
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
      return connection.grantedScopes.some((scope) =>
        MICROSOFT_CALENDAR_SCOPES.has(scope.toLowerCase()),
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
};

function eventsRequest(connection: ConnectionMetadataWithVerification, at: Date) {
  const from = new Date(at.getTime() + ENDS_SOON_MS).toISOString();
  const to = new Date(at.getTime() + STARTS_SOON_MS).toISOString();
  if (connection.providerDomain.toLowerCase() === GOOGLE_CALENDAR_PROVIDER_DOMAIN) {
    const url = new URL(GOOGLE_EVENTS_URL);
    // Events that end after `from` and start before `to`.
    url.searchParams.set("timeMin", from);
    url.searchParams.set("timeMax", to);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("maxResults", "25");
    url.searchParams.set(
      "fields",
      "items(summary,status,visibility,eventType,start,end,attendees(self,responseStatus))",
    );
    return { url: url.toString(), headers: {}, parse: googleCalendarEvents };
  }
  const url = new URL(GRAPH_CALENDAR_VIEW_URL);
  url.searchParams.set("startDateTime", from);
  url.searchParams.set("endDateTime", to);
  url.searchParams.set("$top", "25");
  url.searchParams.set(
    "$select",
    "subject,isAllDay,isCancelled,sensitivity,showAs,start,end,responseStatus",
  );
  return {
    url: url.toString(),
    headers: { Prefer: 'outlook.timezone="UTC"' },
    parse: graphCalendarEvents,
  };
}

/**
 * The name of the owner's calendar event at `at`, from every calendar of
 * theirs this deployment can read. Null when there is none, or on any
 * failure or once the time is up.
 */
export async function meetingCalendarTitle(
  lookup: MeetingCalendarLookup,
  input: { subjectId: string; at: Date },
): Promise<string | null> {
  const timeout = AbortSignal.timeout(lookup.timeoutMs ?? MEETING_CALENDAR_LOOKUP_TIMEOUT_MS);
  const read = async (): Promise<string | null> => {
    const connections = meetingCalendarConnections(await lookup.listConnections(), {
      subjectId: input.subjectId,
      googleCalendarEnabled: lookup.googleCalendarEnabled,
    });
    if (connections.length === 0) return null;
    const found = await Promise.all(
      connections.map(async (connection) => {
        try {
          const request = eventsRequest(connection, input.at);
          const credential = await lookup.credentialHeaders(connection, request.url);
          if (!credential || timeout.aborted) return [];
          const response = await lookup.fetch(request.url, {
            headers: { ...credential, ...request.headers, Accept: "application/json" },
            redirect: "error",
            signal: timeout,
          });
          if (!response.ok) return [];
          return request.parse(await response.json());
        } catch {
          return [];
        }
      }),
    );
    const event = meetingEventAt(found.flat(), input.at);
    return event ? calendarTitle(event.title) : null;
  };
  const expired = new Promise<null>((resolve) => {
    timeout.addEventListener("abort", () => resolve(null), { once: true });
  });
  try {
    return await Promise.race([read(), expired]);
  } catch {
    return null;
  }
}

/** The lookup against this deployment's database and connection broker. */
export function meetingCalendarLookup(input: {
  db: Database;
  settings: Settings;
  workspaceId: string;
  subjectId: string;
  fetch?: typeof fetch;
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
      });
      return result.status === "ok" ? result.headers : null;
    },
    fetch: input.fetch ?? fetch,
    googleCalendarEnabled: input.settings.googleCalendarEnabled === true,
  };
}
