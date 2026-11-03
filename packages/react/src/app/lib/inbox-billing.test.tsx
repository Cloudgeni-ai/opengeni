import { describe, expect, test } from "bun:test";
import type {
  AccessContext,
  BillingCreditNotification,
  InboxItem,
  ListInboxResponse,
} from "@opengeni/sdk";
import { AppContext, type AppContextValue } from "../app-context";
import { InboxStore, inboxAttentionCount, inboxStoreFor, useInbox } from "./inbox";
import { billingInboxActionPath, billingInboxCopy, inboxBillingAccountIds } from "./inbox-billing";
import { actRun, registerDom, renderComponent } from "../../../test/render-hook";

registerDom();
const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const otherAccountId = "33333333-3333-4333-8333-333333333333";
const otherWorkspaceId = "44444444-4444-4444-8444-444444444444";
const notice: BillingCreditNotification = {
  id: "55555555-5555-4555-8555-555555555555",
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
const response = (): ListInboxResponse => ({
  items: [],
  needsYouCount: 0,
  unreadCount: 0,
  billingNotifications: [notice],
});
const access = (): AccessContext => ({
  mode: "managed",
  subjectId: "user:one",
  defaultAccountId: accountId,
  defaultWorkspaceId: workspaceId,
  workspaceGrants: [],
  accountGrants: [
    { accountId, subjectId: "user:one", role: "owner", permissions: ["billing:read"] },
  ],
});
const context = (client: object): AppContextValue =>
  ({
    client,
    accessContext: access(),
    accessKeyVersion: 0,
    authSession: null,
    workspaces: [
      { id: workspaceId, accountId },
      { id: otherWorkspaceId, accountId: otherAccountId },
    ],
  }) as AppContextValue;

describe("billing inbox state", () => {
  test("chat patches preserve notices and their separate counts; only unread billing adds attention", async () => {
    const store = new InboxStore({ listInbox: async () => response() });
    await store.refresh();
    store.patchItems((items) => [...items]);
    expect(store.snapshot.data).toEqual(response());
    expect(inboxAttentionCount(store.snapshot.data)).toBe(1);
    expect(
      inboxAttentionCount({ ...response(), billingNotifications: [{ ...notice, read: true }] }),
    ).toBe(0);
    expect(inboxAttentionCount({ items: [], unreadCount: 0, needsYouCount: 0 })).toBe(0);
    const reply = {
      id: "chat-reply",
      kind: "reply",
      unread: true,
      snoozedUntil: null,
    } as InboxItem;
    store.patchItems(() => [reply]);
    expect(store.snapshot.data?.unreadCount).toBe(1);
    expect(store.snapshot.data?.needsYouCount).toBe(0);
    expect(inboxAttentionCount(store.snapshot.data)).toBe(2);
    store.patchItems((items) => items.map((item) => ({ ...item, unread: false })));
    expect(store.snapshot.data?.unreadCount).toBe(0);
    expect(inboxAttentionCount(store.snapshot.data)).toBe(1);
    store.patchItems(() => []);
    expect(store.snapshot.data?.billingNotifications).toEqual([notice]);
  });

  test("acknowledges via the billing SDK with the exact account, deduplicates and survives an older poll", async () => {
    const calls: unknown[] = [];
    let resolveRead!: (value: { ok: boolean }) => void;
    let resolvePoll!: (value: ListInboxResponse) => void;
    let polls = 0;
    const store = new InboxStore({
      listInbox: async () =>
        ++polls === 1
          ? response()
          : new Promise((resolve) => {
              resolvePoll = resolve;
            }),
      markBillingCreditNotificationRead: async (...args) => {
        calls.push(args);
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      },
    });
    await store.refresh();
    const poll = store.refresh();
    const first = store.markBillingRead(notice);
    const second = store.markBillingRead(notice);
    expect(store.snapshot.data?.billingNotifications?.[0]?.read).toBe(false);
    resolveRead({ ok: true });
    await Promise.all([first, second]);
    expect(calls).toEqual([[notice.id, { accountId }]]);
    resolvePoll(response());
    await poll;
    expect(store.snapshot.data?.billingNotifications?.[0]?.read).toBe(true);
    expect(inboxAttentionCount(store.snapshot.data)).toBe(0);
  });

  test("failed reads remain unread and can retry", async () => {
    let succeeds = false;
    const store = new InboxStore({
      listInbox: async () => response(),
      markBillingCreditNotificationRead: async () => ({ ok: succeeds }),
    });
    await store.refresh();
    await expect(store.markBillingRead(notice)).rejects.toThrow();
    expect(inboxAttentionCount(store.snapshot.data)).toBe(1);
    succeeds = true;
    await store.markBillingRead(notice);
    expect(inboxAttentionCount(store.snapshot.data)).toBe(0);
  });

  test.each(["subject", "credential", "permissions", "organization"])(
    "%s changes retire cached data, stale polls and stale read actions",
    async (change) => {
      let finish!: (data: ListInboxResponse) => void;
      let reads = 0;
      const initial = context({
        listInbox: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
        markBillingCreditNotificationRead: async () => {
          reads++;
          return { ok: true };
        },
      });
      const old = inboxStoreFor(initial);
      const pending = old.refresh();
      const next = { ...initial, accessContext: { ...initial.accessContext } };
      if (change === "subject") next.accessContext.subjectId = "user:two";
      if (change === "credential") next.accessKeyVersion++;
      if (change === "permissions") next.accessContext.accountGrants = [];
      if (change === "organization") next.accessContext.defaultAccountId = otherAccountId;
      const current = inboxStoreFor(next);
      expect(current).not.toBe(old);
      finish(response());
      await pending;
      await old.markBillingRead(notice);
      expect(reads).toBe(0);
      expect(current.snapshot.data).toBeNull();
      expect(old.snapshot.data).toBeNull();
    },
  );

  test("real hook filters billing by active org, never workspace authority, while retaining chat counts", async () => {
    const ctx = context({ listInbox: async () => response() });
    function Probe({ workspace }: { workspace: string }) {
      const inbox = useInbox({ workspaceId: workspace });
      return (
        <span>
          {inboxAttentionCount(inbox.data)}:{inbox.data?.unreadCount ?? 0}
        </span>
      );
    }
    const render = (value: AppContextValue, workspace = workspaceId) => (
      <AppContext.Provider value={value}>
        <Probe workspace={workspace} />
      </AppContext.Provider>
    );
    const view = await renderComponent(render(ctx));
    expect(view.container.textContent).toBe("1:0");
    await view.rerender(render(ctx, otherWorkspaceId));
    expect(view.container.textContent).toBe("0:0");
    const viewer = {
      ...ctx,
      accessContext: {
        ...ctx.accessContext,
        accountGrants: [],
        workspaceGrants: [
          { accountId, workspaceId, subjectId: "user:one", permissions: ["workspace:admin"] },
        ],
      },
    } as AppContextValue;
    await view.rerender(render(viewer));
    expect(view.container.textContent).toBe("0:0");
    await actRun(() => window.dispatchEvent(new Event("focus")));
    expect(view.container.textContent).toBe("0:0");
    await view.unmount();
  });
});

describe("billing presentation", () => {
  test("workspace-only, member and another subject's grants never qualify", () => {
    expect(inboxBillingAccountIds(access())).toEqual([accountId]);
    for (const grant of [
      { ...access().accountGrants[0]!, subjectId: "user:two" },
      { ...access().accountGrants[0]!, role: "member" as const },
      { ...access().accountGrants[0]!, permissions: [] },
    ])
      expect(inboxBillingAccountIds({ ...access(), accountGrants: [grant] })).toEqual([]);
  });
  test("billing actions only resolve to a known same-org workspace, including the generic fallback", () => {
    const workspaces = [
      { id: workspaceId, accountId },
      { id: otherWorkspaceId, accountId: otherAccountId },
    ];
    expect(billingInboxActionPath(notice, workspaces)).toBe(notice.action.path);
    expect(
      billingInboxActionPath(
        { ...notice, action: { ...notice.action, path: "/billing" } },
        workspaces,
      ),
    ).toBe(notice.action.path);
    for (const path of [
      "https://example.com",
      "//example.com/billing",
      "javascript:alert(1)",
      `/workspaces/${otherWorkspaceId}/organization?section=billing`,
      `${notice.action.path}&accountId=${otherAccountId}`,
      `/workspaces/${workspaceId}/organization?section=members`,
    ]) {
      expect(
        billingInboxActionPath({ ...notice, action: { ...notice.action, path } }, workspaces),
      ).toBeNull();
    }
    expect(billingInboxActionPath(notice, [])).toBeNull();
  });
  test("all six kinds have concise, truthful copy with amounts in USD", () => {
    const kinds = [
      "low_balance",
      "exhausted",
      "unusual_spend",
      "topup_success",
      "topup_failed",
      "cap_reached",
    ] as const;
    for (const kind of kinds)
      expect(billingInboxCopy({ ...notice, kind }).title.length).toBeGreaterThan(0);
    expect(billingInboxCopy(notice).body).toContain("$5.00");
    expect(billingInboxCopy({ ...notice, kind: "exhausted" }).body).toContain(
      "Model-specific credits",
    );
    expect(
      billingInboxCopy({
        ...notice,
        kind: "unusual_spend",
        details: { ...notice.details, lastHourSpendMicros: 12_500_000 },
      }).body,
    ).toContain("$12.50");
  });
});
