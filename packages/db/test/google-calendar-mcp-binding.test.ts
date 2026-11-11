import { expect, test } from "bun:test";
import { connectionMetadataMatchesBinding } from "../src/connection-token-resolver";
const resource = "https://calendarmcp.googleapis.com/mcp/v1";
const ref = {
  providerDomain: "calendarmcp.googleapis.com",
  kind: "oauth2" as const,
  subjectScope: "subject" as const,
  resource,
};
const connection = {
  providerDomain: ref.providerDomain,
  kind: "oauth2",
  grantedScopes: [],
  metadata: { mcpUrl: resource, resource },
} as any;

test("Calendar REST access is confined to the personal Calendar grant and its reviewed routes", () => {
  for (const path of [
    "/calendar/v3/users/me/calendarList",
    "/calendar/v3/users/me/calendarList/primary?fields=timeZone",
    "/calendar/v3/calendars/primary/events?timeMin=2026-03-16T00%3A00%3A00%2B01%3A00",
    "/calendar/v3/calendars/family%40group.calendar.google.com/events/evt_1",
    "/calendar/v3/calendars/en.norwegian%23holiday%40group.v.calendar.google.com/events",
    "/calendar/v3/freeBusy",
  ]) {
    expect(
      connectionMetadataMatchesBinding(connection, ref, `https://www.googleapis.com${path}`),
    ).toBe(true);
  }
  for (const url of [
    "https://www.googleapis.com/calendar/v3/calendars/primary",
    "https://www.googleapis.com/calendar/v3/calendars/primary/acl",
    "https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_1/move",
    "https://www.googleapis.com/calendar/v3/users/me/settings",
    "https://www.googleapis.com/drive/v3/files/file_1",
    "https://www.googleapis.com:444/calendar/v3/freeBusy",
    "https://attacker.test/calendar/v3/freeBusy",
    "http://www.googleapis.com/calendar/v3/freeBusy",
  ]) {
    expect(connectionMetadataMatchesBinding(connection, ref, url), url).toBe(false);
  }
  expect(
    connectionMetadataMatchesBinding(
      connection,
      { ...ref, subjectScope: "workspace" },
      "https://www.googleapis.com/calendar/v3/freeBusy",
    ),
  ).toBe(false);
  // Another Google grant cannot reach Calendar routes, and this grant cannot reach Gmail.
  expect(
    connectionMetadataMatchesBinding(
      { ...connection, metadata: { mcpUrl: "https://drivemcp.googleapis.com/mcp/v1" } },
      ref,
      "https://www.googleapis.com/calendar/v3/freeBusy",
    ),
  ).toBe(false);
  expect(
    connectionMetadataMatchesBinding(
      connection,
      ref,
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    ),
  ).toBe(false);
});
