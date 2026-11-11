import { expect, test } from "bun:test";
import type { McpPersonalConnectionDelegation } from "@opengeni/contracts";
import type { ConnectorActionPolicyHooks, ConnectorActionToolCall } from "@opengeni/runtime";
import { resolveConnectorActionPolicy, connectorActionPolicyDecision } from "@opengeni/db";
import { getSettings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";

import {
  personalSlackSendTargets,
  slackBotSendHasPerson,
  strictestDecision,
  withSlackBotSendApproval,
} from "../src/activities/agent-turn/slack-bot-send-approval";

/** Stands in for the attempt ledger: an explicit choice for the call, else its default. */
function ledger() {
  const prepared: { call: ConnectorActionToolCall; decision: "allow" | "ask" | "block" }[] = [];
  const begun: ConnectorActionToolCall[] = [];
  const policy: ConnectorActionPolicyHooks = {
    prepare: async (call) => {
      const resolved = resolveConnectorActionPolicy([], {
        connectionId: call.connectionId!,
        serverId: call.serverId,
        toolName: call.toolName,
        actionName: call.toolName,
        defaultDecision: call.defaultDecision ?? "allow",
      });
      if (!resolved.managed) throw new Error("unmanaged");
      const decision = connectorActionPolicyDecision(resolved);
      prepared.push({ call, decision });
      return { managed: true, decision, requestId: decision === "ask" ? "req-1" : undefined };
    },
    begin: async (call) => {
      begun.push(call);
      return { allowed: true, managed: true, requestId: "req-1" };
    },
    complete: async () => undefined,
  };
  return { prepared, begun, policy };
}

function sendCall(approvalId = "call-1"): ConnectorActionToolCall {
  // Exactly what the runtime builds for an opengeni tool in requireApproval.
  return {
    approvalId,
    connectionId: "session-mcp:opengeni:hash",
    serverId: "opengeni",
    toolName: "slack_bot_send_prepared_message",
    arguments: { messageId: "11111111-1111-4111-8111-111111111111" },
    reviewContext: { kind: "generic", title: "slack_bot_send_prepared_message" },
    approvalMode: "session_mcp",
    defaultDecision: "ask",
  };
}

function wrapped(input: {
  interactive: boolean | (() => Promise<boolean>);
  personal: "allow" | "ask" | "block" | null | Error;
  message?: { channelId: string; threadTimestamp?: string | null; text: string } | Error;
}) {
  const { prepared, begun, policy } = ledger();
  let reads = 0;
  const hooks = withSlackBotSendApproval(policy, {
    interactive: input.interactive,
    personalSlackSendDecision: async () => {
      reads += 1;
      if (input.personal instanceof Error) throw input.personal;
      return input.personal;
    },
    preparedMessage: async () => {
      if (input.message instanceof Error) throw input.message;
      return input.message ?? null;
    },
  });
  return { prepared, begun, hooks, reads: () => reads };
}

test("Ask first on the person's Slack sends makes an interactive bot send ask, naming the message", async () => {
  const { prepared, hooks } = wrapped({
    interactive: true,
    personal: "ask",
    message: { channelId: "C0HALCYON", text: "Launch moved to Thursday." },
  });
  const result = await hooks.prepare(sendCall());
  expect(result).toMatchObject({ managed: true, decision: "ask", requestId: "req-1" });
  expect(prepared[0]!.call).toMatchObject({
    approvalMode: "session_mcp",
    defaultDecision: "ask",
    reviewContext: {
      kind: "generic",
      title: "Send a Slack message as the Opengeni bot",
      targetFacts: [
        { label: "Channel", value: "C0HALCYON" },
        { label: "Message", value: "Launch moved to Thursday." },
      ],
    },
  });
});

test("a reply names its thread on the card", async () => {
  const { prepared, hooks } = wrapped({
    interactive: true,
    personal: "ask",
    message: { channelId: "C0HALCYON", threadTimestamp: "1730563200.000100", text: "Done." },
  });
  await hooks.prepare(sendCall());
  expect(prepared[0]!.call.reviewContext?.targetFacts).toEqual([
    { label: "Channel", value: "C0HALCYON" },
    { label: "Reply in thread", value: "1730563200.000100" },
    { label: "Message", value: "Done." },
  ]);
});

test("Block on the person's Slack sends blocks the bot send too", async () => {
  const { prepared, begun, hooks } = wrapped({ interactive: true, personal: "block" });
  expect(await hooks.prepare(sendCall())).toEqual({ managed: true, decision: "block" });
  expect(await hooks.begin(sendCall())).toEqual({
    allowed: false,
    managed: true,
    requestId: "call-1",
    reason: "blocked",
  });
  // Nothing reaches the ledger or the provider.
  expect(prepared).toEqual([]);
  expect(begun).toEqual([]);
});

test("a long message is cut to the card's limit", async () => {
  const { prepared, hooks } = wrapped({
    interactive: true,
    personal: "ask",
    message: { channelId: "C1", text: "x".repeat(1_000) },
  });
  await hooks.prepare(sendCall());
  const message = prepared[0]!.call.reviewContext?.targetFacts?.at(-1)?.value ?? "";
  expect(message.length).toBeLessThanOrEqual(256);
  expect(message.endsWith("…")).toBe(true);
});

test("the default policy keeps bot sends running at once", async () => {
  for (const personal of ["allow", null] as const) {
    const { prepared, hooks } = wrapped({ interactive: true, personal });
    expect(await hooks.prepare(sendCall())).toMatchObject({ managed: true, decision: "allow" });
    expect(prepared[0]!.call.approvalMode).toBeUndefined();
    expect(prepared[0]!.call.defaultDecision).toBe("allow");
  }
});

test("scheduled and unattended runs keep their behaviour and read no permission", async () => {
  for (const personal of ["ask", "block"] as const) {
    const { prepared, hooks, reads } = wrapped({ interactive: false, personal });
    expect(await hooks.prepare(sendCall())).toMatchObject({ decision: "allow" });
    expect(prepared[0]!.call.approvalMode).toBeUndefined();
    expect(reads()).toBe(0);
  }
});

test("whether a person is there is read at the first bot send, once per attempt", async () => {
  let checks = 0;
  const { hooks, reads } = wrapped({
    interactive: async () => {
      checks += 1;
      return false;
    },
    personal: "ask",
  });
  const app: ConnectorActionToolCall = { ...sendCall(), toolName: "admin_action_call" };
  await hooks.prepare(app);
  expect(checks).toBe(0);
  expect(await hooks.prepare(sendCall("call-1"))).toMatchObject({ decision: "allow" });
  expect(await hooks.prepare(sendCall("call-2"))).toMatchObject({ decision: "allow" });
  expect(checks).toBe(1);
  expect(reads()).toBe(0);
  // A failed check asks, as the chat itself would.
  const failed = wrapped({
    interactive: async () => {
      throw new Error("lineage unavailable");
    },
    personal: "ask",
  });
  expect(await failed.hooks.prepare(sendCall())).toMatchObject({ decision: "ask" });
});

test("a worker asks like the chat at the root of its chain", async () => {
  const root = (value: { rootUnattended: boolean; rootTurnScheduled: boolean } | null) => ({
    scheduled: false,
    unattended: false,
    chainRoot: async () => value,
  });
  // A top-level chat, and a worker of an attended chat's ordinary turn.
  expect(await slackBotSendHasPerson(root(null))).toBe(true);
  expect(
    await slackBotSendHasPerson(root({ rootUnattended: false, rootTurnScheduled: false })),
  ).toBe(true);
  // A worker handed a post by a scheduled turn or an unattended chat.
  expect(
    await slackBotSendHasPerson(root({ rootUnattended: false, rootTurnScheduled: true })),
  ).toBe(false);
  expect(
    await slackBotSendHasPerson(root({ rootUnattended: true, rootTurnScheduled: false })),
  ).toBe(false);
  // The session's own scheduled turn or unattended setting needs no lookup.
  let looked = false;
  const chainRoot = async () => {
    looked = true;
    return null;
  };
  expect(await slackBotSendHasPerson({ scheduled: true, unattended: false, chainRoot })).toBe(
    false,
  );
  expect(await slackBotSendHasPerson({ scheduled: false, unattended: true, chainRoot })).toBe(
    false,
  );
  expect(looked).toBe(false);
  // An unreadable root keeps this chat's own answer.
  expect(
    await slackBotSendHasPerson({
      scheduled: false,
      unattended: false,
      chainRoot: async () => {
        throw new Error("lineage unavailable");
      },
    }),
  ).toBe(true);
});

test("an unreadable permission asks where a person can answer", async () => {
  const { hooks } = wrapped({ interactive: true, personal: new Error("snapshot unavailable") });
  expect(await hooks.prepare(sendCall())).toMatchObject({ decision: "ask" });
  const failedMessage = wrapped({
    interactive: true,
    personal: "ask",
    message: new Error("message unreadable"),
  });
  // A failed message read still asks, with the plain card.
  expect(await failedMessage.hooks.prepare(sendCall())).toMatchObject({ decision: "ask" });
});

test("one call keeps one decision, and the permission is read once per attempt", async () => {
  const { prepared, hooks, reads } = wrapped({ interactive: true, personal: "ask" });
  await hooks.prepare(sendCall("call-1"));
  await hooks.begin(sendCall("call-1"));
  await hooks.prepare(sendCall("call-2"));
  expect(prepared.map(({ decision }) => decision)).toEqual(["ask", "ask"]);
  expect(reads()).toBe(1);
});

test("other tools, including bot preparation, pass through untouched", async () => {
  const { prepared, hooks, reads } = wrapped({ interactive: true, personal: "ask" });
  const prepare: ConnectorActionToolCall = {
    ...sendCall(),
    toolName: "slack_bot_prepare_message",
    approvalMode: undefined,
    defaultDecision: "allow",
  };
  await hooks.prepare(prepare);
  const app: ConnectorActionToolCall = { ...sendCall(), toolName: "admin_action_call" };
  await hooks.prepare(app);
  expect(prepared.map(({ call }) => call)).toEqual([prepare, app]);
  expect(reads()).toBe(0);
});

test("personal Slack sends are found on the turn's frozen Slack accounts only", () => {
  const settings = testSettings({
    mcpServers: [
      {
        id: "slack-me",
        url: "https://mcp.slack.com/mcp",
        connectionRef: { providerDomain: "slack.com", kind: "oauth2", subjectScope: "subject" },
      },
      {
        id: "slack-strict",
        url: "https://mcp.slack.com/mcp",
        requireApproval: ["slack_send_message"],
        connectionRef: { providerDomain: "slack.com", kind: "oauth2", subjectScope: "subject" },
      },
      {
        id: "linear",
        url: "https://mcp.linear.app/mcp",
        connectionRef: { providerDomain: "linear.app", kind: "oauth2", subjectScope: "subject" },
      },
    ],
  } as never);
  const delegation = (serverId: string, providerDomain: string): McpPersonalConnectionDelegation =>
    ({
      serverId,
      connectionId: crypto.randomUUID(),
      ownerSubjectId: "user:anna",
      providerDomain,
      kind: "oauth2",
    }) as McpPersonalConnectionDelegation;
  const me = delegation("slack-me", "slack.com");
  const strict = delegation("slack-strict", "slack.com");
  const targets = personalSlackSendTargets(
    [me, strict, delegation("linear", "linear.app"), delegation("missing", "slack.com")],
    settings,
  );
  expect(targets).toEqual([
    { connectionId: me.connectionId, serverId: "slack-me", defaultDecision: "allow" },
    { connectionId: strict.connectionId, serverId: "slack-strict", defaultDecision: "ask" },
  ]);
  expect(personalSlackSendTargets([], settings)).toEqual([]);
});

test("the strictest personal decision wins", () => {
  expect(strictestDecision([])).toBeNull();
  expect(strictestDecision(["allow"])).toBe("allow");
  expect(strictestDecision(["allow", "ask"])).toBe("ask");
  expect(strictestDecision(["ask", "block", "allow"])).toBe("block");
});

test("the first-party server routes bot sends through the per-call approval", () => {
  const opengeni = getSettings({}).mcpServers.find((server) => server.id === "opengeni");
  expect(opengeni?.requireApproval).toEqual([
    "admin_action_call",
    "slack_bot_send_prepared_message",
    "github_repository_attach",
  ]);
});
