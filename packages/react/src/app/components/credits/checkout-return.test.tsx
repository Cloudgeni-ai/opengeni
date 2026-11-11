import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BillingCheckoutStatus } from "@opengeni/sdk";
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
mock.module("../../app-context", () => ({
  useAppContext: () => ({ client: { getBillingCheckout } }),
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

async function settle(ms = 30): Promise<void> {
  await act(async () => await new Promise((resolve) => setTimeout(resolve, ms)));
}

beforeEach(() => {
  toasts.length = 0;
  toastIds.length = 0;
  replaced.length = 0;
  getBillingCheckout.mockClear();
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
    followCheckoutPageReturn({ getBillingCheckout }, checkout, { intervalMs: 1 });
    // The same return seen again (a remount, a second tab) isn't confirmed twice.
    followCheckoutPageReturn({ getBillingCheckout }, checkout, { intervalMs: 1 });
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
    followCheckoutPageReturn({ getBillingCheckout }, { outcome: "cancelled" });
    expect(toastIds).toEqual(["checkout-cancelled"]);
    getBillingCheckout.mockImplementationOnce(async () => status("pending", "expired"));
    followCheckoutPageReturn(
      { getBillingCheckout },
      { outcome: "success", accountId: "account-a", checkoutSessionId: "cs_test_expired" },
      { intervalMs: 1 },
    );
    await settle();
    // The wait ends before the credits land.
    getBillingCheckout.mockImplementation(async () => status("pending", "complete"));
    followCheckoutPageReturn(
      { getBillingCheckout },
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
});
