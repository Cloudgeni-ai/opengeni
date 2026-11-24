import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BillingCheckoutStatus } from "@opengeni/sdk";
import type { BillingSummary } from "@opengeni/sdk";
import { act } from "react";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());

// Every toast the return shows, in order, as "kind: title | description".
const toasts: string[] = [];
// The id each toast was shown with, so a repeat replaces it instead of stacking.
const toastIds: (string | undefined)[] = [];
const record =
  (kind: string) =>
  (title: string, options?: { id?: string; description?: string | undefined }): string => {
    toasts.push(`${kind}: ${title}${options?.description ? ` | ${options.description}` : ""}`);
    toastIds.push(options?.id);
    return title;
  };
mock.module("../../lib/toast", () => ({
  toast: Object.assign(record("info"), {
    loading: record("loading"),
    success: record("success"),
    error: record("error"),
    dismiss: (id?: string) => {
      toasts.push(`dismiss: ${id}`);
    },
  }),
}));

// The page the gate reads its return from, and what it writes back.
let address = new URLSearchParams();
const replaced: string[] = [];
mock.module("../../lib/navigation", () => ({
  usePage: () => ({
    readQuery: () => new URLSearchParams(address),
    replaceQuery: (query: URLSearchParams) => {
      address = new URLSearchParams(query);
      replaced.push(query.toString());
    },
  }),
}));

const getBillingCheckout = mock(
  async (_id: string, _options: { accountId: string }): Promise<BillingCheckoutStatus> =>
    status("granted", "complete"),
);
// The organization's plan as billing reports it, before and after the webhook.
const getBilling = mock(
  async (_options: { accountId?: string }): Promise<BillingSummary> => billing("pro", "active"),
);
const client = { getBillingCheckout, getBilling };
mock.module("../../app-context", () => ({
  useAppContext: () => ({ client }),
}));

const { createRoot } = await import("react-dom/client");
const { followCheckoutPageReturn } = await import("./checkout-return");
const { CreditRequiredGate } = await import("../credit-required-gate");

function status(
  state: "pending" | "granted",
  checkout: "open" | "complete" | "expired",
): BillingCheckoutStatus {
  return {
    checkoutSessionId: "cs_test_1",
    status: checkout,
    credit: { state, amountMicros: 20_000_000, currency: "usd", free: false },
    balance: null,
  } as unknown as BillingCheckoutStatus;
}

function billing(
  key: "free" | "pro" | "max",
  planStatus: string,
  creditGrantedMicros = 100_000_000,
): BillingSummary {
  const label = { free: "Free", pro: "Pro", max: "Max" }[key];
  return {
    balance: { plan: { key, label, status: planStatus, creditGrantedMicros } },
  } as unknown as BillingSummary;
}

async function settle(ms = 30): Promise<void> {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, ms)));
}

beforeEach(() => {
  toasts.length = 0;
  toastIds.length = 0;
  replaced.length = 0;
  getBillingCheckout.mockClear();
  getBilling.mockReset();
  getBilling.mockImplementation(async () => billing("pro", "active"));
});

