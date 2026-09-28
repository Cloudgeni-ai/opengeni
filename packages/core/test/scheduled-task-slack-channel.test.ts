import { describe, expect, test } from "bun:test";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import {
  isAuthenticatedPersonAuthorization,
  validateScheduledTaskSlackChannel,
  withScheduledSlackBotPostingTools,
  type AccessGrantAuthorization,
} from "../src";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const otherConnectionId = "44444444-4444-4444-8444-444444444444";
const PERMISSIONS: Permission[] = [
  "scheduled_tasks:manage",
  "connections:read",
  "connections:write",
];

function person(permissions: Permission[] = PERMISSIONS): AccessGrantAuthorization {
  const grant: AccessGrant = {
    accountId,
    workspaceId,
    subjectId: "user:person",
    permissions,
    principalKind: "human_session",
    metadata: {},
  };
  return {
    grant,
    accountGrant: null,
    authenticatedSubjectId: grant.subjectId,
    contextIntegrity: true,
    canonicalManagedHumanSession: true,
    canonicalLocalHumanSession: false,
  };
}

function agentAttempt(): AccessGrantAuthorization {
  const authorization = person();
  return {
    ...authorization,
    grant: {
      ...authorization.grant,
      subjectId: "worker:first-party-mcp",
      principalKind: "agent_attempt",
      metadata: { sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() },
    },
    authenticatedSubjectId: "worker:first-party-mcp",
    canonicalManagedHumanSession: false,
  };
}

function recordingVerifier() {
  const calls: { connectionId: string; channelId: string }[] = [];
  return {
    calls,
    verify: async (input: { connectionId: string; channelId: string }) => {
      calls.push(input);
    },
  };
}

async function validate(
  overrides: Partial<Parameters<typeof validateScheduledTaskSlackChannel>[0]> & {
    authorization?: AccessGrantAuthorization;
  },
) {
  const authorization = overrides.authorization ?? person();
  await validateScheduledTaskSlackChannel({
    grant: authorization.grant,
    authorization,
    previous: null,
    next: { slackBotConnectionId: connectionId, slackBotChannelId: "C0SCHED01" },
    runMode: "new_session_per_run",
    reusableSessionLive: false,
    ...overrides,
  });
}

