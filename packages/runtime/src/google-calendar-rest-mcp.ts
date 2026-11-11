import type { McpServerConnectionRef, ToolAuthNeededPayload } from "@opengeni/contracts";
import {
  defineLocalMcpBridgeDescriptor,
  type LocalMcpBridgeAdapter,
  type LocalMcpBridgeDescriptor,
  type LocalMcpBridgeServer,
} from "@opengeni/capabilities";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import type { MCPServer } from "@openai/agents";
import { AsyncLocalStorage } from "node:async_hooks";
import { isRoutingMutationOutcomeUnknownError } from "./sandbox/routing/routing-session";

/**
 * Connection identity of Google's hosted Calendar MCP. As with Gmail, this URL
 * only selects the reviewed local bridge below; the hosted server is never
 * contacted. Every provider request goes to the Calendar v3 REST API.
 */
export const OFFICIAL_GOOGLE_CALENDAR_MCP_URL = "https://calendarmcp.googleapis.com/mcp/v1";
export const GOOGLE_CALENDAR_REST_API_BASE = "https://www.googleapis.com/calendar/v3";

const GOOGLE_AUTH = "https://www.googleapis.com/auth/";
/** The least-privilege bundle the native Connect flow requests. */
export const GOOGLE_CALENDAR_REQUESTED_SCOPES = Object.freeze([
  `${GOOGLE_AUTH}calendar.calendarlist.readonly`,
  `${GOOGLE_AUTH}calendar.events`,
  `${GOOGLE_AUTH}calendar.freebusy`,
]);

const RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_EVENT_PAGE = 25;
const MAX_EVENT_PAGE = 100;
const MAX_FREE_BUSY_CALENDARS = 20;
const MAX_BUSY_BLOCKS = 200;
const MAX_DESCRIPTION_CHARS = 8_000;
const MAX_ATTENDEES = 100;
const MAX_RANGE_MS = 366 * 86_400_000;
const DEFAULT_EVENT_MINUTES = 60;
/** Working-location markers are left out of event lists; they rarely answer a schedule question. */
const LISTED_EVENT_TYPES = ["default", "focusTime", "outOfOffice", "fromGmail", "birthday"];
const MUTATION_TOOLS = new Set(["create_event", "update_event", "delete_event"]);

type ResolveCredentialResult =
  | {
      status: "ok";
      headers: Record<string, string>;
      connectionId: string;
      authoritySource?: "host";
      authorizeProviderRequest?: () => Promise<boolean>;
      expiresAt?: Date | null;
    }
  | {
      status: "auth_needed";
      reason: ToolAuthNeededPayload["reason"];
      providerDomain: string;
      authoritySource?: "host";
      provider?: string;
      connectionId?: string;
      scopes?: string[];
      resource?: string;
      selectedResources?: McpServerConnectionRef["selectedResources"];
      authorizationUrl?: string;
    };

export type GoogleCalendarRestMcpServerOptions = {
  workspaceId: string;
  subjectId?: string;
  serverId: string;
  connectionRef: McpServerConnectionRef;
  resolveCredential: (input: {
    workspaceId: string;
    subjectId?: string;
    serverId: string;
    toolName?: string;
    connectionRef: McpServerConnectionRef;
    destinationUrl: string;
    forceRefresh?: boolean;
  }) => Promise<ResolveCredentialResult>;
  onAuthNeeded?: (payload: ToolAuthNeededPayload) => void | Promise<void>;
  onResolvedConnectionId?: (connectionId: string) => void;
  fetchImpl?: FetchLike;
  /** Test seam for the current time; defaults to Date.now. */
  now?: () => number;
};

export type GoogleCalendarRestMcpBridgeConfig = {
  readonly url: string;
  readonly connectionRef?: McpServerConnectionRef;
};

export type GoogleCalendarRestMcpBridgeContext = Omit<
  GoogleCalendarRestMcpServerOptions,
  "serverId" | "connectionRef"
> & {
  readonly serverId: string;
};

export const GOOGLE_CALENDAR_REST_MCP_BRIDGE_DESCRIPTOR = defineLocalMcpBridgeDescriptor({
  adapterId: "google-calendar-rest",
  providerId: "google-calendar",
  catalogIdentity: `mcp:${OFFICIAL_GOOGLE_CALENDAR_MCP_URL}`,
  authority: "connection",
  toolSurface: "static_reviewed",
  mutationReplay: "safe_reads_only",
  destinations: [{ origin: "https://www.googleapis.com", pathPrefix: "/calendar/v3/" }],
});

type CalendarTool = Awaited<ReturnType<MCPServer["listTools"]>>[number] & {
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};

type EventTime = { date?: string; dateTime?: string; timeZone?: string };
type CalendarAttendee = {
  email?: string;
  displayName?: string;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
  resource?: boolean;
  responseStatus?: string;
};
type CalendarEvent = {
  id?: string;
  etag?: string;
  status?: string;
  htmlLink?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventTime;
  end?: EventTime;
  recurringEventId?: string;
  recurrence?: string[];
  attendees?: CalendarAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  transparency?: string;
  visibility?: string;
  eventType?: string;
};
type CalendarListEntry = {
  id?: string;
  summary?: string;
  summaryOverride?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  hidden?: boolean;
  selected?: boolean;
};

const timeZoneProperty = {
  type: "string",
  description:
    "IANA time zone such as Europe/Oslo or America/New_York. Defaults to the calendar's own time zone.",
} as const;
const calendarIdProperty = {
  type: "string",
  description: 'Calendar ID from list_calendars. Defaults to "primary", the user\'s own calendar.',
} as const;
const sendUpdatesProperty = {
  type: "string",
  enum: ["none", "all", "externalOnly"],
  description:
    'Who gets an email about this change. Defaults to "none"; use "all" only when the user wants guests notified.',
} as const;
const timeDescription =
  "A date (2026-03-14), a local date and time (2026-03-14T09:30) read in the time zone, or an RFC 3339 time with an offset.";
const emailListProperty = (description: string) =>
  ({ type: "array", items: { type: "string" }, maxItems: MAX_ATTENDEES, description }) as const;

