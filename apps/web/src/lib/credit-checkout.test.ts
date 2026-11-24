import { describe, expect, mock, test } from "bun:test";

import {
  billingCheckoutReturnUrl,
  checkoutPageReturnUrl,
  checkoutTabReturnUrl,
  planCheckoutReturnUrl,
  readCheckoutPageReturn,
  startCreditCheckout,
  waitForActivePlan,
  waitForCheckoutCredits,
} from "@opengeni/react/app/lib/credit-checkout";
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
  test("leaving the account during checkout creation closes the blank tab without navigating", async () => {
    const controller = new AbortController();
    let finish!: (value: { checkoutSessionId: string; url: string }) => void;
    const tab = { location: { href: "" }, close: mock(() => undefined) };
    const navigate = mock(() => undefined);
    const pending = startCreditCheckout(
      {
        createBillingCheckout: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      } as never,
      {
        accountId: "account-a",
        workspaceId: "workspace-a",
        promotionCode: "LAUNCH100",
        tab: tab as unknown as Window,
        origin: "https://app.test",
        signal: controller.signal,
        navigate,
      },
    );
    controller.abort(new Error("account changed"));
    finish({ checkoutSessionId: "cs_test_1", url: "https://checkout.stripe.test/credits" });
    await expect(pending).rejects.toThrow("account changed");
    expect(tab.location.href).toBe("");
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });
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

  test("a purchase started from a chat returns to that page, replacing an earlier return", () => {
    const success = checkoutPageReturnUrl(
      "https://app.test/workspaces/ws/sessions/s1?draft=1&checkoutReturn=cancelled#composer",
      "account-1",
      "success",
    );
    expect(success).toBe(
      "https://app.test/workspaces/ws/sessions/s1?draft=1&checkoutReturn=success&checkoutAccount=account-1&checkoutSession={CHECKOUT_SESSION_ID}",
    );
    expect(
      checkoutPageReturnUrl("https://app.test/workspaces/ws/sessions", "account-1", "cancelled"),
    ).toBe(
      "https://app.test/workspaces/ws/sessions?checkoutReturn=cancelled&checkoutAccount=account-1",
    );
    const returned = new URL(success.replace("{CHECKOUT_SESSION_ID}", "cs_test_a1B2"));
    expect(readCheckoutPageReturn(returned.searchParams)).toEqual({
      outcome: "success",
      accountId: "account-1",
      checkoutSessionId: "cs_test_a1B2",
    });
  });

  test("a malformed or missing chat return is ignored", () => {
    const read = (query: string) => readCheckoutPageReturn(new URLSearchParams(query));
    expect(read("")).toBeNull();
    expect(read("checkoutReturn=cancelled")).toEqual({ outcome: "cancelled" });
    expect(read("checkoutReturn=success&checkoutAccount=a")).toBeNull();
    expect(read("checkoutReturn=success&checkoutSession=cs_test_1")).toBeNull();
    expect(
      read("checkoutReturn=success&checkoutAccount=a&checkoutSession={CHECKOUT_SESSION_ID}"),
    ).toBeNull();
    expect(read("checkoutReturn=success&checkoutAccount=a&checkoutSession=cs_<x>")).toBeNull();
    expect(read("checkoutReturn=other&checkoutAccount=a&checkoutSession=cs_test_1")).toBeNull();
  });

  test("a paid plan returns to the page it started from with its plan; the page reads it back", () => {
    const success = planCheckoutReturnUrl(
      "https://app.test/workspaces/ws/organization?section=billing&checkoutReturn=cancelled#plans",
      "account-1",
      "pro",
    );
    expect(success).toBe(
      "https://app.test/workspaces/ws/organization?section=billing&checkoutReturn=success&checkoutAccount=account-1&checkoutPlan=pro",
    );
    expect(readCheckoutPageReturn(new URL(success).searchParams)).toEqual({
      outcome: "plan",
      accountId: "account-1",
      planKey: "pro",
    });
    const read = (query: string) => readCheckoutPageReturn(new URLSearchParams(query));
    expect(read("checkoutReturn=success&checkoutPlan=pro")).toBeNull();
    expect(read("checkoutReturn=success&checkoutAccount=a&checkoutPlan=")).toBeNull();
    expect(read("checkoutReturn=success&checkoutAccount=a&checkoutPlan=<b>")).toBeNull();
  });

  test("waits through another plan, an unpaid plan and dropped requests until the plan and its credit land", async () => {
    const reads = [
      { key: "free", label: "Free", status: "active", creditGrantedMicros: 10_000_000 },
      null,
      { key: "pro", label: "Pro", status: "incomplete", creditGrantedMicros: 0 },
      { key: "pro", label: "Pro", status: "active", creditGrantedMicros: 0 },
      { key: "pro", label: "Pro", status: "active", creditGrantedMicros: 100_000_000 },
    ];
    const getBilling = mock(async (_options: { accountId?: string }) => {
      const plan = reads.shift();
      if (plan === null) throw new Error("dropped");
      return { balance: { plan } } as never;
    });
    const plan = await waitForActivePlan(
      { getBilling },
      {
        accountId: "account-1",
        planKey: "pro",
        signal: new AbortController().signal,
        intervalMs: 1,
      },
    );
    expect(plan).toMatchObject({ key: "pro", label: "Pro" });
    expect(getBilling).toHaveBeenCalledTimes(5);
    expect(getBilling.mock.calls[0]).toEqual([{ accountId: "account-1" }]);
  });

  test("a plan without credit is ready after the grace period; a refused read ends the wait", async () => {
    const creditless = { key: "team", label: "Team", status: "active", creditGrantedMicros: 0 };
    const plan = await waitForActivePlan(
      { getBilling: async () => ({ balance: { plan: creditless } }) as never },
      {
        accountId: "account-1",
        planKey: "team",
        signal: new AbortController().signal,
        intervalMs: 1,
        creditGraceMs: 5,
      },
    );
    expect(plan).toMatchObject({ key: "team" });
    const refused = mock(async () => {
      throw Object.assign(new Error("forbidden"), { status: 403 });
    });
    expect(
      await waitForActivePlan(
        { getBilling: refused },
        { accountId: "x", planKey: "pro", signal: new AbortController().signal, intervalMs: 1 },
      ),
    ).toBeNull();
    expect(refused).toHaveBeenCalledTimes(1);
  });

  test("polling leaves no abort listener behind on its signal", async () => {
    const controller = new AbortController();
    let listening = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      listening += 1;
      add(...args);
    }) as typeof add;
    controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      listening -= 1;
      remove(...args);
    }) as typeof remove;
    const reads = ["free", "free", "free", "pro"];
    await waitForActivePlan(
      {
        getBilling: async () =>
          ({
            balance: {
              plan: { key: reads.shift(), label: "x", status: "active", creditGrantedMicros: 1 },
            },
          }) as never,
      },
      { accountId: "a", planKey: "pro", signal: controller.signal, intervalMs: 1 },
    );
    expect(listening).toBe(0);
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
        navigate: () => {},
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

  test("an embed that opens checkout beside itself waits for it like a tab", async () => {
    const createBillingCheckout = mock(async () => ({
      checkoutSessionId: "cs_test_3",
      url: "https://checkout.stripe.test/c/pay/cs_test_3",
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
        navigateOpensBeside: true,
      },
    );
    expect(started.inNewTab).toBe(true);
    expect(navigate.mock.calls).toEqual([["https://checkout.stripe.test/c/pay/cs_test_3"]]);
    expect(
      (createBillingCheckout.mock.calls[0] as unknown as [{ successUrl: string }])[0].successUrl,
    ).toBe("https://app.test/checkout-complete.html?checkout=success");
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
        navigate: () => {},
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