describe("back from checkout on the page it started from", () => {
  test("a paid checkout is confirmed once with its real amount, and the balance refreshes", async () => {
    const refreshed: string[] = [];
    const onChanged = (event: Event) =>
      refreshed.push((event as CustomEvent<{ accountId: string }>).detail.accountId);
    window.addEventListener("credit-balance-changed", onChanged);
    getBillingCheckout
      .mockImplementationOnce(async () => status("pending", "complete"))
      .mockImplementationOnce(async () => status("granted", "complete"));
    const checkout = {
      outcome: "success" as const,
      accountId: "account-a",
      checkoutSessionId: "cs_test_paid",
    };
    followCheckoutPageReturn(client, checkout, { intervalMs: 1 });
    // The same return seen again (a remount, a second tab) isn't confirmed twice.
    followCheckoutPageReturn(client, checkout, { intervalMs: 1 });
    await settle();
    window.removeEventListener("credit-balance-changed", onChanged);
    expect(toasts).toEqual([
      "loading: Adding your credits…",
      "success: You added $20 in credits | You're ready to send.",
    ]);
    expect(getBillingCheckout.mock.calls[0]).toEqual(["cs_test_paid", { accountId: "account-a" }]);
    expect(refreshed).toEqual(["account-a"]);
  });

  test("cancelled, expired and still-processing checkouts each say so without claiming credits", async () => {
    followCheckoutPageReturn(client, { outcome: "cancelled" });
    expect(toastIds).toEqual(["checkout-cancelled"]);
    getBillingCheckout.mockImplementationOnce(async () => status("pending", "expired"));
    followCheckoutPageReturn(
      client,
      { outcome: "success", accountId: "account-a", checkoutSessionId: "cs_test_expired" },
      { intervalMs: 1 },
    );
    await settle();
    // The wait ends before the credits land.
    getBillingCheckout.mockImplementation(async () => status("pending", "complete"));
    followCheckoutPageReturn(
      client,
      { outcome: "success", accountId: "account-a", checkoutSessionId: "cs_test_slow" },
      { intervalMs: 1, signal: AbortSignal.timeout(10) },
    );
    await settle(60);
    getBillingCheckout.mockImplementation(async () => status("granted", "complete"));
    expect(toasts).toEqual([
      "info: Checkout cancelled | No charge was made.",
      "loading: Adding your credits…",
      "info: Checkout expired | No charge was made.",
      "loading: Adding your credits…",
      "info: Your payment is still processing | The credits appear in your balance as soon as it completes.",
    ]);
  });

  test("the gate removes the return keys from the address and keeps the page's own", async () => {
    address = new URLSearchParams(
      "draft=1&checkoutReturn=success&checkoutAccount=account-a&checkoutSession=cs_test_gate",
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <CreditRequiredGate
          creditRequired={null}
          setCreditRequired={() => undefined}
          accessContext={null}
        />,
      ),
    );
    await settle(50);
    expect(replaced).toEqual(["draft=1"]);
    expect(getBillingCheckout.mock.calls[0]).toEqual(["cs_test_gate", { accountId: "account-a" }]);
    expect(toasts.at(-1)).toBe("success: You added $20 in credits | You're ready to send.");
    // A malformed return is removed too, and confirms nothing.
    toasts.length = 0;
    replaced.length = 0;
    await act(async () => root.unmount());
    address = new URLSearchParams("checkoutReturn=success&checkoutSession=not-a-checkout");
    const again = createRoot(container);
    await act(async () =>
      again.render(
        <CreditRequiredGate
          creditRequired={null}
          setCreditRequired={() => undefined}
          accessContext={null}
        />,
      ),
    );
    await settle(20);
    expect(replaced).toEqual([""]);
    expect(toasts).toEqual([]);
    // Without a return, the address is left alone.
    await act(async () => again.unmount());
    address = new URLSearchParams("draft=1");
    const plain = createRoot(container);
    await act(async () =>
      plain.render(
        <CreditRequiredGate
          creditRequired={null}
          setCreditRequired={() => undefined}
          accessContext={null}
        />,
      ),
    );
    await settle(10);
    expect(replaced).toEqual([""]);
    await act(async () => plain.unmount());
    container.remove();
  });

  test("a paid plan is confirmed once by the name billing reports, after the webhook lands", async () => {
    const refreshed: string[] = [];
    const onChanged = (event: Event) =>
      refreshed.push((event as CustomEvent<{ accountId: string }>).detail.accountId);
    window.addEventListener("credit-balance-changed", onChanged);
    // Back before the webhooks: still Free, then Pro not yet paid, then Pro
    // active before its paid invoice granted the plan credit, then both.
    getBilling
      .mockImplementationOnce(async () => billing("free", "active"))
      .mockImplementationOnce(async () => {
        throw new Error("dropped");
      })
      .mockImplementationOnce(async () => billing("pro", "incomplete"))
      .mockImplementationOnce(async () => billing("pro", "active", 0))
      .mockImplementationOnce(async () => billing("pro", "active"));
    const checkout = { outcome: "plan" as const, accountId: "account-plan", planKey: "pro" };
    followCheckoutPageReturn(client, checkout, { intervalMs: 1 });
    followCheckoutPageReturn(client, checkout, { intervalMs: 1 });
    await settle();
    window.removeEventListener("credit-balance-changed", onChanged);
    expect(toasts).toEqual(["loading: Activating your plan…", "success: Pro is active"]);
    expect(new Set(toastIds)).toEqual(new Set(["checkout-plan-account-plan-pro"]));
    expect(getBilling).toHaveBeenCalledTimes(5);
    expect(getBilling.mock.calls[0]).toEqual([{ accountId: "account-plan" }]);
    expect(getBillingCheckout).not.toHaveBeenCalled();
    expect(refreshed).toEqual(["account-plan"]);
  });

  test("a plan that is not active yet never names another plan, and says it is still processing", async () => {
    getBilling.mockImplementation(async () => billing("free", "active"));
    followCheckoutPageReturn(
      client,
      { outcome: "plan", accountId: "account-slow", planKey: "max" },
      { intervalMs: 1, signal: AbortSignal.timeout(10) },
    );
    await settle(60);
    expect(toasts).toEqual([
      "loading: Activating your plan…",
      "info: Your payment is still processing | Your plan starts as soon as it completes.",
    ]);
  });

  test("a plan link billing refuses (a foreign or stale account) stops at once and says nothing", async () => {
    getBilling.mockImplementation(async () => {
      throw Object.assign(new Error("forbidden"), { status: 403 });
    });
    followCheckoutPageReturn(
      client,
      { outcome: "plan", accountId: "account-foreign", planKey: "pro" },
      { intervalMs: 1 },
    );
    await settle();
    expect(getBilling).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([
      "loading: Activating your plan…",
      "dismiss: checkout-plan-account-foreign-pro",
    ]);
  });

  test("a return the address lost before the app was ready (a redirect, a setup step) is still confirmed", async () => {
    const { rememberCheckoutPageReturn, rememberedCheckoutPageReturn } =
      await import("../../lib/credit-checkout");
    rememberCheckoutPageReturn(
      "?checkoutReturn=success&checkoutAccount=account-launch&checkoutPlan=pro",
    );
    address = new URLSearchParams("draft=1");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <CreditRequiredGate
          creditRequired={null}
          setCreditRequired={() => undefined}
          accessContext={null}
        />,
      ),
    );
    await settle(50);
    expect(getBilling.mock.calls[0]).toEqual([{ accountId: "account-launch" }]);
    expect(toasts).toEqual(["loading: Activating your plan…", "success: Pro is active"]);
    // The address no longer had the keys; the page's own query is left alone.
    expect(replaced).toEqual([]);
    expect(rememberedCheckoutPageReturn()).toBeNull();
    await act(async () => root.unmount());
    container.remove();
  });

  test("the gate confirms a plan return from Billing or onboarding and removes its keys", async () => {
    address = new URLSearchParams(
      "section=billing&checkoutReturn=success&checkoutAccount=account-gate&checkoutPlan=max",
    );
    getBilling.mockImplementation(async () => billing("max", "active"));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <CreditRequiredGate
          creditRequired={null}
          setCreditRequired={() => undefined}
          accessContext={null}
        />,
      ),
    );
    await settle(50);
    expect(replaced).toEqual(["section=billing"]);
    expect(getBilling.mock.calls[0]).toEqual([{ accountId: "account-gate" }]);
    expect(toasts).toEqual(["loading: Activating your plan…", "success: Max is active"]);
    await act(async () => root.unmount());
    container.remove();
  });
});