export const GOOGLE_CALENDAR_REST_MCP_TOOLS: CalendarTool[] = [
  {
    name: "list_calendars",
    description:
      "Lists the calendars this Google account can see, with the account's time zone and the current local time. Most questions only need the primary calendar, which the other tools use by default.",
    inputSchema: { type: "object", required: [], additionalProperties: false, properties: {} },
  },
  {
    name: "list_events",
    description:
      "Lists events between timeMin and timeMax, earliest first, as compact rows. Use it for questions like \"what's on tomorrow\" or to find an event before changing it. A date alone as timeMax includes that whole day, so timeMin and timeMax can be the same date. Call get_event for one event's full details.",
    inputSchema: {
      type: "object",
      required: ["timeMin"],
      additionalProperties: false,
      properties: {
        timeMin: { type: "string", description: `Start of the range. ${timeDescription}` },
        timeMax: {
          type: "string",
          description: `End of the range. ${timeDescription} Defaults to the end of timeMin's day.`,
        },
        query: {
          type: "string",
          description: "Optional words to match in the title, description, location or guests.",
        },
        timeZone: timeZoneProperty,
        calendarId: calendarIdProperty,
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: MAX_EVENT_PAGE,
          description: `Events per page, default ${DEFAULT_EVENT_PAGE}.`,
        },
        pageToken: { type: "string", description: "nextPageToken from a previous call." },
      },
    },
  },
  {
    name: "get_event",
    description:
      "Gets one event's full details: description, guests and their replies, organizer, video call link and repeat rule.",
    inputSchema: {
      type: "object",
      required: ["eventId"],
      additionalProperties: false,
      properties: {
        eventId: { type: "string", description: "eventId from list_events." },
        calendarId: calendarIdProperty,
        timeZone: timeZoneProperty,
      },
    },
  },
  {
    name: "find_free_busy",
    description:
      'Shows when calendars are busy between timeMin and timeMax and lists the free gaps when all of them are free. Use it for "am I free Thursday afternoon" or to find a time to meet. Another person\'s calendar shows busy times only if they share it with this account.',
    inputSchema: {
      type: "object",
      required: ["timeMin", "timeMax"],
      additionalProperties: false,
      properties: {
        timeMin: { type: "string", description: `Start of the range. ${timeDescription}` },
        timeMax: {
          type: "string",
          description: `End of the range. ${timeDescription} A date alone includes that whole day.`,
        },
        calendarIds: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_FREE_BUSY_CALENDARS,
          description:
            'Calendar IDs or email addresses to check. Defaults to ["primary"], the user\'s own calendar.',
        },
        timeZone: timeZoneProperty,
      },
    },
  },
  {
    name: "create_event",
    description:
      'Adds an event to the calendar. A date alone as start makes an all-day event. end defaults to one hour after start, or one day for an all-day event. Guests get an email only when sendUpdates is "all" or "externalOnly".',
    inputSchema: {
      type: "object",
      required: ["title", "start"],
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        start: { type: "string", description: timeDescription },
        end: {
          type: "string",
          description: `${timeDescription} For all-day events this is the day after the last day.`,
        },
        timeZone: timeZoneProperty,
        location: { type: "string" },
        description: { type: "string" },
        attendees: emailListProperty("Guest email addresses."),
        calendarId: calendarIdProperty,
        sendUpdates: sendUpdatesProperty,
      },
    },
  },
  {
    name: "update_event",
    description:
      "Changes an event's title, time, place, description or guests; fields you leave out stay as they are. Moving only the start keeps the event's length. An eventId from list_events changes only that occurrence of a repeating event; use its seriesId to change every occurrence.",
    inputSchema: {
      type: "object",
      required: ["eventId"],
      additionalProperties: false,
      properties: {
        eventId: { type: "string", description: "eventId (or seriesId) from list_events." },
        calendarId: calendarIdProperty,
        title: { type: "string" },
        start: { type: "string", description: timeDescription },
        end: { type: "string", description: timeDescription },
        timeZone: timeZoneProperty,
        location: { type: "string", description: "New place. An empty string removes it." },
        description: {
          type: "string",
          description: "New description. An empty string removes it.",
        },
        addAttendees: emailListProperty("Guest email addresses to invite."),
        removeAttendees: emailListProperty("Guest email addresses to remove."),
        sendUpdates: sendUpdatesProperty,
      },
    },
  },
  {
    name: "delete_event",
    description:
      "Deletes an event. An eventId from list_events deletes only that occurrence of a repeating event; its seriesId deletes the whole series.",
    inputSchema: {
      type: "object",
      required: ["eventId"],
      additionalProperties: false,
      properties: {
        eventId: { type: "string", description: "eventId (or seriesId) from list_events." },
        calendarId: calendarIdProperty,
        sendUpdates: sendUpdatesProperty,
      },
    },
  },
];
for (const tool of GOOGLE_CALENDAR_REST_MCP_TOOLS) {
  const mutation = MUTATION_TOOLS.has(tool.name);
  tool.annotations = {
    readOnlyHint: !mutation,
    // Provider-effect hints only; never permission decisions or replay authorization.
    destructiveHint: mutation && tool.name !== "create_event",
    idempotentHint: !mutation || tool.name === "delete_event",
    openWorldHint: true,
  };
}

/** Whether a granted scope set authorizes the provider methods behind a tool. */
export function googleCalendarToolSupportsScopes(name: string, scopes: readonly string[]): boolean {
  const has = (...suffixes: string[]) =>
    suffixes.some((suffix) => scopes.includes(`${GOOGLE_AUTH}${suffix}`));
  if (has("calendar")) return true;
  switch (name) {
    case "list_calendars":
      return has("calendar.readonly", "calendar.calendarlist", "calendar.calendarlist.readonly");
    case "list_events":
    case "get_event":
      return has("calendar.readonly", "calendar.events", "calendar.events.readonly");
    case "find_free_busy":
      return has("calendar.readonly", "calendar.freebusy", "calendar.events.freebusy");
    case "create_event":
    case "update_event":
    case "delete_event":
      return has("calendar.events");
    default:
      return false;
  }
}

export function isOfficialGoogleCalendarMcpConfig(
  url: string,
  connectionRef: McpServerConnectionRef | undefined,
): boolean {
  return (
    canonicalUrl(url) === canonicalUrl(OFFICIAL_GOOGLE_CALENDAR_MCP_URL) &&
    connectionRef?.providerDomain.toLowerCase() === "calendarmcp.googleapis.com" &&
    connectionRef.kind === "oauth2"
  );
}

export class GoogleCalendarRestMcpServer implements LocalMcpBridgeServer {
  readonly name: string;
  readonly cacheToolsList = false;
  readonly bridge: LocalMcpBridgeDescriptor = GOOGLE_CALENDAR_REST_MCP_BRIDGE_DESCRIPTOR;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private pinnedConnectionId?: string;
  private defaultZone?: string;
  private readonly requestContext = new AsyncLocalStorage<{
    signal: AbortSignal | undefined;
    mutationSubmitted: boolean;
  }>();