describe("scheduled task Slack channel", () => {
  test("a person with connections:write chooses a verified channel", async () => {
    const verifier = recordingVerifier();
    await validate({ verifySlackChannel: verifier.verify });
    expect(verifier.calls).toEqual([{ connectionId, channelId: "C0SCHED01" }]);
  });

  test("an agent, a service, or an API key cannot choose or change it", async () => {
    const verifier = recordingVerifier();
    await expect(
      validate({ authorization: agentAttempt(), verifySlackChannel: verifier.verify }),
    ).rejects.toMatchObject({ status: 403 });
    const service = person();
    service.grant = { ...service.grant, principalKind: "service" };
    await expect(
      validate({ authorization: service, verifySlackChannel: verifier.verify }),
    ).rejects.toMatchObject({ status: 403 });
    const apiKey = person();
    apiKey.grant = { ...apiKey.grant, principalKind: "api_key" };
    await expect(
      validate({ authorization: apiKey, verifySlackChannel: verifier.verify }),
    ).rejects.toMatchObject({ status: 403 });
    // No authorization at all (for example the first-party MCP path).
    await expect(
      validateScheduledTaskSlackChannel({
        grant: agentAttempt().grant,
        previous: { slackBotConnectionId: connectionId, slackBotChannelId: "C0SCHED01" },
        next: { slackBotConnectionId: connectionId, slackBotChannelId: "C0OTHER01" },
        runMode: "new_session_per_run",
        reusableSessionLive: false,
        verifySlackChannel: verifier.verify,
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Moving the same channel to another bot connection is also a new choice.
    await expect(
      validate({
        authorization: agentAttempt(),
        previous: { slackBotConnectionId: otherConnectionId, slackBotChannelId: "C0SCHED01" },
        verifySlackChannel: verifier.verify,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(verifier.calls).toEqual([]);
  });

  test("keeping or clearing the existing channel needs no new proof", async () => {
    const verifier = recordingVerifier();
    const existing = { slackBotConnectionId: connectionId, slackBotChannelId: "C0SCHED01" };
    await validate({ authorization: agentAttempt(), previous: existing });
    await validate({
      authorization: agentAttempt(),
      previous: existing,
      next: { slackBotConnectionId: connectionId },
    });
    await validate({ authorization: agentAttempt(), previous: existing, next: {} });
    expect(verifier.calls).toEqual([]);
  });

  test("requires connections:write, a bot connection, a verifier, and its own chats", async () => {
    const verifier = recordingVerifier();
    await expect(
      validate({
        authorization: person(["scheduled_tasks:manage", "connections:read"]),
        verifySlackChannel: verifier.verify,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      validate({ next: { slackBotChannelId: "C0SCHED01" }, verifySlackChannel: verifier.verify }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      validate({ runMode: "existing_session", verifySlackChannel: verifier.verify }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(validate({})).rejects.toMatchObject({ status: 422 });
    expect(verifier.calls).toEqual([]);
  });

  test("a live reusable chat cannot turn posting on or off", async () => {
    const verifier = recordingVerifier();
    await expect(
      validate({ reusableSessionLive: true, verifySlackChannel: verifier.verify }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      validate({
        reusableSessionLive: true,
        previous: { slackBotConnectionId: connectionId, slackBotChannelId: "C0SCHED01" },
        next: { slackBotConnectionId: connectionId },
      }),
    ).rejects.toMatchObject({ status: 409 });
    // Moving between channels keeps the chat's tools, so it is allowed.
    await validate({
      reusableSessionLive: true,
      previous: { slackBotConnectionId: connectionId, slackBotChannelId: "C0OTHER01" },
      verifySlackChannel: verifier.verify,
    });
    expect(verifier.calls).toHaveLength(1);
  });

  test("a verifier refusal stops the save", async () => {
    await expect(
      validate({
        verifySlackChannel: async () => {
          throw new Error("not a member");
        },
      }),
    ).rejects.toThrow("not a member");
  });

  test("person detection rejects service provenance and attempt claims", () => {
    expect(isAuthenticatedPersonAuthorization(person())).toBe(true);
    expect(isAuthenticatedPersonAuthorization(undefined)).toBe(false);
    expect(isAuthenticatedPersonAuthorization({ ...person(), contextIntegrity: false })).toBe(
      false,
    );
    const claimed = person();
    claimed.grant = { ...claimed.grant, metadata: { attemptId: crypto.randomUUID() } };
    expect(isAuthenticatedPersonAuthorization(claimed)).toBe(false);
    const provenance = person();
    provenance.grant = {
      ...provenance.grant,
      serviceInitiator: { kind: "service", subjectId: "host" },
    } as AccessGrant;
    expect(isAuthenticatedPersonAuthorization(provenance)).toBe(false);
  });

  test("posting tools are added only with a chosen channel and under the ceiling", () => {
    const base = ["goal_set" as const];
    const allowed = [
      "goal_set" as const,
      "slack_bot_prepare_message" as const,
      "slack_bot_send_prepared_message" as const,
    ];
    expect(
      withScheduledSlackBotPostingTools(
        base,
        { slackBotConnectionId: connectionId, slackBotChannelId: "C0SCHED01" },
        allowed,
      ),
    ).toEqual(["goal_set", "slack_bot_prepare_message", "slack_bot_send_prepared_message"]);
    expect(
      withScheduledSlackBotPostingTools(base, { slackBotConnectionId: connectionId }, allowed),
    ).toEqual(["goal_set"]);
    expect(
      withScheduledSlackBotPostingTools(
        base,
        { slackBotConnectionId: connectionId, slackBotChannelId: "C0SCHED01" },
        ["goal_set"],
      ),
    ).toEqual(["goal_set"]);
  });
});
