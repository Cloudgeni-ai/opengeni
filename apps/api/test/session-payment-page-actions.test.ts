import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SESSION_EVENT_PRESENTED_APP_ACTIONS, type AccessGrant } from "@opengeni/contracts";

import {
  createSessionAdminReach,
  registerSessionAdminAccessTools,
  type SessionAppActionAuthority,
} from "../src/mcp/session-admin-access-tools";

/* Opening a checkout charges nothing, so the chat runs it without a
   confirmation, and an embed may run it too; the route still decides whether
   this person may pay. A billing portal link can change the payment method or
   plan, so it keeps both safeguards. Each result tells the agent what the chat
   does with that kind of page. */

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

const grant = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() } as AccessGrant;

function tools(authority: SessionAppActionAuthority, options: { canPay?: boolean } = {}) {
  const requests: Request[] = [];
  const real = createSessionAdminReach({
    db: {} as never,
    grant,
    sessionId: "chat-1",
    turnId: "turn-1",
    access: {
      origin: "http://opengeni.test",
      dispatch: async (request) => {
        requests.push(request);
        if (options.canPay === false) {
          return Response.json({ error: "missing permission: billing:manage" }, { status: 403 });
        }
        if (request.url.endsWith("/v1/billing/checkout")) {
          return Response.json({
            checkoutSessionId: "cs_test_a1",
            url: "https://checkout.stripe.com/c/pay/cs_test_a1#fragment",
            amountUsd: 20,
          });
        }
        if (
          `${request.method} ${new URL(request.url).pathname}` ===
          SESSION_EVENT_PRESENTED_APP_ACTIONS.createBillingPortalSession.route
        ) {
          return Response.json({ url: "https://billing.stripe.com/p/session/x" });
        }
        return Response.json({ error: "forbidden" }, { status: 403 });
      },
    },
    authorize: async () => undefined,
  });
  const handlers = new Map<string, Handler>();
  registerSessionAdminAccessTools({
    server: {
      registerTool: (name: string, _config: unknown, handler: Handler) => {
        handlers.set(name, handler);
      },
    } as never,
    // Never read: no confirmation is looked up for a payment page.
    db: {} as never,
    grant,
    sessionId: "chat-1",
    attempt: { turnId: "turn-1", attemptId: "attempt-1" },
    reach: { ...real, authority: async () => authority },
  });
  return { call: handlers.get("admin_action_call")!, requests };
}

const checkout = {
  id: "createBillingCheckout",
  pathParameters: {},
  query: {},
  body: { amountUsd: 20 },
};

test("a checkout runs at once, from a chat or an embed, and says the chat shows it", async () => {
  for (const kind of ["confirm", "read_only"] as const) {
    const { call, requests } = tools({
      kind,
      subjectId: `user:${crypto.randomUUID()}`,
      permissions: ["workspace:read", "billing:read", "billing:manage"],
    });
    const result = await call(checkout);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toMatchObject({
      status: 200,
      body: { url: "https://checkout.stripe.com/c/pay/cs_test_a1#fragment" },
    });
    expect(parsed.note).toContain("The chat shows the person this page as a button");
    expect(parsed.note).toContain("confirms there with their new balance");
    expect(parsed.note).toContain("cs_test_");
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /v1/billing/checkout"],
    );
  }
});

test("an embed still can't change anything else, nor open the billing portal", async () => {
  const { call, requests } = tools({
    kind: "read_only",
    subjectId: `user:${crypto.randomUUID()}`,
    permissions: ["workspace:read", "billing:read", "billing:manage"],
  });
  for (const args of [
    {
      id: "createOrganizationInvitation",
      pathParameters: { organizationId: grant.accountId },
      query: {},
      body: { email: "anna@example.com" },
    },
    { id: "createBillingPortalSession", pathParameters: {}, query: {} },
    { id: "POST /v1/billing/subscription/portal", pathParameters: {}, query: {} },
  ]) {
    const refused = await call(args);
    expect((refused.content[0] as { text: string }).text).toStartWith(
      "Nothing was run: this chat was opened through",
    );
  }
  expect(requests).toHaveLength(0);
});

test("a billing portal link says it's only for this person, and a refused page has no note", async () => {
  const { call } = tools({ kind: "full_access", subjectId: `user:${crypto.randomUUID()}` });
  const portal = await call({ id: "createBillingPortalSession", pathParameters: {}, query: {} });
  expect(portal.isError).toBeUndefined();
  const note: string = JSON.parse((portal.content[0] as { text: string }).text).note;
  expect(note).toContain("give it only to this person");
  expect(note).not.toContain("like any other");
  expect(note).not.toContain("confirms");

  // A 403 that isn't a missing billing permission keeps the route's own answer.
  const refused = await call({
    id: "createSubscriptionCheckout",
    pathParameters: {},
    query: {},
    body: {},
  });
  expect(refused.isError).toBe(true);
  const parsed = JSON.parse((refused.content[0] as { text: string }).text);
  expect(parsed).toMatchObject({ status: 403, body: { error: "forbidden" } });
  expect(parsed.note).toBeUndefined();
});

const PLAIN_REFUSAL =
  "Nothing was run: the person who sent this message can't manage this organization's billing, so they can't buy credits here. Tell them an owner or admin of the organization can add credits in the app.";

test("a member without billing rights gets a plain refusal, in the app and through the SDK proxy", async () => {
  // A person of the organization who can use this chat's workspace but not
  // manage billing: the route refuses with a permission name that means
  // nothing to them. In the web app the turn runs with a confirmation;
  // through the SDK session proxy it runs read-only.
  for (const kind of ["confirm", "read_only"] as const) {
    const { call, requests } = tools(
      {
        kind,
        subjectId: `user:${crypto.randomUUID()}`,
        permissions: ["workspace:read", "sessions:create", "sessions:control"],
      },
      { canPay: false },
    );
    const refused = await call(checkout);
    expect(refused.isError).toBe(true);
    expect((refused.content[0] as { text: string }).text).toBe(PLAIN_REFUSAL);
    expect(requests).toHaveLength(1);
  }
});

test("someone who uses Opengeni through another product gets that refusal first, before anything runs", async () => {
  // A real embed person is an external user with one workspace: billing is
  // never theirs, so they are told it isn't available here, never sent to the app.
  for (const kind of ["full_access", "read_only"] as const) {
    const { call, requests } = tools(
      {
        kind,
        subjectId: `external_user:${crypto.randomUUID()}`,
        permissions: ["workspace:read", "sessions:create", "sessions:control"],
      },
      { canPay: false },
    );
    const refused = await call(checkout);
    expect(refused.isError).toBe(true);
    const text = (refused.content[0] as { text: string }).text;
    expect(text).toStartWith(
      "Nothing was run: this person uses Opengeni through another product, so app actions reach only this chat's workspace",
    );
    expect(text).toContain("billing");
    expect(text).not.toBe(PLAIN_REFUSAL);
    expect(text).not.toContain("in the app");
    expect(requests).toHaveLength(0);
  }
});
