import { expect, test } from "bun:test";
import type { ConnectorActionPolicyHooks, ConnectorActionToolCall } from "@opengeni/runtime";

import {
  withAppActionApprovalTitle,
  withAppActionConfirmation,
  type AppActionAuthorityKind,
} from "../src/activities/agent-turn/app-action-confirmation";
import { prefixedMcpToolName } from "@opengeni/runtime";

function recording() {
  const seen: { stage: string; call: ConnectorActionToolCall }[] = [];
  const policy: ConnectorActionPolicyHooks = {
    preview: async (call) => {
      seen.push({ stage: "preview", call });
      return { managed: false, decision: "unmanaged" } as never;
    },
    prepare: async (call) => {
      seen.push({ stage: "prepare", call });
      return { managed: false, decision: "unmanaged" } as never;
    },
    begin: async (call) => {
      seen.push({ stage: "begin", call });
      return { allowed: true, managed: false } as never;
    },
    complete: async () => undefined,
  };
  return { seen, policy };
}

function appCall(approvalId: string, args: unknown): ConnectorActionToolCall {
  return {
    approvalId,
    connectionId: "session-mcp:opengeni:hash",
    serverId: "opengeni",
    toolName: "admin_action_call",
    arguments: args,
    reviewContext: { kind: "generic", title: "Run an app action" },
    defaultDecision: "allow",
  };
}

const invite = {
  id: "createOrganizationInvitation",
  pathParameters: { organizationId: "org" },
  body: { email: "anna@example.com" },
};

function wrapped(kind: AppActionAuthorityKind) {
  const { seen, policy } = recording();
  let checks = 0;
  const hooks = withAppActionConfirmation(policy, {
    workspaceId: "ws-1",
    sessionId: "chat-1",
    authority: async () => {
      checks += 1;
      return kind;
    },
  });
  return { seen, hooks, checks: () => checks };
}

test("a change without full access waits for the person, with a plain question", async () => {
  const { seen, hooks } = wrapped("confirm");
  await hooks.prepare(appCall("call-1", invite));
  expect(seen[0]!.call).toMatchObject({
    approvalMode: "session_mcp",
    defaultDecision: "ask",
    reviewContext: { kind: "generic", title: "Invite anna@example.com to your organization?" },
  });
});

test("reads, full access, and whatever the API refuses run without a card", async () => {
  for (const [kind, args] of [
    ["confirm", { id: "getMyUsage" }],
    ["full_access", invite],
    // A read-only embed's change and a secret are refused whatever the
    // answer, so nobody is asked to allow them.
    ["read_only", invite],
    ["confirm", { id: "createApiKey", pathParameters: { workspaceId: "ws-1" } }],
    ["unavailable", invite],
    // Opening a payment page charges nothing: the page itself asks.
    ["confirm", { id: "createBillingCheckout", body: { amountUsd: 20 } }],
    ["confirm", { id: "createBillingPortalSession", body: {} }],
  ] as const) {
    const { seen, hooks } = wrapped(kind);
    await hooks.prepare({ ...appCall("call-1", args), approvalMode: "session_mcp" });
    expect(seen[0]!.call.defaultDecision).toBe("allow");
    expect(seen[0]!.call.approvalMode).toBeUndefined();
    expect(seen[0]!.call.reviewContext?.title).toBe("Run an app action");
  }
});

test("one call keeps its first decision through preview, prepare and begin", async () => {
  const { seen, hooks, checks } = wrapped("confirm");
  const call = appCall("call-1", invite);
  await hooks.preview!(call);
  await hooks.prepare(call);
  await hooks.begin(call);
  expect(checks()).toBe(1);
  expect(seen.map((entry) => entry.call.defaultDecision)).toEqual(["ask", "ask", "ask"]);
});

test("every other tool passes through untouched", async () => {
  const { seen, hooks, checks } = wrapped("confirm");
  const other = { ...appCall("call-1", invite), serverId: "pm", toolName: "admin_action_call" };
  const search = { ...appCall("call-2", { query: "invite" }), toolName: "admin_actions_search" };
  await hooks.prepare(other);
  await hooks.prepare(search);
  expect(seen.map((entry) => entry.call)).toEqual([other, search]);
  expect(checks()).toBe(0);
});

test("the pending approval event carries the same plain question for every surface", () => {
  const chat = { workspaceId: "ws-1", sessionId: "chat-1" };
  const approval = {
    id: "call-1",
    name: prefixedMcpToolName("opengeni", "admin_action_call"),
    rawItem: { arguments: JSON.stringify(invite) },
    display: { toolName: "admin_action_call", title: "Run an app action" },
  };
  expect(withAppActionApprovalTitle(approval, chat)).toMatchObject({
    id: "call-1",
    display: {
      toolName: "admin_action_call",
      title: "Invite anna@example.com to your organization?",
    },
  });
  // Another server's tool of the same name keeps its own presentation.
  const other = { ...approval, name: prefixedMcpToolName("pm", "admin_action_call") };
  expect(withAppActionApprovalTitle(other, chat)).toBe(other);
});
