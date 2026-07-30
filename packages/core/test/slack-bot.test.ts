import { describe, expect, test } from "bun:test";
import {
  OPENGENI_SLACK_BOT_CREDENTIAL_LABEL,
  OPENGENI_SLACK_BOT_CREDENTIAL_ROLE,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
  type AccessGrant,
  type ConnectionMetadata,
  type Session,
} from "@opengeni/contracts";
import {
  createSessionForRequest,
  hasReservedOpenGeniSlackBotSessionMetadata,
  isOpenGeniSlackBotConnection,
  isTrustedScheduledSlackBotSession,
  scheduledSlackBotConnectionId,
  validateOpenGeniSlackBotConnectionSelection,
} from "../src";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const taskId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";

type BotConnection = ConnectionMetadata & {
  verifiedInstallAt: string | null;
  verifiedInstallVersion: number | null;
};

function botConnection(overrides: Partial<BotConnection> = {}): BotConnection {
  const now = new Date(0).toISOString();
  return {
    id: connectionId,
    accountId,
    workspaceId,
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
      botUserId: "U_TEST",
      botId: "B_TEST",
      botDisplayName: "OpenGeni",
      verifiedAt: now,
    },
    createdBySubjectId: "subject-a",
    updatedBySubjectId: "subject-a",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function scheduledSession(
  overrides: Partial<Pick<Session, "createdBy" | "createdByContext" | "metadata">> = {},
): Pick<Session, "createdBy" | "createdByContext" | "metadata"> {
  return {
    createdBy: { kind: "service", subjectId: "scheduler", label: "OpenGeni scheduler" },
    createdByContext: { scheduledTaskId: taskId, scheduledTaskRunId: runId },
    metadata: {
      scheduledTaskId: taskId,
      scheduledTaskRunId: runId,
      [OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]: connectionId,
    },
    ...overrides,
  };
}

describe("OpenGeni Slack bot trust predicates", () => {
  test("requires the shared app role and exact bot scopes", () => {
    expect(isOpenGeniSlackBotConnection(botConnection())).toBe(true);
    expect(isOpenGeniSlackBotConnection(botConnection({ verifiedInstallAt: null }))).toBe(false);
    expect(isOpenGeniSlackBotConnection(botConnection({ verifiedInstallVersion: 2 }))).toBe(false);
    expect(isOpenGeniSlackBotConnection(botConnection({ subjectId: "subject-a" }))).toBe(false);
    expect(isOpenGeniSlackBotConnection(botConnection({ kind: "oauth2" }))).toBe(false);
    expect(
      isOpenGeniSlackBotConnection(
        botConnection({
          grantedScopes: OPENGENI_SLACK_BOT_REQUIRED_SCOPES.filter(
            (scope) => scope !== "channels:history",
          ),
        }),
      ),
    ).toBe(false);
    expect(
      isOpenGeniSlackBotConnection(
        botConnection({
          grantedScopes: [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, "channels:join"],
        }),
      ),
    ).toBe(false);
    expect(
      isOpenGeniSlackBotConnection(
        botConnection({ metadata: { ...botConnection().metadata, credentialRole: "personal" } }),
      ),
    ).toBe(false);
  });

  test("accepts routing only with matching immutable scheduler provenance", () => {
    expect(isTrustedScheduledSlackBotSession(scheduledSession())).toBe(true);
    expect(
      isTrustedScheduledSlackBotSession(
        scheduledSession({ createdBy: { kind: "subject", subjectId: "subject-a" } }),
      ),
    ).toBe(false);
    expect(
      isTrustedScheduledSlackBotSession(
        scheduledSession({ createdByContext: { scheduledTaskId: taskId } }),
      ),
    ).toBe(false);
    expect(
      isTrustedScheduledSlackBotSession(
        scheduledSession({
          metadata: {
            ...scheduledSession().metadata,
            scheduledTaskRunId: "66666666-6666-4666-8666-666666666666",
          },
        }),
      ),
    ).toBe(false);
    expect(scheduledSlackBotConnectionId(scheduledSession().metadata)).toBe(connectionId);
    expect(
      scheduledSlackBotConnectionId({ [OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]: "not-a-uuid" }),
    ).toBeNull();
  });

  test("rejects the server-owned routing key on public session creation", async () => {
    expect(
      hasReservedOpenGeniSlackBotSessionMetadata({
        [OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]: connectionId,
      }),
    ).toBe(true);
    const grant: AccessGrant = {
      accountId,
      workspaceId,
      subjectId: "subject-a",
      permissions: ["sessions:create"],
      metadata: {},
    };
    await expect(
      createSessionForRequest({} as never, grant, workspaceId, {
        initialMessage: "attempt reserved metadata",
        metadata: { [OPENGENI_SLACK_BOT_SESSION_METADATA_KEY]: connectionId },
      }),
    ).rejects.toThrow("reserved for scheduler routing");
  });

  test("requires connections:read before a task may select a bot connection", async () => {
    const grant: AccessGrant = {
      accountId,
      workspaceId,
      subjectId: "subject-a",
      permissions: ["scheduled_tasks:manage"],
      metadata: {},
    };
    await expect(
      validateOpenGeniSlackBotConnectionSelection({} as never, grant, workspaceId, connectionId),
    ).rejects.toThrow("missing permission: connections:read");
  });
});
