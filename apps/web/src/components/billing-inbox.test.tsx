import { expect, test } from "bun:test";
import type { BillingCreditNotification } from "@opengeni/sdk";
import { BillingInboxSection } from "./billing-inbox";
import { actRun, registerDom, renderComponent } from "../../../../packages/react/test/render-hook";

registerDom();
const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const notice: BillingCreditNotification = {
  id: "33333333-3333-4333-8333-333333333333",
  accountId,
  kind: "exhausted",
  eventType: "billing.credits.exhausted",
  details: { availableBalanceMicros: 0 },
  createdAt: "2026-11-03T08:00:00Z",
  read: false,
  action: {
    label: "Manage billing",
    path: `/workspaces/${workspaceId}/organization?section=billing`,
  },
};

test("renders billing without a session row and uses one validated action and a read acknowledgement", async () => {
  const reads: string[] = [];
  const navigations: string[] = [];
  const props = {
    notifications: [notice],
    workspaces: [{ id: workspaceId, accountId }],
    markRead: async (item: BillingCreditNotification) => {
      reads.push(item.id);
    },
    onManageBilling: (path: string) => {
      navigations.push(path);
    },
  };
  const view = await renderComponent(<BillingInboxSection {...props} />);
  expect(view.container.querySelector('[aria-label="Billing notifications"]')).not.toBeNull();
  expect(view.container.querySelectorAll("a").length).toBe(1);
  const action = view.container.querySelector("a")!;
  expect(action.textContent).toBe("Manage billing");
  expect(action.getAttribute("href")).toBe(notice.action.path);
  expect(view.container.querySelector('[aria-label="Unread billing notice"]')).not.toBeNull();
  expect(view.container.textContent).not.toContain("Open session");
  await actRun(() =>
    action.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
  );
  expect(reads).toEqual([notice.id]);
  expect(navigations).toEqual([notice.action.path]);
  await view.rerender(
    <BillingInboxSection {...props} notifications={[{ ...notice, read: true }]} />,
  );
  expect(view.container.querySelector('[aria-label="Unread billing notice"]')).toBeNull();
  await view.rerender(<BillingInboxSection {...props} workspaces={[]} />);
  expect(view.container.querySelector("a")).toBeNull();
  await view.unmount();
});
