import { describe, expect, test } from "bun:test";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
} from "@opengeni/contracts";
import type { ConnectionMetadata } from "@/types";
import {
  activeOpenGeniSlackBotConnections,
  openGeniSlackBotConnectionLabel,
  openGeniSlackBotInstallInput,
  openGeniSlackBotUiMetadata,
  preferredOpenGeniSlackBotConnection,
} from "./slack-bot";

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
  test("shows active shared bot-role connections with all required safe scopes", () => {
    const valid = connection();
    const validWithAdditionalScopes = connection({
      id: crypto.randomUUID(),
      grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, "team:read"],
    });
    const candidates = [
      valid,
      validWithAdditionalScopes,
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
      validWithAdditionalScopes.id,
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

  test("prefers an active reinstall target over a newer revoked connection", () => {
    const revoked = connection({
      id: "44444444-4444-4444-8444-444444444444",
      status: "revoked",
      createdAt: new Date(2).toISOString(),
    });
    const active = connection({ createdAt: new Date(1).toISOString() });

    expect(preferredOpenGeniSlackBotConnection([revoked, active])?.id).toBe(active.id);
    expect(preferredOpenGeniSlackBotConnection([revoked])?.id).toBe(revoked.id);
  });

  test("omits the immutable reinstall target only for an explicit new connection", () => {
    const existing = connection();

    expect(openGeniSlackBotConnectionLabel(existing)).toBe(
      `Test workspace · OpenGeni · ${connectionId}`,
    );

    expect(openGeniSlackBotInstallInput(existing, false)).toEqual({ connectionId });
    expect(openGeniSlackBotInstallInput(existing, true)).toEqual({});
    expect(openGeniSlackBotInstallInput(null, false)).toEqual({});
  });
});
