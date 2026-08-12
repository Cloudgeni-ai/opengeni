import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SLACK_TASK_POLICY,
  evaluateSlackTaskPolicy,
  type SlackTaskPolicyContent,
  type SlackTaskPolicyConversationFacts,
  type SlackTaskPolicyInitiatorFacts,
} from "../src/slack-task-policy";

const policy: SlackTaskPolicyContent = {
  ...DEFAULT_SLACK_TASK_POLICY,
  allowedTeamIds: ["T_HOME", "T_EXTERNAL"],
  allowedConversationIds: ["C_SHARED"],
  allowExternalInitiators: true,
  sharedConversationMode: "private_handoff",
  resultPublicationMode: "approval_required",
};

const conversation: SlackTaskPolicyConversationFacts = {
  installationTeamId: "T_HOME",
  conversationId: "C_SHARED",
  contextTeamId: "T_HOME",
  connectedTeamIds: ["T_EXTERNAL"],
  sharedTeamIds: ["T_HOME", "T_EXTERNAL"],
  isShared: true,
  isExternallyShared: true,
  isOrgShared: false,
  isPendingExternallyShared: false,
  isMpim: false,
};

describe("Slack task policy", () => {
  test("leaves ordinary conversations on the existing path without a policy", () => {
    expect(
      evaluateSlackTaskPolicy({
        policy: null,
        conversation: { ...conversation, isShared: false, isExternallyShared: false },
        initiator: { teamId: null, isGuest: null, isExternal: null },
      }),
    ).toEqual({ disposition: "ordinary", publication: "allow", reason: "ordinary_conversation" });
  });

  test("defaults shared conversations to fail closed", () => {
    expect(
      evaluateSlackTaskPolicy({
        policy: null,
        conversation,
        initiator: { teamId: "T_EXTERNAL", isGuest: false, isExternal: true },
      }),
    ).toEqual({ disposition: "deny", publication: "never", reason: "policy_missing" });
  });

  test("allows an exact shared conversation only as a private handoff", () => {
    expect(
      evaluateSlackTaskPolicy({
        policy,
        conversation,
        initiator: { teamId: "T_EXTERNAL", isGuest: false, isExternal: true },
      }),
    ).toEqual({
      disposition: "private_handoff",
      publication: "approval_required",
      reason: "allowed",
    });
  });

  test.each<
    [
      string,
      {
        conversation?: Partial<SlackTaskPolicyConversationFacts>;
        initiator?: SlackTaskPolicyInitiatorFacts;
      },
    ]
  >([
    ["unknown conversation", { conversation: { ...conversation, conversationId: "C_OTHER" } }],
    [
      "unknown connected team",
      { conversation: { ...conversation, connectedTeamIds: ["T_OTHER"] } },
    ],
    ["missing connected-team facts", { conversation: { ...conversation, connectedTeamIds: null } }],
    ["guest", { initiator: { teamId: "T_HOME", isGuest: true, isExternal: false } }],
    ["MPIM", { conversation: { ...conversation, isMpim: true } }],
  ])("denies %s", (_label, override) => {
    const decision = evaluateSlackTaskPolicy({
      policy,
      conversation: { ...conversation, ...override.conversation },
      initiator: {
        teamId: "T_EXTERNAL",
        isGuest: false,
        isExternal: true,
        ...override.initiator,
      },
    });
    expect(decision.disposition).toBe("deny");
    expect(decision.publication).toBe("never");
  });
});