  constructor(private readonly options: GoogleCalendarRestMcpServerOptions) {
    this.name = `opengeni-google-calendar-rest-${safeIdentity(options.serverId)}`;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  async connect(): Promise<void> {
    const result = await this.options.resolveCredential({
      workspaceId: this.options.workspaceId,
      serverId: this.options.serverId,
      connectionRef: this.options.connectionRef,
      destinationUrl: `${GOOGLE_CALENDAR_REST_API_BASE}/users/me/calendarList/primary`,
      forceRefresh: false,
      ...(this.options.subjectId ? { subjectId: this.options.subjectId } : {}),
    });
    if (result.status === "auth_needed") {
      await this.reportAuthNeeded(result);
      throw new CalendarAuthError("Authentication required for Google Calendar");
    }
    this.options.onResolvedConnectionId?.(result.connectionId);
  }
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {}

  async listTools(): Promise<CalendarTool[]> {
    return structuredClone(GOOGLE_CALENDAR_REST_MCP_TOOLS);
  }

  /**
   * Describes the event an update or delete targets, read from Google rather
   * than from the agent's arguments. Samples only enrich the review card: a
   * missing or unreadable event is left out and the action reports the real
   * problem when it runs. Authentication and access refusals fail closed.
   */
  async reviewContext(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Partial<import("@opengeni/contracts").ToolReviewContext>> {
    if (toolName !== "update_event" && toolName !== "delete_event") return {};
    const eventId = requiredString(args.eventId, "eventId", 1024);
    const calendarId = calendarIdArg(args.calendarId);
    let event: CalendarEvent;
    let zone: string;
    try {
      zone = await this.zone(args.timeZone, toolName);
      event = await this.readEvent(calendarId, eventId, zone, toolName);
    } catch (error) {
      if (error instanceof CalendarProviderError && error.status !== 401 && error.status !== 403)
        return {};
      throw error;
    }
    const clean = (value: string) =>
      value
        .replaceAll("\u0000", "")
        .replace(/\p{Surrogate}/gu, "\uFFFD")
        .slice(0, 256);
    return {
      samples: [
        {
          id: clean(event.id ?? eventId),
          title: clean(event.summary || "(No title)"),
          subtitle: clean(describeEventTime(event, zone)),
          provenance: "provider_metadata" as const,
        },
      ],
    };
  }

  async callTool(toolName: string, args: Record<string, unknown> | null): Promise<any> {
    return (await this.callToolResult(toolName, args)).content;
  }

  async callToolResult(
    toolName: string,
    args: Record<string, unknown> | null,
    _meta?: Record<string, unknown> | null,
    options?: { signal?: AbortSignal },
  ): Promise<any> {
    const requestContext = { signal: options?.signal, mutationSubmitted: false };
    try {
      if (options?.signal?.aborted)
        throw new CalendarInputError("Google Calendar operation cancelled");
      const output = await this.requestContext.run(
        requestContext,
        async () => await this.execute(toolName, args ?? {}),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      if (
        isRoutingMutationOutcomeUnknownError(error) ||
        error instanceof CalendarOutcomeUnknownError
      )
        throw error;
      const refused =
        error instanceof CalendarProviderError && error.status !== undefined && error.status < 500;
      if (requestContext.mutationSubmitted && !refused)
        throw new CalendarOutcomeUnknownError(
          "Google Calendar change was submitted but its result could not be delivered; outcome is uncertain",
        );
      return {
        isError: true,
        content: [{ type: "text", text: safeErrorMessage(error) }],
        structuredContent: {
          error: {
            connectorActionOutcome: "not_executed",
            outcomeUnknown: false,
            ...(error instanceof CalendarProviderError
              ? {
                  status: error.status ?? null,
                  code: error.code,
                  retryable: error.retryable,
                  ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
                }
              : {
                  code:
                    error instanceof CalendarAuthError
                      ? "authentication_required"
                      : error instanceof CalendarInputError
                        ? "invalid_input"
                        : "tool_failed",
                  retryable: false,
                }),
          },
        },
      };
    }
  }

  private async execute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case "list_calendars":
        return await this.listCalendars();
      case "list_events":
        return await this.listEvents(args);
      case "get_event":
        return await this.getEvent(args);
      case "find_free_busy":
        return await this.findFreeBusy(args);
      case "create_event":
        return await this.createEvent(args);
      case "update_event":
        return await this.updateEvent(args);
      case "delete_event":
        return await this.deleteEvent(args);
      default:
        throw new CalendarInputError(`Unknown Google Calendar tool: ${toolName}`);
    }
  }

  private async listCalendars(): Promise<unknown> {
    const calendars: CalendarListEntry[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const url = new URL(`${GOOGLE_CALENDAR_REST_API_BASE}/users/me/calendarList`);
      url.searchParams.set("maxResults", "250");
      url.searchParams.set(
        "fields",
        "nextPageToken,items(id,summary,summaryOverride,primary,accessRole,timeZone,hidden)",
      );
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const payload = await this.request<{ items?: CalendarListEntry[]; nextPageToken?: string }>(
        "list_calendars",
        url,
        {},
        true,
      );
      calendars.push(...(payload.items ?? []));
      pageToken = payload.nextPageToken;
      if (!pageToken) break;
    }
    const primary = calendars.find((calendar) => calendar.primary);
    const zone = validZone(primary?.timeZone) ?? (await this.zone(undefined, "list_calendars"));
    if (primary?.timeZone && validZone(primary.timeZone)) this.defaultZone = primary.timeZone;
    const now = this.now();
    return {
      timeZone: zone,
      now: formatInstant(now, zone),
      weekday: weekdayOf(now, zone),
      calendars: calendars
        .filter((calendar) => calendar.id && calendar.hidden !== true)
        .map((calendar) => ({
          calendarId: calendar.primary ? "primary" : calendar.id!,
          name: calendar.summaryOverride || calendar.summary || calendar.id!,
          ...(calendar.primary ? { primary: true, email: calendar.id } : {}),
          access: calendar.accessRole ?? "unknown",
          ...(calendar.timeZone && calendar.timeZone !== zone
            ? { timeZone: calendar.timeZone }
            : {}),
        })),
    };
  }

  private async listEvents(args: Record<string, unknown>): Promise<unknown> {
    const zone = await this.zone(args.timeZone, "list_events");
    const range = parseRange(args.timeMin, args.timeMax, zone, true);
    const calendarId = calendarIdArg(args.calendarId);
    const maxResults = optionalInteger(args.maxResults, "maxResults", 1, MAX_EVENT_PAGE);
    const url = new URL(eventsUrl(calendarId));
    url.searchParams.set("timeMin", formatInstant(range.start, zone));
    url.searchParams.set("timeMax", formatInstant(range.end, zone));
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("timeZone", zone);
    url.searchParams.set("maxResults", String(maxResults ?? DEFAULT_EVENT_PAGE));
    for (const type of LISTED_EVENT_TYPES) url.searchParams.append("eventTypes", type);
    url.searchParams.set(
      "fields",
      "nextPageToken,items(id,status,summary,location,start,end,recurringEventId,attendees(self,responseStatus),organizer(email,self),hangoutLink,transparency,eventType)",
    );
    const query = optionalString(args.query, "query", 500);
    if (query) url.searchParams.set("q", query);
    const pageToken = optionalString(args.pageToken, "pageToken", 4096);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await this.request<{ items?: CalendarEvent[]; nextPageToken?: string }>(
      "list_events",
      url,
      {},
      true,
    );
    const events = (payload.items ?? []).filter(
      (event) => event.id && event.status !== "cancelled",
    );
    return {
      timeZone: zone,
      range: { start: formatInstant(range.start, zone), end: formatInstant(range.end, zone) },
      ...(calendarId === "primary" ? {} : { calendarId }),
      events: events.map((event) => projectEvent(event, zone)),
      ...(payload.nextPageToken ? { nextPageToken: payload.nextPageToken } : {}),
    };
  }

  private async getEvent(args: Record<string, unknown>): Promise<unknown> {
    const zone = await this.zone(args.timeZone, "get_event");
    const calendarId = calendarIdArg(args.calendarId);
    const event = await this.readEvent(
      calendarId,
      requiredString(args.eventId, "eventId", 1024),
      zone,
      "get_event",
    );
    return { timeZone: zone, event: projectEventDetail(event, zone) };
  }

  private async findFreeBusy(args: Record<string, unknown>): Promise<unknown> {
    const zone = await this.zone(args.timeZone, "find_free_busy");
    if (args.timeMax === undefined) throw new CalendarInputError("timeMax is required");
    const range = parseRange(args.timeMin, args.timeMax, zone, false);
    const ids =
      args.calendarIds === undefined ||
      (Array.isArray(args.calendarIds) && args.calendarIds.length === 0)
        ? ["primary"]
        : stringArray(args.calendarIds, "calendarIds", MAX_FREE_BUSY_CALENDARS, 320);
    const calendarIds = [...new Set(ids)];
    const payload = await this.request<{
      calendars?: Record<
        string,
        { busy?: Array<{ start?: string; end?: string }>; errors?: Array<{ reason?: string }> }
      >;
    }>(
      "find_free_busy",
      `${GOOGLE_CALENDAR_REST_API_BASE}/freeBusy`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          timeMin: new Date(range.start).toISOString(),
          timeMax: new Date(range.end).toISOString(),
          timeZone: zone,
          items: calendarIds.map((id) => ({ id })),
        }),
      },
      true,
    );
    const allBusy: Array<[number, number]> = [];
    const calendars = calendarIds.map((calendarId) => {
      const entry = payload.calendars?.[calendarId];
      const reason = entry?.errors?.find((error) => typeof error.reason === "string")?.reason;
      if (!entry || reason) {
        return { calendarId, error: reason ? safeReason(reason) : "notFound" };
      }
      const busy = (entry.busy ?? [])
        .map((block) => [Date.parse(block.start ?? ""), Date.parse(block.end ?? "")] as const)
        .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
        .map(([start, end]) => [Math.max(start, range.start), Math.min(end, range.end)] as const)
        .filter(([start, end]) => end > start)
        .sort((a, b) => a[0] - b[0]);
      // Free gaps come from every block; only the listed blocks are bounded.
      allBusy.push(...busy.map(([start, end]) => [start, end] as [number, number]));
      return {
        calendarId,
        busy: busy.slice(0, MAX_BUSY_BLOCKS).map(([start, end]) => ({
          start: formatInstant(start, zone),
          end: formatInstant(end, zone),
        })),
        ...(busy.length > MAX_BUSY_BLOCKS ? { busyTruncated: true } : {}),
      };
    });
    // Gaps are only meaningful when every requested calendar answered.
    const everyChecked = calendars.every((calendar) => !("error" in calendar));
    const free = everyChecked ? freeGaps(range.start, range.end, allBusy) : [];
    return {
      timeZone: zone,
      range: { start: formatInstant(range.start, zone), end: formatInstant(range.end, zone) },
      calendars,
      ...(everyChecked
        ? {
            free: free.slice(0, MAX_BUSY_BLOCKS).map(([start, end]) => ({
              start: formatInstant(start, zone),
              end: formatInstant(end, zone),
              day: weekdayOf(start, zone),
            })),
            ...(free.length > MAX_BUSY_BLOCKS ? { freeTruncated: true } : {}),
          }
        : {}),
    };
  }

  private async createEvent(args: Record<string, unknown>): Promise<unknown> {
    const zone = await this.zone(args.timeZone, "create_event");
    const calendarId = calendarIdArg(args.calendarId);
    const start = parseTime(args.start, "start", zone);
    const end =
      args.end === undefined || args.end === ""
        ? defaultEnd(start, null)
        : parseTime(args.end, "end", zone);
    const times = eventTimes(start, end, zone);
    const attendees = emailArray(args.attendees, "attendees");
    const body: Record<string, unknown> = {
      summary: requiredString(args.title, "title", 1024),
      ...times,
    };
    const location = optionalString(args.location, "location", 1024);
    if (location) body.location = location;
    const description = optionalString(args.description, "description", MAX_DESCRIPTION_CHARS);
    if (description) body.description = description;
    if (attendees.length > 0) body.attendees = attendees.map((email) => ({ email }));
    const url = new URL(eventsUrl(calendarId));
    url.searchParams.set("sendUpdates", sendUpdatesArg(args.sendUpdates));
    const event = await this.request<CalendarEvent>(
      "create_event",
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      false,
    );
    return { created: true, timeZone: zone, event: projectWrittenEvent(event, zone) };
  }

  private async updateEvent(args: Record<string, unknown>): Promise<unknown> {
    const calendarId = calendarIdArg(args.calendarId);
    const eventId = requiredString(args.eventId, "eventId", 1024);
    const patch: Record<string, unknown> = {};
    const title = optionalString(args.title, "title", 1024);
    if (title) patch.summary = title;
    for (const [name, max] of [
      ["location", 1024],
      ["description", MAX_DESCRIPTION_CHARS],
    ] as const) {
      const value = args[name];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || value.length > max)
        throw new CalendarInputError(`${name} must be a string of at most ${max} characters`);
      patch[name] = value;
    }
    const addAttendees = emailArray(args.addAttendees, "addAttendees");
    const removeAttendees = new Set(
      emailArray(args.removeAttendees, "removeAttendees").map((email) => email.toLowerCase()),
    );
    const moving =
      (args.start !== undefined && args.start !== "") ||
      (args.end !== undefined && args.end !== "");
    const guestsChanging = addAttendees.length > 0 || removeAttendees.size > 0;
    if (!moving && !guestsChanging && Object.keys(patch).length === 0)
      throw new CalendarInputError("Give at least one field to change");
    const zone = await this.zone(args.timeZone, "update_event");
    const current = await this.readEvent(calendarId, eventId, zone, "update_event");
    if (moving) {
      const oldStart = eventTimeInput(current.start, "start");
      const oldEnd = eventTimeInput(current.end, "end");
      const start =
        args.start !== undefined && args.start !== ""
          ? parseTime(args.start, "start", zone)
          : oldStart;
      const end =
        args.end !== undefined && args.end !== ""
          ? parseTime(args.end, "end", zone)
          : defaultEnd(start, { start: oldStart, end: oldEnd });
      // Inputs are read in the zone the user sees; a timed event keeps its own
      // zone so moving it (or its series) never silently changes that zone.
      const startZone = validZone(current.start?.timeZone) ?? zone;
      const times = eventTimes(
        start,
        end,
        startZone,
        validZone(current.end?.timeZone) ?? startZone,
      );
      // PATCH merges nested objects, so switching between all-day and timed
      // must clear the other representation explicitly.
      patch.start =
        "date" in times.start
          ? { ...times.start, dateTime: null, timeZone: null }
          : { ...times.start, date: null };
      patch.end =
        "date" in times.end
          ? { ...times.end, dateTime: null, timeZone: null }
          : { ...times.end, date: null };
    }
    if (guestsChanging) {
      const existing = current.attendees ?? [];
      const kept = existing.filter(
        (attendee) => !attendee.email || !removeAttendees.has(attendee.email.toLowerCase()),
      );
      const known = new Set(kept.map((attendee) => attendee.email?.toLowerCase()));
      const added = addAttendees
        .filter((email) => !known.has(email.toLowerCase()))
        .map((email) => ({ email }));
      if (kept.length + added.length > MAX_ATTENDEES * 2)
        throw new CalendarInputError("This event would have too many guests");
      patch.attendees = [...kept, ...added];
    }
    const url = new URL(eventUrl(calendarId, eventId));
    url.searchParams.set("sendUpdates", sendUpdatesArg(args.sendUpdates));
    const event = await this.request<CalendarEvent>(
      "update_event",
      url,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          // Refuse to overwrite a change made after the event was read.
          ...(current.etag ? { "if-match": current.etag } : {}),
        },
        body: JSON.stringify(patch),
      },
      false,
    );
    return { updated: true, timeZone: zone, event: projectWrittenEvent(event, zone) };
  }

  private async deleteEvent(args: Record<string, unknown>): Promise<unknown> {
    const calendarId = calendarIdArg(args.calendarId);
    const eventId = requiredString(args.eventId, "eventId", 1024);
    const url = new URL(eventUrl(calendarId, eventId));
    url.searchParams.set("sendUpdates", sendUpdatesArg(args.sendUpdates));
    await this.request<unknown>("delete_event", url, { method: "DELETE" }, false);
    return { deleted: true, eventId };
  }

  private async readEvent(
    calendarId: string,
    eventId: string,
    zone: string,
    toolName: string,
  ): Promise<CalendarEvent> {
    const url = new URL(eventUrl(calendarId, eventId));
    url.searchParams.set("timeZone", zone);
    const event = await this.request<CalendarEvent>(toolName, url, {}, true);
    if (event.status === "cancelled")
      throw new CalendarProviderError("Google Calendar event was deleted", 410);
    return event;
  }

  /** The requested IANA zone, else the primary calendar's own zone (read once). */
  private async zone(value: unknown, toolName: string): Promise<string> {
    if (value !== undefined && value !== null && value !== "") {
      const zone = typeof value === "string" ? validZone(value) : undefined;
      if (!zone)
        throw new CalendarInputError("timeZone must be an IANA time zone name such as Europe/Oslo");
      return zone;
    }
    if (this.defaultZone) return this.defaultZone;
    const fromList = await this.request<{ timeZone?: string }>(
      toolName,
      `${GOOGLE_CALENDAR_REST_API_BASE}/users/me/calendarList/primary?fields=timeZone`,
      {},
      true,
    ).catch(async (error) => {
      // A narrower grant without calendar-list access can still read the
      // primary calendar's zone from its event feed.
      if (!(error instanceof CalendarProviderError) || error.status !== 403) throw error;
      return await this.request<{ timeZone?: string }>(
        toolName,
        `${GOOGLE_CALENDAR_REST_API_BASE}/calendars/primary/events?maxResults=1&fields=timeZone`,
        {},
        true,
      );
    });
    this.defaultZone = validZone(fromList.timeZone) ?? "UTC";
    return this.defaultZone;
  }

  private async reportAuthNeeded(
    result: Extract<ResolveCredentialResult, { status: "auth_needed" }>,
    toolName?: string,
  ): Promise<void> {
    await this.options.onAuthNeeded?.({
      serverId: this.options.serverId,
      ...(toolName ? { toolName } : {}),
      providerDomain: result.providerDomain,
      ...(result.provider ? { provider: result.provider } : {}),
      reason: result.reason,
      ...(result.connectionId ? { connectionId: result.connectionId } : {}),
      ...(result.authoritySource === "host" || this.options.connectionRef.authoritySource === "host"
        ? { authoritySource: "host" as const }
        : {}),
      ...(result.scopes ? { scopes: result.scopes } : {}),
      ...(result.resource ? { resource: result.resource } : {}),
      ...(result.selectedResources ? { selectedResources: result.selectedResources } : {}),
      ...(result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}),
      ...(this.options.subjectId ? { subjectId: this.options.subjectId } : {}),
    });
  }

  private async request<T>(
    toolName: string,
    urlInput: string | URL,
    init: RequestInit,
    replaySafe: boolean,
  ): Promise<T> {
    const url = new URL(urlInput);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "www.googleapis.com" ||
      !url.pathname.startsWith("/calendar/v3/")
    ) {
      throw new Error("Google Calendar REST destination binding mismatch");
    }
    const resolve = async (forceRefresh: boolean) => {
      const result = await this.options.resolveCredential({
        workspaceId: this.options.workspaceId,
        serverId: this.options.serverId,
        connectionRef: this.options.connectionRef,
        destinationUrl: url.toString(),
        toolName,
        forceRefresh,
        ...(this.options.subjectId ? { subjectId: this.options.subjectId } : {}),
      });
      if (result.status === "auth_needed") {
        await this.reportAuthNeeded(result, toolName);
        throw new CalendarAuthError("Authentication required for Google Calendar");
      }
      this.options.onResolvedConnectionId?.(result.connectionId);
      if (this.pinnedConnectionId && this.pinnedConnectionId !== result.connectionId) {
        throw new CalendarAuthError("Google Calendar account changed during this tool session");
      }
      this.pinnedConnectionId = result.connectionId;
      return result;
    };
    const send = async (credential: Extract<ResolveCredentialResult, { status: "ok" }>) => {
      if (credential.authorizeProviderRequest && !(await credential.authorizeProviderRequest())) {
        throw new CalendarAuthError("Authentication required for Google Calendar");
      }
      const context = this.requestContext.getStore();
      const request: RequestInit = {
        ...init,
        headers: { ...credential.headers, ...headersRecord(init.headers) },
        redirect: "error",
        signal: AbortSignal.any([
          ...(init.signal || context?.signal ? [init.signal || context!.signal!] : []),
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      };
      if (!replaySafe && context) context.mutationSubmitted = true;
      try {
        return await this.fetchImpl(url, request);
      } catch (error) {
        if (!replaySafe)
          throw new CalendarOutcomeUnknownError(
            "Google Calendar change failed after submission; outcome is uncertain",
          );
        throw new CalendarProviderError(
          `Google Calendar request failed: ${safeTransportMessage(error)}`,
        );
      }
    };
    let response = await send(await resolve(false));
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      if (!replaySafe)
        throw new CalendarOutcomeUnknownError(
          "Google Calendar authentication expired after the change was submitted; outcome is uncertain",
        );
      response = await send(await resolve(true));
    }
    if (
      response.ok &&
      (response.status === 204 || response.headers.get("content-length") === "0")
    ) {
      await response.body?.cancel().catch(() => undefined);
      return {} as T;
    }
    const payload = await readResponseJsonBounded<unknown>(
      response,
      RESPONSE_MAX_BYTES,
      "Google Calendar REST response",
    ).catch((error) => {
      if (!replaySafe && (response.ok || response.status >= 500))
        throw new CalendarOutcomeUnknownError(
          `Google Calendar change returned an unreadable response (${response.status}); outcome is uncertain`,
        );
      throw new CalendarProviderError(
        `Google Calendar returned an unreadable response (${response.status}): ${safeErrorMessage(error)}`,
        response.ok ? undefined : response.status,
      );
    });
    if (!response.ok) {
      if (!replaySafe && response.status >= 500)
        throw new CalendarOutcomeUnknownError(
          `Google Calendar change returned ${response.status}; outcome is uncertain`,
        );
      throw new CalendarProviderError(
        providerErrorMessage(response.status, payload),
        response.status,
        providerReason(payload),
        retryAfter(response.headers.get("retry-after")),
      );
    }
    return payload as T;
  }
}

