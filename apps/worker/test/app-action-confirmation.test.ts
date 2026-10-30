import { expect, test } from "bun:test";
import type { ConnectorActionPolicyHooks, ConnectorActionToolCall } from "@opengeni/runtime";

import {
  withAppActionApprovalTitle,
  withAppActionConfirmation,
  type AppActionAuthorityKind,
} from "../src/activities/agent-turn/app-action-confirmation";
import { prefixedMcpToolName } from "@opengeni/runtime";
import { SEEDANCE_2_5_MODEL_ID } from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing/settings";

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
      return { kind, subjectId: "user:anna", permissions: [] };
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

test("a billing portal link waits for the person too: it can change the payment method or plan", async () => {
  const { seen, hooks } = wrapped("confirm");
  await hooks.prepare(appCall("call-1", { id: "createBillingPortalSession", body: {} }));
  expect(seen[0]!.call).toMatchObject({
    approvalMode: "session_mcp",
    defaultDecision: "ask",
    reviewContext: {
      title: "Open your billing page? It can change your payment method or plan.",
    },
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
    // Opening a checkout charges nothing: the page itself asks.
    ["confirm", { id: "createBillingCheckout", body: { amountUsd: 20 } }],
    ["confirm", { id: "POST /v1/billing/subscription/checkout", body: {} }],
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

test("turning on video paid with credits asks once, with the price on the card and the event", async () => {
  const settings = testSettings({
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    vercelAiGatewayApiKey: "gateway-key",
    billingMode: "stripe",
  });
  const turnOn = {
    id: "updateVideoGenerationPolicy",
    pathParameters: { workspaceId: "ws-1" },
    body: {
      expectedRevision: 7,
      fundingSource: "opengeni_credits",
      enabledModelIds: [SEEDANCE_2_5_MODEL_ID],
      defaultModelId: SEEDANCE_2_5_MODEL_ID,
    },
  };
  const title =
    "Let every chat in this workspace make videos? A 5-second 480p clip costs $0.78 (720p: $1.75) in Opengeni credits.";
  const { seen, policy } = recording();
  const hooks = withAppActionConfirmation(policy, {
    workspaceId: "ws-1",
    sessionId: "chat-1",
    settings,
    authority: async () => ({ kind: "confirm", subjectId: "user:bendik", permissions: [] }),
  });
  await hooks.prepare(appCall("call-video", turnOn));
  expect(seen[0]!.call).toMatchObject({ defaultDecision: "ask", reviewContext: { title } });
  const approval = {
    id: "call-video",
    name: prefixedMcpToolName("opengeni", "admin_action_call"),
    rawItem: { arguments: JSON.stringify(turnOn) },
    display: { toolName: "admin_action_call", title: "Run an app action" },
  };
  expect(
    withAppActionApprovalTitle(approval, { workspaceId: "ws-1", sessionId: "chat-1", settings }),
  ).toMatchObject({ display: { title } });
  // Turning it off has nothing to pay for.
  const off = { ...turnOn, body: { ...turnOn.body, enabledModelIds: [], defaultModelId: null } };
  await hooks.prepare(appCall("call-off", off));
  expect(seen[1]!.call).toMatchObject({
    reviewContext: { title: "Turn off video for every chat in this workspace?" },
  });
});

const removal = (connectionId: string) => ({
  id: "deleteConnection",
  pathParameters: { workspaceId: "ws-1", connectionId },
  body: { expectedVersion: 1 },
});

test("each parallel removal's card names its own connection, read by the server, and the event says the same", async () => {
  const { seen, policy } = recording();
  const looked: unknown[] = [];
  const found = {
    "c-gmail": { name: "Gmail", account: "bendik@cloudgeni.ai", added: "14 Oct 2026, 07:41 UTC" },
    "c-linear": { name: "Linear", account: "Bendik · Cloudgeni", added: "2 Oct 2026, 10:12 UTC" },
  } as const;
  const cards = new Map();
  const hooks = withAppActionConfirmation(policy, {
    workspaceId: "ws-1",
    sessionId: "chat-1",
    authority: async () => ({ kind: "confirm", subjectId: "user:bendik", permissions: [] }),
    targets: async (args, reader) => {
      looked.push(args);
      // Read as the person the live check found, never a shared guess.
      expect(reader).toEqual({ subjectId: "user:bendik", permissions: [] });
      const id = (args as { pathParameters: { connectionId: keyof typeof found } }).pathParameters
        .connectionId;
      const hit = found[id];
      return hit
        ? {
            connectionId: {
              kind: "connection",
              name: hit.name,
              account: hit.account,
              facts: [{ label: "Added", value: hit.added }],
            },
          }
        : { connectionId: { kind: "connection" } };
    },
    cards,
  });
  // The agent's own words in the call never reach the card.
  const spoofed = { ...removal("c-gmail"), title: "Remove an unused test connection?" };
  await Promise.all([
    hooks.prepare(appCall("call-1", spoofed)),
    hooks.prepare(appCall("call-2", removal("c-linear"))),
    hooks.prepare(appCall("call-3", removal("c-gone"))),
  ]);
  const byId = new Map(seen.map((entry) => [entry.call.approvalId, entry.call.reviewContext]));
  expect(byId.get("call-1")).toMatchObject({
    title: "Remove the Gmail connection for bendik@cloudgeni.ai?",
    targetFacts: [{ label: "Added", value: "14 Oct 2026, 07:41 UTC" }],
  });
  expect(byId.get("call-2")).toMatchObject({
    title: "Remove the Linear connection for Bendik · Cloudgeni?",
  });
  // Not there: says so, and names nothing.
  expect(byId.get("call-3")).toMatchObject({
    title: "Delete connection in this workspace?",
    targetFacts: [{ label: "Connection", value: "Not found. It may have been removed already." }],
  });
  // Looked up once per call, even across preparation and execution.
  await hooks.begin(appCall("call-1", spoofed));
  expect(looked).toHaveLength(3);
  const approval = {
    type: "tool_approval_item",
    rawItem: { callId: "call-1", name: prefixedMcpToolName("opengeni", "admin_action_call") },
    name: prefixedMcpToolName("opengeni", "admin_action_call"),
    arguments: JSON.stringify(spoofed),
  };
  expect(
    withAppActionApprovalTitle(approval, { workspaceId: "ws-1", sessionId: "chat-1", cards }),
  ).toMatchObject({
    display: { title: "Remove the Gmail connection for bendik@cloudgeni.ai?" },
    // Beside the display, which older clients parse strictly.
    targetFacts: [{ label: "Added", value: "14 Oct 2026, 07:41 UTC" }],
  });
  expect(
    (
      withAppActionApprovalTitle(approval, { workspaceId: "ws-1", sessionId: "chat-1", cards }) as {
        display: Record<string, unknown>;
      }
    ).display,
  ).not.toHaveProperty("facts");
});

test("without a person to read as, nothing is looked up and the card keeps its plain question", async () => {
  const { seen, policy } = recording();
  let looked = 0;
  const hooks = withAppActionConfirmation(policy, {
    workspaceId: "ws-1",
    sessionId: "chat-1",
    authority: async () => ({ kind: "confirm" }),
    targets: async () => {
      looked += 1;
      return { connectionId: { kind: "connection", name: "Gmail" } };
    },
  });
  await hooks.prepare(appCall("call-1", removal("c-gmail")));
  expect(looked).toBe(0);
  expect(seen[0]!.call).toMatchObject({
    reviewContext: { title: "Delete connection in this workspace?" },
  });
});

test("a failed lookup keeps the plain question; the card still asks", async () => {
  const { seen, policy } = recording();
  const hooks = withAppActionConfirmation(policy, {
    workspaceId: "ws-1",
    sessionId: "chat-1",
    authority: async () => ({ kind: "confirm", subjectId: "user:bendik", permissions: [] }),
    targets: async () => {
      throw new Error("database unavailable");
    },
  });
  await hooks.prepare(appCall("call-1", removal("c-gmail")));
  expect(seen[0]!.call).toMatchObject({
    defaultDecision: "ask",
    reviewContext: { title: "Delete connection in this workspace?" },
  });
  expect(seen[0]!.call.reviewContext).not.toHaveProperty("targetFacts");
});
