import { expect, test } from "bun:test";
import {
  GOOGLE_CALENDAR_REQUESTED_SCOPES,
  GOOGLE_CALENDAR_REST_MCP_TOOLS,
  GoogleCalendarRestMcpServer,
  googleCalendarToolSupportsScopes,
} from "../src/google-calendar-rest-mcp";

// Protocol expectations come from Google's public Calendar v3 discovery document
// (method IDs, verbs, paths, declared query parameters and accepted scopes).
const STANDARD_QUERY_PARAMETERS = new Set(["fields", "prettyPrint", "quotaUser", "alt"]);

test("every Calendar bridge request matches a published route, its parameters and the requested scopes", async () => {
  const contract = await Bun.file(
    new URL("./fixtures/google-calendar-rest-routes.json", import.meta.url),
  ).json();
  const methods: Array<{
    id: string;
    httpMethod: string;
    path: string;
    queryParameters: string[];
    scopes: string[];
  }> = contract.methods;
  const routes = methods.map((method) => ({
    ...method,
    pattern: new RegExp(
      "^/" +
        method.path
          .split(/(\{[^}]+\})/)
          .map((part) => (part.startsWith("{") ? "[^/]+" : part))
          .join("") +
        "$",
    ),
  }));
  const coveredMethods = new Set<string>();
  const coveredTools = new Set<string>();
  const methodsByTool = new Map<string, Set<string>>();
  let currentTool = "";
  const event = {
    id: "event-test",
    etag: '"1"',
    status: "confirmed",
    summary: "Synthetic",
    start: { dateTime: "2026-03-16T09:00:00+01:00", timeZone: "Europe/Oslo" },
    end: { dateTime: "2026-03-16T10:00:00+01:00", timeZone: "Europe/Oslo" },
  };
  const server = new GoogleCalendarRestMcpServer({
    workspaceId: "workspace-test",
    serverId: "calendar-test",
    subjectId: "subject-test",
    connectionRef: {
      providerDomain: "calendarmcp.googleapis.com",
      kind: "oauth2",
      subjectScope: "subject",
    },
    resolveCredential: async () => ({
      status: "ok",
      headers: { authorization: "Bearer synthetic-token" },
      connectionId: "connection-test",
      authorizeProviderRequest: async () => true,
    }),
    fetchImpl: async (input, init) => {
      const url = new URL(input.toString());
      const verb = init?.method ?? "GET";
      expect(url.origin).toBe("https://www.googleapis.com");
      const matched = routes.find(
        (route) => route.httpMethod === verb && route.pattern.test(url.pathname),
      );
      expect(matched, verb + " " + url.pathname).toBeDefined();
      if (!matched) throw new Error("Request does not match the public discovery contract");
      for (const name of url.searchParams.keys())
        expect(
          matched.queryParameters.includes(name) || STANDARD_QUERY_PARAMETERS.has(name),
          `${matched.id} does not declare ${name}`,
        ).toBe(true);
      coveredMethods.add(matched.id);
      methodsByTool.set(currentTool, (methodsByTool.get(currentTool) ?? new Set()).add(matched.id));
      if (verb === "DELETE") return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/calendarList"))
        return Response.json({
          items: [{ id: "owner@example.test", primary: true, timeZone: "Europe/Oslo" }],
        });
      if (url.pathname.endsWith("/calendarList/primary"))
        return Response.json({ timeZone: "Europe/Oslo" });
      if (url.pathname.endsWith("/freeBusy"))
        return Response.json({ calendars: { primary: { busy: [] } } });
      if (url.pathname.endsWith("/events") && verb === "GET")
        return Response.json({ items: [event] });
      return Response.json(event);
    },
  });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["list_events", { timeMin: "2026-03-16" }],
    ["list_calendars", {}],
    ["get_event", { eventId: "event-test" }],
    ["find_free_busy", { timeMin: "2026-03-16T12:00", timeMax: "2026-03-16T17:00" }],
    ["create_event", { title: "Synthetic", start: "2026-03-20T12:00" }],
    ["update_event", { eventId: "event-test", start: "2026-03-17T09:00" }],
    ["delete_event", { eventId: "event-test" }],
  ];
  for (const [tool, args] of cases) {
    currentTool = tool;
    const result = await server.callToolResult(tool, args);
    expect(result.isError, tool + ": " + JSON.stringify(result.content)).not.toBe(true);
    coveredTools.add(tool);
  }
  expect([...coveredTools].sort()).toEqual(
    GOOGLE_CALENDAR_REST_MCP_TOOLS.map((tool) => tool.name).sort(),
  );
  expect([...coveredMethods].sort()).toEqual(methods.map((method) => method.id).sort());
  // The requested consent covers every provider method each tool actually calls.
  for (const [tool, used] of methodsByTool) {
    expect(googleCalendarToolSupportsScopes(tool, GOOGLE_CALENDAR_REQUESTED_SCOPES)).toBe(true);
    for (const id of used) {
      const method = methods.find((candidate) => candidate.id === id)!;
      expect(
        method.scopes.some((scope) => GOOGLE_CALENDAR_REQUESTED_SCOPES.includes(scope)),
        `${tool} calls ${id}, which the requested scopes do not allow`,
      ).toBe(true);
    }
  }
});

test("scope support follows the published method scopes, not the broad calendar scope alone", async () => {
  const contract = await Bun.file(
    new URL("./fixtures/google-calendar-rest-routes.json", import.meta.url),
  ).json();
  const scopesOf = (id: string): string[] =>
    contract.methods.find((method: { id: string }) => method.id === id).scopes;
  const toolMethods: Record<string, string> = {
    list_calendars: "calendar.calendarList.list",
    list_events: "calendar.events.list",
    get_event: "calendar.events.get",
    find_free_busy: "calendar.freebusy.query",
    create_event: "calendar.events.insert",
    update_event: "calendar.events.patch",
    delete_event: "calendar.events.delete",
  };
  // App-created, owned-only, public-only and busy-only scopes return a subset of
  // the user's calendar, so they are deliberately not treated as enough.
  const notSupported = new Set([
    "https://www.googleapis.com/auth/calendar.app.created",
    "https://www.googleapis.com/auth/calendar.events.owned",
    "https://www.googleapis.com/auth/calendar.events.owned.readonly",
    "https://www.googleapis.com/auth/calendar.events.public.readonly",
  ]);
  const busyOnly = "https://www.googleapis.com/auth/calendar.events.freebusy";
  for (const [tool, id] of Object.entries(toolMethods)) {
    for (const scope of scopesOf(id)) {
      if (notSupported.has(scope) || (scope === busyOnly && tool !== "find_free_busy")) continue;
      expect(googleCalendarToolSupportsScopes(tool, [scope]), `${tool} with ${scope}`).toBe(true);
    }
    expect(googleCalendarToolSupportsScopes(tool, [])).toBe(false);
  }
  expect(
    googleCalendarToolSupportsScopes("create_event", [
      "https://www.googleapis.com/auth/calendar.readonly",
    ]),
  ).toBe(false);
  expect(
    googleCalendarToolSupportsScopes("find_free_busy", [
      "https://www.googleapis.com/auth/calendar.events",
    ]),
  ).toBe(false);
});