export const GOOGLE_CALENDAR_REST_MCP_BRIDGE_ADAPTER: LocalMcpBridgeAdapter<
  GoogleCalendarRestMcpBridgeConfig,
  GoogleCalendarRestMcpBridgeContext
> = Object.freeze({
  adapterId: GOOGLE_CALENDAR_REST_MCP_BRIDGE_DESCRIPTOR.adapterId,
  matches: (config: GoogleCalendarRestMcpBridgeConfig) =>
    isOfficialGoogleCalendarMcpConfig(config.url, config.connectionRef),
  create: (
    config: GoogleCalendarRestMcpBridgeConfig,
    context: GoogleCalendarRestMcpBridgeContext,
  ) => {
    if (!config.connectionRef) {
      throw new Error("Google Calendar REST bridge requires a connection reference");
    }
    return new GoogleCalendarRestMcpServer({
      ...context,
      connectionRef: config.connectionRef,
    });
  },
});

export function googleCalendarRestToolIsMutation(toolName: string): boolean {
  return MUTATION_TOOLS.has(toolName);
}

/** Only used for the trusted local Calendar bridge's durable connector settlement. */
export function googleCalendarRestResultOutcome(
  output: unknown,
): "not_executed" | "uncertain" | null {
  const result = output as {
    isError?: boolean;
    structuredContent?: { error?: { connectorActionOutcome?: string; outcomeUnknown?: boolean } };
  } | null;
  if (result?.isError !== true) return null;
  const error = result.structuredContent?.error;
  return error?.outcomeUnknown === true
    ? "uncertain"
    : error?.connectorActionOutcome === "not_executed"
      ? "not_executed"
      : null;
}

