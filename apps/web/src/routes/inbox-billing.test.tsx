import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { BillingCreditNotification, ListInboxResponse } from "@opengeni/sdk";
import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { inboxStoreFor, inboxAttentionCount } from "@opengeni/react/app/lib/inbox";
import { actRun, registerDom, renderComponent } from "../../../../packages/react/test/render-hook";
import { InboxRoute } from "./inbox";

registerDom();
const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherWorkspaceId = "33333333-3333-4333-8333-333333333333";
const notice: BillingCreditNotification = {
  id: "44444444-4444-4444-8444-444444444444",
  accountId,
  kind: "low_balance",
  eventType: "billing.credits.low_balance",
  read: false,
  details: { availableBalanceMicros: 5_000_000 },
  createdAt: "2026-11-03T08:00:00Z",
  action: {
    label: "Manage billing",
    path: `/workspaces/${workspaceId}/organization?section=billing`,
  },
};

test("billing remains reachable when a workspace filter outlives the final chat item", async () => {
  let data: ListInboxResponse = {
    items: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        workspaceId: otherWorkspaceId,
        sessionId: "66666666-6666-4666-8666-666666666666",
        sessionTitle: "Research",
        kind: "notification",
        sourceKey: "research-ready",
        title: "Research is ready",
        subtitle: "",
        body: "Your summary is ready.",
        unread: false,
        snoozedUntil: null,
        choices: [],
        facts: [],
        link: null,
        eventSequence: null,
        urgency: "normal",
        status: "open",
        resolvedAt: null,
        createdAt: notice.createdAt,
        updatedAt: notice.createdAt,
      },
    ],
    billingNotifications: [notice],
    unreadCount: 0,
    needsYouCount: 0,
  };
  const context = {
    client: {
      listInbox: async () => data,
      getInboxSettings: async () => ({ tidyPolicy: "own_sessions" }),
      listWorkspaceMembers: async () => [],
      getMemberNotifications: async () => ({ allowOthers: false }),
    },
    accessKeyVersion: 0,
    authSession: null,
    accessContext: {
      mode: "managed",
      subjectId: "user:owner",
      defaultAccountId: accountId,
      defaultWorkspaceId: workspaceId,
      workspaceGrants: [],
      accountGrants: [
        { accountId, subjectId: "user:owner", role: "owner", permissions: ["billing:read"] },
      ],
    },
    workspaces: [
      { id: workspaceId, accountId, name: "Personal" },
      { id: otherWorkspaceId, accountId, name: "Team" },
    ],
  } as unknown as AppContextValue;
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <InboxRoute workspaceId={workspaceId} /> }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const view = await renderComponent(
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- one stable fixture created outside React rendering
    <AppContext.Provider value={context}>
      <RouterProvider router={router} />
    </AppContext.Provider>,
  );
  try {
    expect(view.container.querySelector('[aria-label="Billing notifications"]')).not.toBeNull();
    const radio = (label: string) =>
      [...view.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (node) => node.textContent?.trim() === label,
      )!;
    await actRun(() => radio("Personal").click());
    expect(view.container.querySelector('[aria-label="Billing notifications"]')).toBeNull();
    // Another tab clears the last chat item; this mounted route polls again.
    data = { ...data, items: [] };
    await actRun(() => inboxStoreFor(context).refresh());
    expect(radio("All workspaces")).toBeDefined();
    expect(inboxAttentionCount(inboxStoreFor(context).snapshot.data)).toBe(1);
    await actRun(() => radio("All workspaces").click());
    expect(view.container.querySelector('[aria-label="Billing notifications"]')).not.toBeNull();
    expect(view.container.textContent).not.toContain("Nothing is waiting on you");
  } finally {
    await view.unmount();
  }
});
