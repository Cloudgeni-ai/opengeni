import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useSubscriptionCatalog } from "./use-subscription-catalog";
import { isSeatLimitError, subscriptionAction } from "@/lib/subscription-plans";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { SubscriptionPlans } = await import("./subscription-plans");
const { SeatLimitNotice } = await import("./plan-seats");
const { OrganizationCreditBalance } = await import("@/components/organization-credit-balance");
const { previewPlan, previewPlans } = await import("@/dev/subscription-plans-preview");
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});
async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function submit() {
  const form = document.querySelector("[role=dialog] form") ?? document.querySelector("form");
  expect(form).not.toBeNull();
  await act(async () =>
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
const receipt = {
  subscriptionId: "sub_test",
  planKey: "max",
  effectiveAt: "2026-11-01T10:00:00Z",
  cancelAtPeriodEnd: false,
};
function clientFixture() {
  return {
    upgradeBillingSubscription: mock(async (_request: unknown) => receipt),
    changeBillingSubscription: mock(async (_request: unknown) => ({ ...receipt, planKey: "pro" })),
    cancelBillingSubscription: mock(async (_request: unknown) => ({
      ...receipt,
      planKey: "free",
      cancelAtPeriodEnd: true,
    })),
    createSubscriptionCheckout: mock(async (_request: unknown) => {
      throw new Error("Checkout transport unavailable");
    }),
    createSubscriptionPortalSession: mock(async (_request: unknown) => {
      throw new Error("Portal transport unavailable");
    }),
    getBillingSubscriptionPlans: mock(async (_request: unknown) => ({
      accountId: "org-a",
      revision: 1,
      plans: previewPlans,
      plan: previewPlan("pro"),
    })),
  };
}
function plans(
  client: ReturnType<typeof clientFixture>,
  key = "pro",
  canManage = true,
  onChanged = () => {},
) {
  const plan = previewPlan(key);
  return (
    <SubscriptionPlans
      client={client as unknown as OpenGeniBrowserClient}
      accountId="org-a"
      returnUrl="https://console.example.test/workspaces/a/organization?section=billing"
      catalog={{ accountId: "org-a", revision: 1, plans: previewPlans, plan }}
      plan={plan}
      canManage={canManage}
      supportEmail="support@example.test"
      onChanged={onChanged}
    />
  );
}

test("upgrade confirms proration, fresh replacement credit and targets the selected organization", async () => {
  const client = clientFixture();
  const changed = mock(() => {});
  await mount(plans(client, "pro", true, changed));
  await click("Upgrade to Max");
  expect(document.body.textContent).toContain("Stripe prorates unused time");
  expect(document.body.textContent).toContain("replaced, not added");
  expect(client.upgradeBillingSubscription).not.toHaveBeenCalled();
  await submit();
  expect(client.upgradeBillingSubscription).toHaveBeenCalledTimes(1);
  expect(client.upgradeBillingSubscription.mock.calls[0]![0]).toMatchObject({
    accountId: "org-a",
    planKey: "max",
    idempotencyKey: expect.any(String),
  });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain("Upgraded to Max");
});

test("checkout retries retain one UUID even after closing and reopening confirmation", async () => {
  const client = clientFixture();
  await mount(plans(client, "free"));
  await click("Get Pro");
  await submit();
  expect(document.body.textContent).toContain("Checkout transport unavailable");
  await click("Cancel");
  await click("Get Pro");
  await submit();
  expect(client.createSubscriptionCheckout).toHaveBeenCalledTimes(2);
  expect(client.createSubscriptionCheckout.mock.calls[0]![0]).toEqual(
    client.createSubscriptionCheckout.mock.calls[1]![0],
  );
  expect(client.createSubscriptionCheckout.mock.calls[0]![0]).toMatchObject({
    accountId: "org-a",
    planKey: "pro",
    successUrl: "https://console.example.test/workspaces/a/organization?section=billing",
  });
});

test("downgrade and cancel use separate period-end endpoints without expiring credit early", async () => {
  const client = clientFixture();
  await mount(plans(client, "max"));
  await click("Downgrade to Pro");
  expect(document.body.textContent).toContain("Your current plan continues until");
  await submit();
  expect(client.changeBillingSubscription).toHaveBeenCalledTimes(1);
  expect(client.upgradeBillingSubscription).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Pro starts");
  await click("Cancel plan");
  expect(document.body.textContent).toContain("existing people keep access");
  await submit();
  expect(client.cancelBillingSubscription.mock.calls[0]![0]).toMatchObject({
    accountId: "org-a",
    idempotencyKey: expect.any(String),
  });
  expect(document.body.textContent).toContain("Free starts");
});

test("portal preserves selected account and current return URL; read-only users cannot mutate", async () => {
  const client = clientFixture();
  await mount(plans(client));
  await click("Manage billing");
  expect(client.createSubscriptionPortalSession.mock.calls[0]![0]).toMatchObject({
    accountId: "org-a",
    returnUrl: "https://console.example.test/workspaces/a/organization?section=billing",
  });
  await act(async () => root!.render(plans(client, "pro", false)));
  expect(document.body.textContent).not.toContain("Manage billing");
  expect(document.body.textContent).not.toContain("Upgrade to Max");
});

test("a late mutation after leaving the organization cannot refresh or navigate", async () => {
  const client = clientFixture();
  const changed = mock(() => {});
  let resolve!: (value: typeof receipt) => void;
  client.upgradeBillingSubscription.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount(plans(client, "pro", true, changed));
  await click("Upgrade to Max");
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  await act(async () => root!.render(<div>Another organization</div>));
  await act(async () => resolve(receipt));
  expect(changed).not.toHaveBeenCalled();
  expect(document.body.textContent).toBe("Another organization");
});

test("plan actions follow catalog prices, availability and subscription state", () => {
  const pro = previewPlan("pro");
  const max = previewPlans[2]!;
  expect(subscriptionAction(pro, previewPlans, max)).toBe("upgrade");
  expect(subscriptionAction({ ...pro, cancelAtPeriodEnd: true }, previewPlans, max)).toBeNull();
  expect(subscriptionAction({ ...pro, status: "past_due" }, previewPlans, max)).toBeNull();
  expect(subscriptionAction(previewPlan("enterprise"), previewPlans, max)).toBeNull();
  expect(subscriptionAction(pro, previewPlans, { ...max, selfService: false })).toBeNull();
  expect(subscriptionAction(pro, previewPlans, { ...max, monthlyPriceMicros: 5_000_000 })).toBe(
    "downgrade",
  );
});

function Gate({
  client,
  ownerKey = "a",
  hasPlan = true,
}: {
  client: OpenGeniBrowserClient;
  ownerKey?: string;
  hasPlan?: boolean;
}) {
  const { catalog } = useSubscriptionCatalog(
    client,
    ownerKey,
    ownerKey,
    hasPlan ? previewPlan("pro") : null,
  );
  return <div>{catalog ? "Plans visible" : "Legacy billing"}</div>;
}
test("plan UI stays hidden for a missing balance plan or disabled endpoint", async () => {
  const client = clientFixture();
  const typed = client as unknown as OpenGeniBrowserClient;
  await mount(<Gate client={typed} hasPlan={false} />);
  expect(client.getBillingSubscriptionPlans).not.toHaveBeenCalled();
  client.getBillingSubscriptionPlans.mockImplementation(async () => {
    throw new OpenGeniApiError(404, "disabled");
  });
  await act(async () => root!.render(<Gate client={typed} />));
  expect(document.body.textContent).toBe("Legacy billing");
});

test("late catalog reads cannot display another organization's plan", async () => {
  const client = clientFixture();
  const typed = client as unknown as OpenGeniBrowserClient;
  let resolve!: (value: Awaited<ReturnType<typeof client.getBillingSubscriptionPlans>>) => void;
  client.getBillingSubscriptionPlans.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount(<Gate client={typed} />);
  await act(async () => root!.render(<Gate client={typed} ownerKey="b" hasPlan={false} />));
  await act(async () =>
    resolve({ accountId: "a", revision: 1, plans: previewPlans, plan: previewPlan("pro") }),
  );
  expect(document.body.textContent).toBe("Legacy billing");
});

test("balance splits monthly, promotional and other general credit without double counting", async () => {
  await mount(
    <OrganizationCreditBalance
      canReadBilling
      hasAccount
      loading={false}
      hasError={false}
      showPlanCredit
      billing={{
        mode: "stripe",
        balance: {
          accountId: "org-a",
          balanceMicros: 158_450_000,
          generalBalanceMicros: 148_450_000,
          currency: "usd",
          updatedAt: "2026-10-16T14:00:00Z",
          plan: previewPlan("pro"),
          promotionalCredits: [
            {
              grantId: "grant",
              label: "Launch credit",
              remainingMicros: 10_000_000,
              eligibleModelIds: ["model-test"],
            },
          ],
        },
      }}
    />,
  );
  expect(document.body.textContent).toContain("$158.45");
  expect(document.body.textContent).toContain("$123.45");
  expect(document.body.textContent).toContain("$25.00");
  expect(document.body.textContent).toContain("$10.00");
  expect(document.body.textContent).toContain("Other general credit");
});

test("seat refusal recognizes the real legacy body and offers exactly one upgrade action", async () => {
  expect(
    isSeatLimitError(
      new OpenGeniApiError(
        402,
        JSON.stringify({
          error: "seat_limit_reached",
          message: "Seat limit reached",
          action: { type: "upgrade", href: "/billing" },
        }),
      ),
    ),
  ).toBe(true);
  expect(
    isSeatLimitError(new OpenGeniApiError(402, JSON.stringify({ code: "insufficient_credit" }))),
  ).toBe(false);
  const upgrade = mock(() => {});
  await mount(<SeatLimitNotice canManage onUpgrade={upgrade} />);
  expect(document.querySelectorAll("button").length).toBe(1);
  await click("View upgrade options");
  expect(upgrade).toHaveBeenCalledTimes(1);
});