// ---------------------------------------------------------------------------
// Time handling. Local wall-clock inputs are read in an explicit IANA zone with
// the platform's time zone database, so daylight-saving changes stay correct.

type TimeInput = { kind: "date"; date: string } | { kind: "instant"; ms: number };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/u;
const OFFSET_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/u;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatters.set(zone, value);
  }
  return value;
}

function validZone(value: string | undefined): string | undefined {
  if (!value || value.length > 64 || !ZONE_NAME.test(value)) return undefined;
  try {
    formatter(value);
    return value;
  } catch {
    return undefined;
  }
}

function zoneParts(ms: number, zone: string) {
  const parts: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday ?? "",
  };
}

/** Offset of `zone` from UTC at the instant `ms`, in milliseconds. */
function zoneOffset(ms: number, zone: string): number {
  const p = zoneParts(ms, zone);
  const whole = Math.floor(ms / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/**
 * The instant a wall-clock time names in `zone`. A time skipped by a
 * daylight-saving jump moves forward by the jump; a repeated time resolves to
 * its later occurrence.
 */
function localInstant(
  fields: [number, number, number, number, number, number],
  zone: string,
): number {
  const [year, month, day, hour, minute, second] = fields;
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = wall - zoneOffset(wall, zone);
  return wall - zoneOffset(first, zone);
}

function pad(value: number, width = 2): string {
  return String(Math.abs(value)).padStart(width, "0");
}

/** RFC 3339 local time with the zone's offset, e.g. 2026-03-14T09:30:00+01:00. */
function formatInstant(ms: number, zone: string): string {
  const p = zoneParts(ms, zone);
  const offsetMinutes = Math.round(zoneOffset(ms, zone) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.trunc(offsetMinutes / 60))}:${pad(offsetMinutes % 60)}`;
}

function weekdayOf(ms: number, zone: string): string {
  return zoneParts(ms, zone).weekday;
}

function dateWeekday(date: string): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    new Date(`${date}T00:00:00Z`).getUTCDay()
  ]!;
}

function validDate(year: number, month: number, day: number): boolean {
  const value = new Date(Date.UTC(year, month - 1, day));
  return (
    value.getUTCFullYear() === year &&
    value.getUTCMonth() === month - 1 &&
    value.getUTCDate() === day
  );
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number {
  return Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
  );
}

function parseTime(value: unknown, name: string, zone: string): TimeInput {
  const text = typeof value === "string" ? value.trim() : "";
  const invalid = () =>
    new CalendarInputError(
      `${name} must be a date (2026-03-14), a local date and time (2026-03-14T09:30) or an RFC 3339 time with an offset`,
    );
  let match = DATE_ONLY.exec(text);
  if (match) {
    const [year, month, day] = match.slice(1, 4).map(Number) as [number, number, number];
    if (!validDate(year, month, day)) throw invalid();
    return { kind: "date", date: text };
  }
  match = LOCAL_TIME.exec(text);
  if (match) {
    const fields = match.slice(1, 7).map((part) => Number(part ?? 0)) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    if (
      !validDate(fields[0], fields[1], fields[2]) ||
      fields[3] > 23 ||
      fields[4] > 59 ||
      fields[5] > 59
    )
      throw invalid();
    return { kind: "instant", ms: localInstant(fields, zone) };
  }
  if (OFFSET_TIME.test(text)) {
    const ms = Date.parse(text.replace(" ", "T"));
    if (Number.isFinite(ms)) return { kind: "instant", ms };
  }
  throw invalid();
}

function startOfDate(date: string, zone: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return localInstant([year, month, day, 0, 0, 0], zone);
}

function rangeBound(input: TimeInput, zone: string, inclusiveEnd: boolean): number {
  if (input.kind === "instant") return input.ms;
  return startOfDate(inclusiveEnd ? addDays(input.date, 1) : input.date, zone);
}

function parseRange(
  timeMin: unknown,
  timeMax: unknown,
  zone: string,
  endDefaultsToDay: boolean,
): { start: number; end: number } {
  const min = parseTime(timeMin, "timeMin", zone);
  const start = rangeBound(min, zone, false);
  let end: number;
  if (timeMax === undefined || timeMax === null || timeMax === "") {
    if (!endDefaultsToDay) throw new CalendarInputError("timeMax is required");
    const day = min.kind === "date" ? min.date : localDate(min.ms, zone);
    end = startOfDate(addDays(day, 1), zone);
  } else {
    end = rangeBound(parseTime(timeMax, "timeMax", zone), zone, true);
  }
  if (end <= start) throw new CalendarInputError("timeMax must be after timeMin");
  if (end - start > MAX_RANGE_MS)
    throw new CalendarInputError("The time range can be at most one year");
  return { start, end };
}

function localDate(ms: number, zone: string): string {
  const p = zoneParts(ms, zone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

function eventTimeInput(time: EventTime | undefined, name: string): TimeInput {
  if (time?.date && DATE_ONLY.test(time.date)) return { kind: "date", date: time.date };
  const ms = Date.parse(time?.dateTime ?? "");
  if (Number.isFinite(ms)) return { kind: "instant", ms };
  throw new CalendarProviderError(`Google Calendar returned an event without a valid ${name}`);
}

/** End for a new start: keep the old length when the kind matches, else one hour or one day. */
function defaultEnd(
  start: TimeInput,
  previous: { start: TimeInput; end: TimeInput } | null,
): TimeInput {
  if (previous && previous.start.kind === start.kind && previous.end.kind === start.kind) {
    if (start.kind === "date" && previous.start.kind === "date" && previous.end.kind === "date")
      return {
        kind: "date",
        date: addDays(start.date, Math.max(1, daysBetween(previous.start.date, previous.end.date))),
      };
    if (
      start.kind === "instant" &&
      previous.start.kind === "instant" &&
      previous.end.kind === "instant"
    )
      return { kind: "instant", ms: start.ms + Math.max(0, previous.end.ms - previous.start.ms) };
  }
  return start.kind === "date"
    ? { kind: "date", date: addDays(start.date, 1) }
    : { kind: "instant", ms: start.ms + DEFAULT_EVENT_MINUTES * 60_000 };
}

function eventTimes(start: TimeInput, end: TimeInput, zone: string, endZone = zone) {
  if (start.kind !== end.kind)
    throw new CalendarInputError("start and end must both be dates (all-day) or both be times");
  if (start.kind === "date" && end.kind === "date") {
    if (end.date <= start.date)
      throw new CalendarInputError(
        "end must be after start; an all-day end is the day after the last day",
      );
    return { start: { date: start.date }, end: { date: end.date } };
  }
  const startMs = (start as { ms: number }).ms;
  const endMs = (end as { ms: number }).ms;
  if (endMs <= startMs) throw new CalendarInputError("end must be after start");
  return {
    start: { dateTime: formatInstant(startMs, zone), timeZone: zone },
    end: { dateTime: formatInstant(endMs, endZone), timeZone: endZone },
  };
}

/** Free gaps within the range once every busy block is merged. */
function freeGaps(
  start: number,
  end: number,
  busy: Array<[number, number]>,
): Array<[number, number]> {
  const sorted = [...busy].sort((a, b) => a[0] - b[0]);
  const gaps: Array<[number, number]> = [];
  let cursor = start;
  for (const [blockStart, blockEnd] of sorted) {
    if (blockStart > cursor) gaps.push([cursor, Math.min(blockStart, end)]);
    cursor = Math.max(cursor, blockEnd);
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push([cursor, end]);
  return gaps.filter(([gapStart, gapEnd]) => gapEnd - gapStart >= 60_000);
}

function projectTime(time: EventTime | undefined, zone: string): string | undefined {
  if (time?.date) return time.date;
  const ms = Date.parse(time?.dateTime ?? "");
  return Number.isFinite(ms) ? formatInstant(ms, zone) : undefined;
}

function eventDay(event: CalendarEvent, zone: string): string | undefined {
  if (event.start?.date) return dateWeekday(event.start.date);
  const ms = Date.parse(event.start?.dateTime ?? "");
  return Number.isFinite(ms) ? weekdayOf(ms, zone) : undefined;
}

/** One compact row per event: enough to answer "what's on" without a second call. */
function projectEvent(event: CalendarEvent, zone: string) {
  const self = event.attendees?.find((attendee) => attendee.self);
  const guests = event.attendees?.filter((attendee) => !attendee.resource).length ?? 0;
  const day = eventDay(event, zone);
  return {
    eventId: event.id!,
    title: event.summary || "(No title)",
    start: projectTime(event.start, zone),
    end: projectTime(event.end, zone),
    ...(day ? { day } : {}),
    ...(event.start?.date ? { allDay: true } : {}),
    ...(event.location ? { location: truncate(event.location, 300) } : {}),
    ...(event.status && event.status !== "confirmed" ? { status: event.status } : {}),
    ...(event.eventType && event.eventType !== "default" ? { type: event.eventType } : {}),
    ...(event.recurringEventId ? { seriesId: event.recurringEventId } : {}),
    ...(guests > 0 ? { guests } : {}),
    ...(self?.responseStatus && !self.organizer ? { myResponse: self.responseStatus } : {}),
    ...(event.organizer?.email && event.organizer.self !== true
      ? { organizer: event.organizer.email }
      : {}),
    ...(event.hangoutLink ? { meetLink: event.hangoutLink } : {}),
    ...(event.transparency === "transparent" ? { showsAs: "free" } : {}),
  };
}

function projectWrittenEvent(event: CalendarEvent, zone: string) {
  return {
    ...projectEvent({ ...event, id: event.id ?? "" }, zone),
    ...(event.htmlLink ? { link: event.htmlLink } : {}),
  };
}

function projectEventDetail(event: CalendarEvent, zone: string) {
  const description = event.description ?? "";
  const videoLink =
    event.hangoutLink ??
    event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri;
  const attendees = (event.attendees ?? []).slice(0, MAX_ATTENDEES);
  return {
    ...projectEvent({ ...event, id: event.id ?? "" }, zone),
    ...(description
      ? {
          description: truncate(description, MAX_DESCRIPTION_CHARS),
          ...(description.length > MAX_DESCRIPTION_CHARS ? { descriptionTruncated: true } : {}),
        }
      : {}),
    ...(event.organizer?.email
      ? {
          organizer: event.organizer.email,
          ...(event.organizer.self ? { iAmOrganizer: true } : {}),
        }
      : {}),
    ...(attendees.length > 0
      ? {
          guests: attendees.map((attendee) => ({
            email: attendee.email ?? "",
            ...(attendee.displayName ? { name: attendee.displayName } : {}),
            response: attendee.responseStatus ?? "needsAction",
            ...(attendee.organizer ? { organizer: true } : {}),
            ...(attendee.optional ? { optional: true } : {}),
            ...(attendee.self ? { me: true } : {}),
            ...(attendee.resource ? { room: true } : {}),
          })),
          ...((event.attendees?.length ?? 0) > MAX_ATTENDEES
            ? { guestCount: event.attendees!.length }
            : {}),
        }
      : {}),
    ...(event.recurrence?.length ? { repeats: event.recurrence.slice(0, 10) } : {}),
    ...(videoLink ? { meetLink: videoLink } : {}),
    ...(event.visibility && event.visibility !== "default" ? { visibility: event.visibility } : {}),
    ...(event.start?.timeZone && event.start.timeZone !== zone
      ? { eventTimeZone: event.start.timeZone }
      : {}),
    ...(event.htmlLink ? { link: event.htmlLink } : {}),
  };
}

function describeEventTime(event: CalendarEvent, zone: string): string {
  const start = projectTime(event.start, zone);
  const end = projectTime(event.end, zone);
  if (!start) return "";
  if (event.start?.date) {
    const last = end ? addDays(end, -1) : start;
    return last > start ? `${start} to ${last} (all day)` : `${start} (all day)`;
  }
  const startText = `${eventDay(event, zone)} ${start.slice(0, 10)} ${start.slice(11, 16)}`;
  if (!end) return `${startText} (${zone})`;
  const endText =
    end.slice(0, 10) === start.slice(0, 10)
      ? end.slice(11, 16)
      : `${end.slice(0, 10)} ${end.slice(11, 16)}`;
  return `${startText} to ${endText} (${zone})`;
}

// ---------------------------------------------------------------------------
// Arguments, URLs and errors.

function eventsUrl(calendarId: string): string {
  return `${GOOGLE_CALENDAR_REST_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`;
}

function eventUrl(calendarId: string, eventId: string): string {
  return `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;
}

function calendarIdArg(value: unknown): string {
  return optionalString(value, "calendarId", 320) ?? "primary";
}

function sendUpdatesArg(value: unknown): string {
  if (value === undefined || value === null || value === "") return "none";
  if (value === "none" || value === "all" || value === "externalOnly") return value;
  throw new CalendarInputError('sendUpdates must be "none", "all" or "externalOnly"');
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new CalendarInputError(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function optionalString(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw new CalendarInputError(`${name} must be a string of at most ${max} characters`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    throw new CalendarInputError(`${name} must be an integer from ${min} to ${max}`);
  return value as number;
}

function stringArray(value: unknown, name: string, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems)
    throw new CalendarInputError(`${name} must be a list of at most ${maxItems} strings`);
  return value.map((entry, index) => requiredString(entry, `${name}[${index}]`, maxChars).trim());
}

function emailArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  const entries = stringArray(value, name, MAX_ATTENDEES, 320);
  for (const email of entries)
    if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u.test(email))
      throw new CalendarInputError(
        `${name} must contain plain email addresses, such as anna@example.com`,
      );
  return [...new Set(entries)];
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function headersRecord(value: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(value).forEach((headerValue, key) => {
    out[key] = headerValue;
  });
  return out;
}

const PROVIDER_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
  "backendError",
  "internalError",
  "insufficientPermissions",
  "forbidden",
  "forbiddenForNonOrganizer",
  "requiredAccessLevel",
  "domainPolicy",
  "notFound",
  "deleted",
  "invalid",
  "required",
  "timeRangeEmpty",
  "conditionNotMet",
  "duplicate",
  "notACalendarUser",
  "groupTooBig",
  "tooManyCalendarsRequested",
]);

function providerReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const errors = (payload as { error?: { errors?: Array<{ reason?: unknown }> } }).error?.errors;
  const reason = Array.isArray(errors)
    ? errors.find((item) => typeof item?.reason === "string" && PROVIDER_REASONS.has(item.reason))
        ?.reason
    : undefined;
  return typeof reason === "string" ? reason : undefined;
}

