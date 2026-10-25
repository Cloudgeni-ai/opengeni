import { expect, test } from "bun:test";
import { reviewedConnectorToolCatalog } from "../src/domain/connector-tool-permissions";
import { OPENGENI_SLACK_REST_USER_SCOPES } from "@opengeni/contracts/slack-rest-mcp";
import { OFFICIAL_GMAIL_MCP_URL, OFFICIAL_GOOGLE_CALENDAR_MCP_URL } from "@opengeni/runtime";
import curated from "../../../data/catalog/curated.json";

test("Slack permissions use the runtime identity matcher instead of hosted discovery", () => {
  for (const url of ["https://mcp.slack.com/mcp", "https://mcp.slack.com/mcp/"]) {
    const config = {
      url,
      connectionRef: {
        providerDomain: "slack.com",
        kind: "oauth2" as const,
        subjectScope: "subject" as const,
      },
    };
    expect(reviewedConnectorToolCatalog(config, OPENGENI_SLACK_REST_USER_SCOPES, {})).toHaveLength(
      10,
    );
    expect(reviewedConnectorToolCatalog(config, ["users:read,chat:write"], {})).toHaveLength(3);
    expect(
      reviewedConnectorToolCatalog(
        { ...config, allowedTools: ["slack_send_message"] },
        OPENGENI_SLACK_REST_USER_SCOPES,
        {},
      ),
    ).toMatchObject([{ name: "slack_send_message", annotations: { readOnlyHint: false } }]);
    expect(reviewedConnectorToolCatalog(config, [], {})).toEqual([]);
    expect(
      reviewedConnectorToolCatalog(
        { ...config, url: `${url}?unreviewed=1` },
        OPENGENI_SLACK_REST_USER_SCOPES,
        {},
      ),
    ).toBeNull();
  }
});

test("Gmail permissions omit watch_mailbox until the deployment has a Pub/Sub topic", () => {
  const config = {
    url: OFFICIAL_GMAIL_MCP_URL,
    connectionRef: {
      providerDomain: "gmailmcp.googleapis.com",
      kind: "oauth2" as const,
      subjectScope: "subject" as const,
    },
  };
  const scopes = ["https://www.googleapis.com/auth/gmail.modify"];
  const without = reviewedConnectorToolCatalog(config, scopes, {})?.map(({ name }) => name);
  expect(without).not.toContain("watch_mailbox");
  expect(without).toContain("stop_watch");
  const withTopic = reviewedConnectorToolCatalog(config, scopes, {
    gmailWatchTopicName: "projects/example/topics/gmail",
  })?.map(({ name }) => name);
  expect(withTopic).toContain("watch_mailbox");
});

test("Google Calendar permissions list the reviewed tools its grant allows, writes recommended for review", () => {
  const config = {
    url: OFFICIAL_GOOGLE_CALENDAR_MCP_URL,
    connectionRef: {
      providerDomain: "calendarmcp.googleapis.com",
      kind: "oauth2" as const,
      subjectScope: "subject" as const,
    },
  };
  const scopes = [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.freebusy",
  ];
  const tools = reviewedConnectorToolCatalog(config, scopes, {})!;
  const writes = tools
    .filter(
      (tool) =>
        (tool as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint === false,
    )
    .map(({ name }) => name);
  expect(writes).toEqual(["create_event", "update_event", "delete_event"]);
  expect(
    reviewedConnectorToolCatalog(
      config,
      ["https://www.googleapis.com/auth/calendar.readonly"],
      {},
    )?.map(({ name }) => name),
  ).toEqual(["list_calendars", "list_events", "get_event", "find_free_busy"]);
  expect(
    reviewedConnectorToolCatalog({ ...config, url: `${config.url}?x=1` }, scopes, {}),
  ).toBeNull();
  // The curated catalog entry recommends review for exactly the state-changing tools.
  const entry = curated.entries.find((candidate) => candidate.mcpUrl === config.url)!;
  expect(entry.allowedTools).toEqual(tools.map(({ name }) => name));
  expect(entry.requireApproval).toEqual(writes);
  expect(entry.defaultConnectionOwnership).toBe("personal");
});
