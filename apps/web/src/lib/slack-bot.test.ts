import { describe, expect, test } from "bun:test";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_BOT_SAFE_OPTIONAL_SCOPES,
} from "@opengeni/contracts";
import { formatTimestamp } from "@/lib/format";
import type { ConnectionMetadata } from "@/types";
import {
  activeOpenGeniSlackBotConnections,
  openGeniSlackBotConnectionLabel,
  openGeniSlackBotConnectionOptions,
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
      botId: "B_TEST",
      botUserId: "U_TEST",
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
      grantedScopes: [
        ...OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
        ...OPENGENI_SLACK_BOT_SAFE_OPTIONAL_SCOPES,
      ],
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
      ...[
        "files:write",
        "reactions:write",
        "chat:write.customize",
        "users:read.email",
        "admin",
        "admin.users:read",
        "search:read.enterprise",
        "future:unknown",
      ].map((scope) =>
        connection({
          id: crypto.randomUUID(),
          grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, scope],
        }),
      ),
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
    expect(
      openGeniSlackBotUiMetadata(
        connection({ metadata: { ...valid.metadata, botDisplayName: "OpenGeni Staging" } }),
      ),
    ).toMatchObject({ botDisplayName: "OpenGeni Staging" });
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

  test("names an install by its Slack workspace, never by its uuid", () => {
    const existing = connection();
    expect(openGeniSlackBotConnectionLabel(existing)).toBe("Test workspace · OpenGeni");

    // One install needs no discriminator at all.
    expect(openGeniSlackBotConnectionOptions([existing])).toEqual([
      { connection: existing, label: "Test workspace · OpenGeni" },
    ]);

    // Two same-named Slack workspaces are told apart by the Slack team id,
    // which is what Slack itself shows, and not by the connection uuid.
    const otherTeam = connection({
      id: "55555555-5555-4555-8555-555555555555",
      metadata: { ...existing.metadata, slackTeamId: "T_OTHER" },
    });
    const named = openGeniSlackBotConnectionOptions([existing, otherTeam]);
    expect(named.map((option) => option.label)).toEqual([
      "Test workspace · OpenGeni · T_TEST",
      "Test workspace · OpenGeni · T_OTHER",
    ]);

    // Reinstalling the same Slack workspace collides on the team id too, so the
    // install time is the discriminator of last resort.
    const reinstalled = connection({
      id: "66666666-6666-4666-8666-666666666666",
      createdAt: new Date(86_400_000).toISOString(),
    });
    const duplicates = openGeniSlackBotConnectionOptions([existing, reinstalled]);
    expect(duplicates[0]?.label).toBe(
      `Test workspace · OpenGeni · T_TEST · installed ${formatTimestamp(existing.createdAt)}`,
    );
    expect(duplicates[1]?.label).toBe(
      `Test workspace · OpenGeni · T_TEST · installed ${formatTimestamp(reinstalled.createdAt)}`,
    );

    // Whatever the ladder produced, no label may leak a uuid and no two rows
    // may read the same.
    for (const option of [...named, ...duplicates]) {
      expect(option.label).not.toContain(option.connection.id);
    }
    expect(new Set(duplicates.map((option) => option.label)).size).toBe(2);

    // A row that is not an OpenGeni bot install is dropped, not labeled.
    expect(openGeniSlackBotConnectionOptions([connection({ kind: "oauth2" })])).toEqual([]);
  });

  test("omits the immutable reinstall target only for an explicit new connection", () => {
    const existing = connection();

    expect(openGeniSlackBotInstallInput(existing, false)).toEqual({ connectionId });
    expect(openGeniSlackBotInstallInput(existing, true)).toEqual({});
    expect(openGeniSlackBotInstallInput(null, false)).toEqual({});
  });
});
