import { describe, expect, test } from "bun:test";
import {
  GOOGLE_CALENDAR_REQUESTED_SCOPES,
  GOOGLE_CALENDAR_REST_MCP_BRIDGE_ADAPTER,
  GOOGLE_CALENDAR_REST_MCP_BRIDGE_DESCRIPTOR,
  GOOGLE_CALENDAR_REST_MCP_TOOLS,
  GoogleCalendarRestMcpServer,
  OFFICIAL_GOOGLE_CALENDAR_MCP_URL,
  googleCalendarRestResultOutcome,
  googleCalendarRestToolIsMutation,
  googleCalendarToolSupportsScopes,
  isOfficialGoogleCalendarMcpConfig,
  type GoogleCalendarRestMcpServerOptions,
} from "../src/google-calendar-rest-mcp";

const connectionRef = {
  providerDomain: "calendarmcp.googleapis.com",
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
};
// Sunday 2026-03-15 10:00 in Oslo (UTC+1); Europe moves to summer time on 2026-03-29.
const NOW = Date.parse("2026-03-15T09:00:00Z");

type Seen = { method: string; url: URL; headers: Headers; body: unknown };

function server(input: {
  fetchImpl: (seen: Seen) => Response | Promise<Response>;
  resolveCredential?: GoogleCalendarRestMcpServerOptions["resolveCredential"];
  onAuthNeeded?: GoogleCalendarRestMcpServerOptions["onAuthNeeded"];
  zone?: string;
}) {
  const requests: Seen[] = [];
  const instance = new GoogleCalendarRestMcpServer({
    workspaceId: "ws_1",
    subjectId: "subject-a",
    serverId: "google-calendar",
    connectionRef,
    now: () => NOW,
    resolveCredential:
      input.resolveCredential ??
      (async () => ({
        status: "ok" as const,
        headers: { authorization: "Bearer calendar-token" },
        connectionId: "conn_1",
      })),
    ...(input.onAuthNeeded ? { onAuthNeeded: input.onAuthNeeded } : {}),
    fetchImpl: async (request, init) => {
      const seen = {
        method: init?.method ?? "GET",
        url: new URL(request.toString()),
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      requests.push(seen);
      if (seen.url.pathname.endsWith("/users/me/calendarList/primary"))
        return Response.json({ timeZone: input.zone ?? "Europe/Oslo" });
      return await input.fetchImpl(seen);
    },
  });
  return { instance, requests };
}

const timed = (start: string, end: string, extra: Record<string, unknown> = {}) => ({
  id: "evt_1",
  etag: '"etag-1"',
  status: "confirmed",
  summary: "Dentist",
  start: { dateTime: start, timeZone: "Europe/Oslo" },
  end: { dateTime: end, timeZone: "Europe/Oslo" },
  ...extra,
});

describe("Google Calendar REST bridge", () => {
  test("registers through the reusable local bridge contract under the hosted MCP identity", () => {
    expect(OFFICIAL_GOOGLE_CALENDAR_MCP_URL).toBe("https://calendarmcp.googleapis.com/mcp/v1");
    expect(
      GOOGLE_CALENDAR_REST_MCP_BRIDGE_ADAPTER.matches({
        url: `${OFFICIAL_GOOGLE_CALENDAR_MCP_URL}/`,
        connectionRef,
      }),
    ).toBe(true);
    expect(
      isOfficialGoogleCalendarMcpConfig(OFFICIAL_GOOGLE_CALENDAR_MCP_URL, {
        ...connectionRef,
        providerDomain: "gmailmcp.googleapis.com",
      }),
    ).toBe(false);
    expect(isOfficialGoogleCalendarMcpConfig("https://example.test/mcp", connectionRef)).toBe(
      false,
    );
    expect(isOfficialGoogleCalendarMcpConfig(OFFICIAL_GOOGLE_CALENDAR_MCP_URL, undefined)).toBe(
      false,
    );
    expect(GOOGLE_CALENDAR_REST_MCP_BRIDGE_DESCRIPTOR).toMatchObject({
      adapterId: "google-calendar-rest",
      providerId: "google-calendar",
      authority: "connection",
      toolSurface: "static_reviewed",
      mutationReplay: "safe_reads_only",
      destinations: [{ origin: "https://www.googleapis.com", pathPrefix: "/calendar/v3/" }],
    });
  });

  test("exposes a small reviewed tool set whose writes are marked as mutations", async () => {
    const { instance } = server({ fetchImpl: () => Response.json({}) });
    expect(instance.bridge).toBe(GOOGLE_CALENDAR_REST_MCP_BRIDGE_DESCRIPTOR);
    const tools = await instance.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_calendars",
      "list_events",
      "get_event",
      "find_free_busy",
      "create_event",
      "update_event",
      "delete_event",
    ]);
    for (const tool of tools) {
      const mutation = ["create_event", "update_event", "delete_event"].includes(tool.name);
      expect(googleCalendarRestToolIsMutation(tool.name)).toBe(mutation);
      expect((tool as { annotations?: { readOnlyHint: boolean } }).annotations?.readOnlyHint).toBe(
        !mutation,
      );
      expect(tool.description.length).toBeLessThan(400);
    }
    // A returned copy cannot alter the shared definitions.
    tools[0]!.description = "changed";
    expect(GOOGLE_CALENDAR_REST_MCP_TOOLS[0]!.description).not.toBe("changed");
  });

  test("the requested consent covers every tool and nothing broader than needed", () => {
    expect([...GOOGLE_CALENDAR_REQUESTED_SCOPES].sort()).toEqual([
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.freebusy",
    ]);
    for (const tool of GOOGLE_CALENDAR_REST_MCP_TOOLS)
      expect(googleCalendarToolSupportsScopes(tool.name, GOOGLE_CALENDAR_REQUESTED_SCOPES)).toBe(
        true,
      );
    const readOnly = ["https://www.googleapis.com/auth/calendar.readonly"];
    expect(
      GOOGLE_CALENDAR_REST_MCP_TOOLS.filter((tool) =>
        googleCalendarToolSupportsScopes(tool.name, readOnly),
      ).map((tool) => tool.name),
    ).toEqual(["list_calendars", "list_events", "get_event", "find_free_busy"]);
  });

  test("reads a whole local day in the calendar's time zone and returns compact rows", async () => {
    const { instance, requests } = server({
      fetchImpl: () =>
        Response.json({
          items: [
            timed("2026-03-16T09:00:00+01:00", "2026-03-16T09:45:00+01:00", {
              location: "Main Street 1",
              description: "x".repeat(5000),
              attendees: [
                { email: "owner@example.test", self: true, responseStatus: "accepted" },
                { email: "dr@example.test", organizer: true, responseStatus: "accepted" },
              ],
              organizer: { email: "dr@example.test" },
              recurringEventId: "series_1",
              hangoutLink: "https://meet.google.com/abc-defg-hij",
            }),
            {
              id: "evt_2",
              status: "confirmed",
              summary: "Holiday",
              start: { date: "2026-03-16" },
              end: { date: "2026-03-17" },
              transparency: "transparent",
            },
            { id: "evt_3", status: "cancelled" },
          ],
          nextPageToken: "next-1",
        }),
    });
    const result = await instance.callToolResult("list_events", {
      timeMin: "2026-03-16",
      timeMax: "2026-03-16",
    });
    expect(result.isError).toBeUndefined();
    const list = requests.find((request) => request.url.pathname.endsWith("/events"))!;
    expect(list.url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(list.url.searchParams.get("timeMin")).toBe("2026-03-16T00:00:00+01:00");
    expect(list.url.searchParams.get("timeMax")).toBe("2026-03-17T00:00:00+01:00");
    expect(list.url.searchParams.get("timeZone")).toBe("Europe/Oslo");
    expect(list.url.searchParams.get("singleEvents")).toBe("true");
    expect(list.url.searchParams.get("orderBy")).toBe("startTime");
    expect(list.url.searchParams.getAll("eventTypes")).not.toContain("workingLocation");
    expect(list.url.searchParams.get("fields")).not.toContain("description");
    expect(result.structuredContent).toEqual({
      timeZone: "Europe/Oslo",
      range: { start: "2026-03-16T00:00:00+01:00", end: "2026-03-17T00:00:00+01:00" },
      events: [
        {
          eventId: "evt_1",
          title: "Dentist",
          start: "2026-03-16T09:00:00+01:00",
          end: "2026-03-16T09:45:00+01:00",
          day: "Mon",
          location: "Main Street 1",
          seriesId: "series_1",
          guests: 2,
          myResponse: "accepted",
          organizer: "dr@example.test",
          meetLink: "https://meet.google.com/abc-defg-hij",
        },
        {
          eventId: "evt_2",
          title: "Holiday",
          start: "2026-03-16",
          end: "2026-03-17",
          day: "Mon",
          allDay: true,
          showsAs: "free",
        },
      ],
      nextPageToken: "next-1",
    });
  });

  test("handles daylight-saving changes and explicit zones and offsets", async () => {
    const seen: URL[] = [];
    const { instance } = server({
      fetchImpl: ({ url }) => {
        seen.push(url);
        return Response.json({ items: [] });
      },
    });
    // The summer-time switch day in Oslo is 23 hours long.
    await instance.callToolResult("list_events", { timeMin: "2026-03-29" });
    expect(seen.at(-1)!.searchParams.get("timeMin")).toBe("2026-03-29T00:00:00+01:00");
    expect(seen.at(-1)!.searchParams.get("timeMax")).toBe("2026-03-30T00:00:00+02:00");
    // Local times are read in the requested zone, which also shapes the response.
    await instance.callToolResult("list_events", {
      timeMin: "2026-11-01T00:30",
      timeMax: "2026-11-01T03:30",
      timeZone: "America/New_York",
    });
    expect(seen.at(-1)!.searchParams.get("timeMin")).toBe("2026-11-01T00:30:00-04:00");
    expect(seen.at(-1)!.searchParams.get("timeMax")).toBe("2026-11-01T03:30:00-05:00");
    expect(seen.at(-1)!.searchParams.get("timeZone")).toBe("America/New_York");
    // An explicit offset is honored and re-expressed in the calendar's zone.
    await instance.callToolResult("list_events", {
      timeMin: "2026-06-01T08:00:00Z",
      timeMax: "2026-06-01T10:00:00Z",
    });
    expect(seen.at(-1)!.searchParams.get("timeMin")).toBe("2026-06-01T10:00:00+02:00");
    // A local time skipped by the switch moves forward instead of failing.
    await instance.callToolResult("list_events", { timeMin: "2026-03-29T02:30" });
    expect(seen.at(-1)!.searchParams.get("timeMin")).toBe("2026-03-29T03:30:00+02:00");
    expect(seen.at(-1)!.searchParams.get("timeMax")).toBe("2026-03-30T00:00:00+02:00");
  });

  test("rejects ambiguous or unsafe inputs before contacting Google", async () => {
    const { instance, requests } = server({ fetchImpl: () => Response.json({ items: [] }) });
    for (const args of [
      { timeMin: "next tuesday" },
      { timeMin: "2026-02-30" },
      { timeMin: "2026-03-16", timeMax: "2026-03-15" },
      { timeMin: "2026-03-16", timeZone: "Mars/Olympus Mons" },
      { timeMin: "2026-01-01", timeMax: "2028-01-01" },
      { timeMin: "2026-03-16", maxResults: 1000 },
    ]) {
      const result = await instance.callToolResult("list_events", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.structuredContent.error).toMatchObject({
        code: "invalid_input",
        connectorActionOutcome: "not_executed",
      });
    }
    const created = await instance.callToolResult("create_event", {
      title: "Lunch",
      start: "2026-03-20T12:00",
      attendees: ["Anna"],
    });
    expect(created.structuredContent.error.code).toBe("invalid_input");
    expect(requests.filter((request) => !request.url.pathname.endsWith("/primary"))).toEqual([]);
  });

  test("lists calendars with the account zone and current local time", async () => {
    const { instance } = server({
      fetchImpl: () =>
        Response.json({
          items: [
            {
              id: "owner@example.test",
              summary: "owner@example.test",
              primary: true,
              accessRole: "owner",
              timeZone: "Europe/Oslo",
            },
            {
              id: "family123@group.calendar.google.com",
              summary: "Family",
              accessRole: "writer",
              timeZone: "Europe/Oslo",
            },
            { id: "hidden@group.calendar.google.com", summary: "Hidden", hidden: true },
          ],
        }),
    });
    const result = await instance.callToolResult("list_calendars", {});
    expect(result.structuredContent).toEqual({
      timeZone: "Europe/Oslo",
      now: "2026-03-15T10:00:00+01:00",
      weekday: "Sun",
      calendars: [
        {
          calendarId: "primary",
          name: "owner@example.test",
          primary: true,
          email: "owner@example.test",
          access: "owner",
        },
        { calendarId: "family123@group.calendar.google.com", name: "Family", access: "writer" },
      ],
    });
  });

  test("free/busy merges calendars and returns the gaps when everyone is free", async () => {
    const { instance, requests } = server({
      fetchImpl: () =>
        Response.json({
          calendars: {
            primary: {
              busy: [
                { start: "2026-03-19T12:00:00Z", end: "2026-03-19T13:00:00Z" },
                { start: "2026-03-19T09:00:00Z", end: "2026-03-19T11:30:00Z" },
              ],
            },
            "anna@example.test": {
              busy: [{ start: "2026-03-19T12:30:00Z", end: "2026-03-19T14:00:00Z" }],
            },
            "private@example.test": { errors: [{ domain: "global", reason: "notFound" }] },
          },
        }),
    });
    const result = await instance.callToolResult("find_free_busy", {
      timeMin: "2026-03-19T12:00",
      timeMax: "2026-03-19T17:00",
      calendarIds: ["primary", "anna@example.test", "private@example.test"],
    });
    const query = requests.find((request) => request.url.pathname.endsWith("/freeBusy"))!;
    expect(query.method).toBe("POST");
    expect(query.body).toEqual({
      timeMin: "2026-03-19T11:00:00.000Z",
      timeMax: "2026-03-19T16:00:00.000Z",
      timeZone: "Europe/Oslo",
      items: [{ id: "primary" }, { id: "anna@example.test" }, { id: "private@example.test" }],
    });
    expect(result.structuredContent).toEqual({
      timeZone: "Europe/Oslo",
      range: { start: "2026-03-19T12:00:00+01:00", end: "2026-03-19T17:00:00+01:00" },
      calendars: [
        {
          calendarId: "primary",
          busy: [
            { start: "2026-03-19T12:00:00+01:00", end: "2026-03-19T12:30:00+01:00" },
            { start: "2026-03-19T13:00:00+01:00", end: "2026-03-19T14:00:00+01:00" },
          ],
        },
        {
          calendarId: "anna@example.test",
          busy: [{ start: "2026-03-19T13:30:00+01:00", end: "2026-03-19T15:00:00+01:00" }],
        },
        { calendarId: "private@example.test", error: "notFound" },
      ],
      free: [
        { start: "2026-03-19T12:30:00+01:00", end: "2026-03-19T13:00:00+01:00", day: "Thu" },
        { start: "2026-03-19T15:00:00+01:00", end: "2026-03-19T17:00:00+01:00", day: "Thu" },
      ],
    });
  });

  test("creates an event in local time with a default hour and no guest emails", async () => {
    const { instance, requests } = server({
      fetchImpl: ({ body }) =>
        Response.json({
          id: "evt_new",
          status: "confirmed",
          htmlLink: "https://www.google.com/calendar/event?eid=abc",
          ...(body as object),
        }),
    });
    const result = await instance.callToolResult("create_event", {
      title: "Lunch with Anna",
      start: "2026-03-20T12:00",
      attendees: ["anna@example.test"],
    });
    const insert = requests.find((request) => request.method === "POST")!;
    expect(insert.url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(insert.url.searchParams.get("sendUpdates")).toBe("none");
    expect(insert.body).toEqual({
      summary: "Lunch with Anna",
      start: { dateTime: "2026-03-20T12:00:00+01:00", timeZone: "Europe/Oslo" },
      end: { dateTime: "2026-03-20T13:00:00+01:00", timeZone: "Europe/Oslo" },
      attendees: [{ email: "anna@example.test" }],
    });
    expect(result.structuredContent).toEqual({
      created: true,
      timeZone: "Europe/Oslo",
      event: {
        eventId: "evt_new",
        title: "Lunch with Anna",
        start: "2026-03-20T12:00:00+01:00",
        end: "2026-03-20T13:00:00+01:00",
        day: "Fri",
        guests: 1,
        link: "https://www.google.com/calendar/event?eid=abc",
      },
    });
    const allDay = await instance.callToolResult("create_event", {
      title: "Trip",
      start: "2026-03-20",
    });
    expect(requests.at(-1)!.body).toEqual({
      summary: "Trip",
      start: { date: "2026-03-20" },
      end: { date: "2026-03-21" },
    });
    expect(allDay.structuredContent.event.allDay).toBe(true);
  });

  test("moving only the start keeps the length, guards concurrent edits and merges guests", async () => {
    const { instance, requests } = server({
      fetchImpl: ({ method, body }) =>
        method === "PATCH"
          ? Response.json({
              ...timed("2026-03-16T09:00:00+01:00", "2026-03-16T09:45:00+01:00"),
              ...(body as object),
            })
          : Response.json(
              timed("2026-03-16T09:00:00+01:00", "2026-03-16T09:45:00+01:00", {
                attendees: [
                  { email: "owner@example.test", self: true, responseStatus: "accepted" },
                  { email: "old@example.test", responseStatus: "needsAction" },
                ],
              }),
            ),
    });
    const result = await instance.callToolResult("update_event", {
      eventId: "evt_1",
      start: "2026-04-02T14:00",
      addAttendees: ["new@example.test"],
      removeAttendees: ["OLD@example.test"],
    });
    expect(result.isError).toBeUndefined();
    const patch = requests.find((request) => request.method === "PATCH")!;
    expect(patch.url.pathname).toBe("/calendar/v3/calendars/primary/events/evt_1");
    expect(patch.headers.get("if-match")).toBe('"etag-1"');
    expect(patch.url.searchParams.get("sendUpdates")).toBe("none");
    expect(patch.body).toEqual({
      // Summer time: the 45-minute length is kept across the offset change.
      start: { dateTime: "2026-04-02T14:00:00+02:00", timeZone: "Europe/Oslo", date: null },
      end: { dateTime: "2026-04-02T14:45:00+02:00", timeZone: "Europe/Oslo", date: null },
      attendees: [
        { email: "owner@example.test", self: true, responseStatus: "accepted" },
        { email: "new@example.test" },
      ],
    });
    expect(result.structuredContent.updated).toBe(true);
  });

  test("an update with nothing to change is refused without a provider call", async () => {
    const { instance, requests } = server({ fetchImpl: () => Response.json({}) });
    const result = await instance.callToolResult("update_event", { eventId: "evt_1" });
    expect(result.structuredContent.error.code).toBe("invalid_input");
    expect(requests).toEqual([]);
  });

  test("delete removes the event and reports a missing one as not found", async () => {
    let status = 204;
    const { instance, requests } = server({
      fetchImpl: () =>
        status === 204
          ? new Response(null, { status })
          : Response.json({ error: { errors: [{ reason: "deleted" }] } }, { status }),
    });
    expect(
      (await instance.callToolResult("delete_event", { eventId: "evt 1", sendUpdates: "all" }))
        .structuredContent,
    ).toEqual({ deleted: true, eventId: "evt 1" });
    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.url.pathname).toBe("/calendar/v3/calendars/primary/events/evt%201");
    expect(requests[0]!.url.searchParams.get("sendUpdates")).toBe("all");
    status = 410;
    const gone = await instance.callToolResult("delete_event", { eventId: "evt_1" });
    expect(gone.isError).toBe(true);
    expect(gone.structuredContent.error).toMatchObject({
      code: "not_found",
      connectorActionOutcome: "not_executed",
      retryable: false,
    });
    expect(googleCalendarRestResultOutcome(gone)).toBe("not_executed");
  });

  test("a write is never retried and an unknown result is reported as uncertain", async () => {
    for (const failure of [
      () => new Response("upstream", { status: 503 }),
      () => {
        throw new TypeError("socket closed");
      },
      () => new Response("not json", { status: 200 }),
      () => new Response(null, { status: 401 }),
    ]) {
      let writes = 0;
      const { instance } = server({
        fetchImpl: ({ method }) => {
          if (method === "POST") writes++;
          return failure();
        },
      });
      const error = await instance
        .callToolResult("create_event", { title: "Lunch", start: "2026-03-20T12:00" })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 40_102, connectorActionOutcome: "uncertain" });
      expect(writes).toBe(1);
    }
  });

  test("a read refreshes an expired credential once; a refusal is not executed", async () => {
    let calls = 0;
    const refreshes: boolean[] = [];
    const { instance } = server({
      resolveCredential: async (request) => {
        refreshes.push(request.forceRefresh === true);
        return { status: "ok", headers: { authorization: "Bearer t" }, connectionId: "conn_1" };
      },
      fetchImpl: () =>
        ++calls === 1 ? new Response(null, { status: 401 }) : Response.json({ items: [] }),
    });
    const result = await instance.callToolResult("list_events", { timeMin: "2026-03-16" });
    expect(result.isError).toBeUndefined();
    expect(refreshes.at(-1)).toBe(true);
    const { instance: refused } = server({
      fetchImpl: () =>
        Response.json(
          { error: { errors: [{ reason: "forbiddenForNonOrganizer" }] } },
          { status: 403 },
        ),
    });
    const denied = await refused.callToolResult("update_event", {
      eventId: "evt_1",
      title: "Renamed",
    });
    expect(denied.structuredContent.error).toMatchObject({
      code: "access_denied",
      connectorActionOutcome: "not_executed",
    });
    expect(denied.content[0].text).toContain("organizer");
  });

  test("asks the person to connect and pins the account for the tool session", async () => {
    const authNeeded: unknown[] = [];
    const { instance } = server({
      resolveCredential: async () => ({
        status: "auth_needed",
        reason: "missing_connection",
        providerDomain: "calendarmcp.googleapis.com",
      }),
      onAuthNeeded: (payload) => {
        authNeeded.push(payload);
      },
      fetchImpl: () => Response.json({}),
    });
    await expect(instance.connect()).rejects.toThrow("Authentication required");
    expect(authNeeded[0]).toMatchObject({
      serverId: "google-calendar",
      providerDomain: "calendarmcp.googleapis.com",
      reason: "missing_connection",
      subjectId: "subject-a",
    });
    let connectionId = "conn_1";
    const { instance: pinned } = server({
      resolveCredential: async () => ({ status: "ok", headers: {}, connectionId }),
      fetchImpl: () => Response.json({ items: [] }),
    });
    expect(
      (await pinned.callToolResult("list_events", { timeMin: "2026-03-16" })).isError,
    ).toBeUndefined();
    connectionId = "conn_2";
    const switched = await pinned.callToolResult("list_events", { timeMin: "2026-03-16" });
    expect(switched.structuredContent.error.code).toBe("authentication_required");
  });

  test("review cards describe the targeted event from Google, never from arguments", async () => {
    const { instance } = server({
      fetchImpl: ({ url }) =>
        url.pathname.endsWith("/missing")
          ? Response.json({}, { status: 404 })
          : Response.json(timed("2026-03-19T14:00:00+01:00", "2026-03-19T15:00:00+01:00")),
    });
    expect(
      await instance.reviewContext("update_event", {
        eventId: "evt_1",
        title: "Agent-supplied title",
      }),
    ).toEqual({
      samples: [
        {
          id: "evt_1",
          title: "Dentist",
          subtitle: "Thu 2026-03-19 14:00 to 15:00 (Europe/Oslo)",
          provenance: "provider_metadata",
        },
      ],
    });
    expect(await instance.reviewContext("delete_event", { eventId: "missing" })).toEqual({});
    expect(
      await instance.reviewContext("create_event", { title: "x", start: "2026-03-19" }),
    ).toEqual({});
    const { instance: denied } = server({
      fetchImpl: () => Response.json({}, { status: 403 }),
    });
    await expect(denied.reviewContext("delete_event", { eventId: "evt_1" })).rejects.toThrow();
  });
});