function safeReason(reason: string): string {
  return PROVIDER_REASONS.has(reason) ? reason : "unavailable";
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.min(milliseconds, 86_400_000)
    : undefined;
}

function providerErrorMessage(status: number, payload: unknown): string {
  const reason = providerReason(payload);
  const explanation =
    reason === "insufficientPermissions"
      ? "The current grant does not permit this operation."
      : reason === "forbiddenForNonOrganizer"
        ? "Only the event's organizer can make this change."
        : reason === "requiredAccessLevel" || reason === "forbidden"
          ? "This account cannot change that calendar."
          : (reason && /LimitExceeded|quotaExceeded/.test(reason)) || status === 429
            ? "Google Calendar rate or quota limit reached. Retry after the indicated delay."
            : status === 401
              ? "Google Calendar authentication must be renewed."
              : status === 403
                ? "Google Calendar refused access."
                : status === 404 || status === 410
                  ? "That calendar or event does not exist or was deleted."
                  : status === 409 || status === 412
                    ? "The event changed since it was read. Read it again before changing it."
                    : status === 400
                      ? "Google Calendar rejected the request. Check the supplied values."
                      : status >= 500
                        ? "Google Calendar is temporarily unavailable."
                        : "Google Calendar rejected the operation.";
  return `Google Calendar request failed (${status}): ${explanation}${reason ? ` (${reason})` : ""}`;
}

