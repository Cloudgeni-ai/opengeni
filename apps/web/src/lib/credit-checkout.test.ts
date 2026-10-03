import { describe, expect, mock, test } from "bun:test";

import {
  billingCheckoutReturnUrl,
  checkoutTabReturnUrl,
  startCreditCheckout,
  waitForCheckoutCredits,
} from "./credit-checkout";
import { parseCheckoutSessionId } from "./checkout-session-id";

const status = (state: "pending" | "granted", checkout: "open" | "complete" | "expired") => ({
  checkoutSessionId: "cs_test_1",
  status: checkout,
  credit: { state, amountMicros: 100_000_000, currency: "usd" as const, free: true },
  balance:
    state === "granted"
      ? {
          accountId: "account-1",
          balanceMicros: 110_000_000,
          currency: "usd" as const,
          updatedAt: "2026-10-02T00:00:00.000Z",
        }
      : null,
});

describe("credit checkout", () => {
  test("a same-tab return keeps Stripe's session placeholder unencoded", () => {
    expect(billingCheckoutReturnUrl("https://app.test", "ws 1", "success")).toBe(
      "https://app.test/workspaces/ws%201/organization?section=billing&checkout=success&checkoutSession={CHECKOUT_SESSION_ID}",
    );
    expect(billingCheckoutReturnUrl("https://app.test", "ws", "cancelled")).toBe(
      "https://app.test/workspaces/ws/organization?section=billing&checkout=cancelled",
    );
    expect(checkoutTabReturnUrl("https://app.test", "success")).toBe(
      "https://app.test/checkout-complete.html?checkout=success",
    );
  });

  test("only a Stripe checkout session id is accepted from a return URL", () => {
    expect(parseCheckoutSessionId("cs_test_a1B2")).toBe("cs_test_a1B2");
    expect(parseCheckoutSessionId("{CHECKOUT_SESSION_ID}")).toBeNull();
    expect(parseCheckoutSessionId("cs_<script>")).toBeNull();
    expect(parseCheckoutSessionId(42)).toBeNull();
  });

  test("a code-only checkout opens in the tab the click opened", async () => {
    const createBillingCheckout = mock(async () => ({
      checkoutSessionId: "cs_test_1",
      url: "https://checkout.stripe.test/c/pay/cs_test_1",
      amountUsd: 100,
    }));
    const tab = { location: { href: "" }, close: mock(() => undefined) };
    const started = await startCreditCheckout(
      { createBillingCheckout, getBillingCheckout: mock() } as never,
      {
        accountId: "account-1",
        workspaceId: "ws",
        promotionCode: "LAUNCH100",
        tab: tab as unknown as Window,
        origin: "https://app.test",
      },
    );
    expect(createBillingCheckout.mock.calls[0]).toEqual([
      {
        accountId: "account-1",
        promotionCode: "LAUNCH100",
        successUrl: "https://app.test/checkout-complete.html?checkout=success",
        cancelUrl: "https://app.test/checkout-complete.html?checkout=cancelled",
      },
    ] as never);
    expect(tab.location.href).toBe("https://checkout.stripe.test/c/pay/cs_test_1");
    expect(started).toEqual({
      checkoutSessionId: "cs_test_1",
      url: "https://checkout.stripe.test/c/pay/cs_test_1",
      inNewTab: true,
    });
  });

  test("a blocked tab takes checkout to this page and returns to billing", async () => {
    const createBillingCheckout = mock(async () => ({
      checkoutSessionId: "cs_test_2",
      url: "https://checkout.stripe.test/c/pay/cs_test_2",
    }));
    const navigate = mock((_url: string) => undefined);
    const started = await startCreditCheckout(
      { createBillingCheckout, getBillingCheckout: mock() } as never,
      {
        accountId: "account-1",
        workspaceId: "ws",
        promotionCode: "LAUNCH100",
        tab: null,
        origin: "https://app.test",
        navigate,
      },
    );
    expect(started.inNewTab).toBe(false);
    expect(navigate.mock.calls).toEqual([["https://checkout.stripe.test/c/pay/cs_test_2"]]);
    expect(
      (createBillingCheckout.mock.calls[0] as unknown as [{ successUrl: string }])[0].successUrl,
    ).toBe(
      "https://app.test/workspaces/ws/organization?section=billing&checkout=success&checkoutSession={CHECKOUT_SESSION_ID}",
    );
  });

  test("a refused code closes the tab it opened", async () => {
    const createBillingCheckout = mock(async () => {
      throw new Error("That code isn't valid or has expired.");
    });
    const tab = { location: { href: "" }, close: mock(() => undefined) };
    await expect(
      startCreditCheckout({ createBillingCheckout, getBillingCheckout: mock() } as never, {
        accountId: "account-1",
        workspaceId: "ws",
        promotionCode: "NOPE",
        tab: tab as unknown as Window,
        origin: "https://app.test",
      }),
    ).rejects.toThrow("That code isn't valid");
    expect(tab.close).toHaveBeenCalledTimes(1);
  });

  test("waits through pending reads and dropped requests until credits land", async () => {
    const replies = [
      () => Promise.resolve(status("pending", "open")),
      () => Promise.reject(new Error("network")),
      () => Promise.resolve(status("granted", "complete")),
    ];
    const getBillingCheckout = mock(() => replies.shift()!());
    const seen: string[] = [];
    const final = await waitForCheckoutCredits({ getBillingCheckout } as never, {
      accountId: "account-1",
      checkoutSessionId: "cs_test_1",
      signal: new AbortController().signal,
      intervalMs: 1,
      onStatus: (next) => seen.push(next.credit.state),
    });
    expect(final.credit.state).toBe("granted");
    expect(final.balance?.balanceMicros).toBe(110_000_000);
    expect(seen).toEqual(["pending", "granted"]);
    expect(getBillingCheckout.mock.calls[0]).toEqual([
      "cs_test_1",
      { accountId: "account-1" },
    ] as never);
  });

  test("stops at an expired checkout and when aborted", async () => {
    const expired = await waitForCheckoutCredits(
      { getBillingCheckout: mock(async () => status("pending", "expired")) } as never,
      {
        accountId: "account-1",
        checkoutSessionId: "cs_test_1",
        signal: new AbortController().signal,
        intervalMs: 1,
      },
    );
    expect(expired.status).toBe("expired");

    const controller = new AbortController();
    const waiting = waitForCheckoutCredits(
      { getBillingCheckout: mock(async () => status("pending", "open")) } as never,
      { accountId: "account-1", checkoutSessionId: "cs_test_1", signal: controller.signal },
    );
    controller.abort(new Error("left the page"));
    await expect(waiting).rejects.toThrow("left the page");
  });
});
