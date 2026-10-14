import { expect, test } from "bun:test";
import { reviewedConnectorToolCatalog } from "../src/domain/connector-tool-permissions";
import { OPENGENI_SLACK_REST_USER_SCOPES } from "@opengeni/contracts/slack-rest-mcp";
import { OFFICIAL_GMAIL_MCP_URL } from "@opengeni/runtime";

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
      9,
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