function safeErrorMessage(error: unknown): string {
  if (
    error instanceof CalendarInputError ||
    error instanceof CalendarProviderError ||
    error instanceof CalendarAuthError
  )
    return error.message;
  return "Google Calendar tool failed";
}

function safeTransportMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "request timed out";
  return "provider transport failed";
}

function canonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

function safeIdentity(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80) || "google-calendar";
}

class CalendarInputError extends Error {}
/** Shared MCP uncertainty code preserves the gateway/connector journal outcome. */
class CalendarOutcomeUnknownError extends Error {
  readonly code = 40_102;
  readonly connectorActionOutcome = "uncertain";
  readonly retryable = false;
}
class CalendarProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(
    message: string,
    readonly status?: number,
    reason?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.code =
      status === 401
        ? "authentication_required"
        : status === 429 || (reason && /LimitExceeded|quotaExceeded/.test(reason))
          ? "rate_limited"
          : status === 403
            ? "access_denied"
            : status === 404 || status === 410
              ? "not_found"
              : status === 409 || status === 412
                ? "conflict"
                : status === 400
                  ? "invalid_input"
                  : "provider_unavailable";
    this.retryable = this.code === "rate_limited" || status === undefined || status >= 500;
  }
}
class CalendarAuthError extends Error {}
