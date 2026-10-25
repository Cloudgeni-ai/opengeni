import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AccessGrant } from "@opengeni/contracts";

import {
  createSessionAdminReach,
  registerSessionAdminAccessTools,
  type SessionAppActionAuthority,
} from "../src/mcp/session-admin-access-tools";

/* Opening a payment page charges nothing, so the chat runs it without a
   confirmation, and an embed may run it too; the route still decides whether
   this person may pay. Its result tells the agent the chat shows the page. */

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

const grant = { accountId: crypto.randomUUID(), workspaceId: crypto.randomUUID() } as AccessGrant;

function tools(authority: SessionAppActionAuthority) {
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
        if (request.url.endsWith("/v1/billing/checkout")) {
          return Response.json({
            checkoutSessionId: "cs_test_a1",
            url: "https://checkout.stripe.com/c/pay/cs_test_a1#fragment",
            amountUsd: 20,
          });
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
    expect(parsed.note).toContain("cs_test_");
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /v1/billing/checkout"],
    );
  }
});

test("an embed still can't change anything else, and a refused checkout carries no note", async () => {
  const { call, requests } = tools({
    kind: "read_only",
    subjectId: `user:${crypto.randomUUID()}`,
    permissions: ["workspace:read", "billing:read", "billing:manage"],
  });
  const invite = await call({
    id: "createOrganizationInvitation",
    pathParameters: { organizationId: grant.accountId },
    query: {},
    body: { email: "anna@example.com" },
  });
  expect((invite.content[0] as { text: string }).text).toStartWith(
    "Nothing was run: this chat was opened through",
  );
  expect(requests).toHaveLength(0);

  const portal = await call({ id: "createBillingPortalSession", pathParameters: {}, query: {} });
  expect(portal.isError).toBe(true);
  const parsed = JSON.parse((portal.content[0] as { text: string }).text);
  expect(parsed.status).toBe(403);
  expect(parsed.note).toBeUndefined();
});
