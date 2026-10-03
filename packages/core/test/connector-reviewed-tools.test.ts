import { expect, test } from "bun:test";
import { reviewedConnectorToolCatalog } from "../src/domain/connector-tool-permissions";
import { OPENGENI_SLACK_REST_USER_SCOPES } from "@opengeni/contracts/slack-rest-mcp";

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
    expect(reviewedConnectorToolCatalog(config, OPENGENI_SLACK_REST_USER_SCOPES)).toHaveLength(9);
    expect(reviewedConnectorToolCatalog(config, ["users:read,chat:write"])).toHaveLength(3);
    expect(
      reviewedConnectorToolCatalog(
        { ...config, allowedTools: ["slack_send_message"] },
        OPENGENI_SLACK_REST_USER_SCOPES,
      ),
    ).toMatchObject([{ name: "slack_send_message", annotations: { readOnlyHint: false } }]);
    expect(reviewedConnectorToolCatalog(config, [])).toEqual([]);
    expect(
      reviewedConnectorToolCatalog(
        { ...config, url: `${url}?unreviewed=1` },
        OPENGENI_SLACK_REST_USER_SCOPES,
      ),
    ).toBeNull();
  }
});
