import { describe, expect, test } from "bun:test";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
} from "@opengeni/contracts";
import type { ConnectionMetadata } from "@/types";
import { activeOpenGeniSlackBotConnections, openGeniSlackBotUiMetadata } from "./slack-bot";

const connectionId = "11111111-1111-4111-8111-111111111111";

function connection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  const now = new Date(0).toISOString();
  return {
    id: connectionId,
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    status: "active",
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    verifiedInstallAt: now,
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      credentialLabel: OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
      slackTeamId: "T_TEST",
      slackTeamName: "Test workspace",
      botDisplayName: "OpenGeni",
    },
    createdBySubjectId: "subject-a",
    updatedBySubjectId: "subject-a",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("OpenGeni Slack bot UI connection filtering", () => {
  test("shows only active shared bot-role connections with the exact scope set", () => {
    const valid = connection();
    const candidates = [
      valid,
      connection({ id: crypto.randomUUID(), status: "revoked" }),
      connection({ id: crypto.randomUUID(), subjectId: "subject-a" }),
      connection({ id: crypto.randomUUID(), kind: "oauth2" }),
      connection({
        id: crypto.randomUUID(),
        grantedScopes: OPENGENI_SLACK_BOT_REQUIRED_SCOPES.filter(
          (scope) => scope !== "channels:history",
        ),
      }),
      connection({
        id: crypto.randomUUID(),
        grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, "channels:join"],
      }),
      connection({
        id: crypto.randomUUID(),
        metadata: { ...valid.metadata, credentialRole: "personal_slack_oauth" },
      }),
    ];

    expect(activeOpenGeniSlackBotConnections(candidates).map((item) => item.id)).toEqual([
      connectionId,
    ]);
    expect(
      activeOpenGeniSlackBotConnections([
        connection({ verifiedInstallAt: null, verifiedInstallVersion: null }),
      ]),
    ).toEqual([]);
    expect(openGeniSlackBotUiMetadata(valid)).toMatchObject({
      credentialRole: OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
      slackTeamId: "T_TEST",
      botDisplayName: "OpenGeni",
    });
  });
});
