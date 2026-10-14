import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BillingCheckoutStatus } from "@opengeni/sdk";
import { act } from "react";
import type { Root } from "react-dom/client";

import type { CreditCheckoutClient } from "@/lib/credit-checkout";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => GlobalRegistrator.unregister());
// React's input-event detection needs a document when react-dom is imported.
const { createRoot } = await import("react-dom/client");
const { CouponRedeem } = await import("./coupon-redeem");

let root: Root | undefined;
let restoreWindowOpen: (() => void) | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  restoreWindowOpen?.();
});

function checkoutTab() {
  const tab = {
    location: { href: "" },
    close: mock(() => undefined),
    document: { title: "", body: { style: { cssText: "" }, textContent: "" } },
    opener: null,
  };
  const opened = spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  restoreWindowOpen = () => opened.mockRestore();
  return { tab, opened };
}

async function mount(client: CreditCheckoutClient, onGranted = mock(() => undefined)) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <CouponRedeem
        client={client}
        accountId="account-test"
        workspaceId="workspace-test"
        defaultOpen
        onGranted={onGranted}
      />,
    );
  });
  return container;
}

async function enterCode(container: HTMLElement, value: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

async function submit(container: HTMLElement) {
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("coupon redemption", () => {
  test("switching accounts during checkout creation cannot navigate or poll the old checkout", async () => {
    const { tab } = checkoutTab();
    let finish!: (value: { checkoutSessionId: string; url: string }) => void;
    const getBillingCheckout = mock();
    const onGranted = mock(() => undefined);
    const client = {
      createBillingCheckout: mock(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      getBillingCheckout,
    } as unknown as CreditCheckoutClient;
    const container = await mount(client, onGranted);
    await enterCode(container, "LAUNCH100");
    await submit(container);
    await act(async () =>
      root!.render(
        <CouponRedeem
          client={client}
          accountId="account-new"
          workspaceId="workspace-new"
          defaultOpen
          onGranted={onGranted}
        />,
      ),
    );
    expect(container.querySelector("input")!.value).toBe("");
    await act(async () =>
      finish({ checkoutSessionId: "cs_test_old", url: "https://checkout.stripe.test/old" }),
    );
    expect(tab.location.href).toBe("");
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(getBillingCheckout).not.toHaveBeenCalled();
    expect(onGranted).not.toHaveBeenCalled();
  });
  test("one submission opens checkout and reports the granted credits once", async () => {
    const { tab, opened } = checkoutTab();
    const createBillingCheckout = mock(
      async (_input: Parameters<CreditCheckoutClient["createBillingCheckout"]>[0]) => ({
        checkoutSessionId: "cs_test_credits",
        url: "https://checkout.stripe.test/credits",
      }),
    );
    const status = {
      checkoutSessionId: "cs_test_credits",
      status: "complete",
      credit: { state: "granted", amountMicros: 100_000_000, currency: "usd", free: true },
      balance: null,
    } satisfies BillingCheckoutStatus;
    const onGranted = mock(() => undefined);
    const container = await mount(
      {
        createBillingCheckout,
        getBillingCheckout: mock(async () => status),
      } as CreditCheckoutClient,
      onGranted,
    );
    await enterCode(container, " LAUNCH100 ");
    await submit(container);

    expect(opened).toHaveBeenCalledTimes(1);
    expect(createBillingCheckout).toHaveBeenCalledTimes(1);
    expect(createBillingCheckout.mock.calls[0]?.[0]).toMatchObject({
      accountId: "account-test",
      promotionCode: "LAUNCH100",
    });
    expect(tab.location.href).toBe("https://checkout.stripe.test/credits");
    expect(onGranted).toHaveBeenCalledTimes(1);
    expect(onGranted).toHaveBeenCalledWith(status);
    expect(container.querySelector("input")!.value).toBe("");
  });

  test("invalid codes retain the value, close the blank tab, and return focus for correction", async () => {
    const { tab } = checkoutTab();
    const container = await mount({
      createBillingCheckout: mock(async () => {
        throw new Error("That code isn't valid or has expired.");
      }),
      getBillingCheckout: mock(),
    } as CreditCheckoutClient);
    await enterCode(container, "WRONG");
    await submit(container);

    const input = container.querySelector("input")!;
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("WRONG");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("isn't valid");
    await enterCode(container, "LAUNCH100");
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("switching codes restores focus and ignores a late result from the old checkout", async () => {
    checkoutTab();
    let finish!: (status: BillingCheckoutStatus) => void;
    const onGranted = mock(() => undefined);
    const container = await mount(
      {
        createBillingCheckout: mock(async () => ({
          checkoutSessionId: "cs_test_credits",
          url: "https://checkout.stripe.test/credits",
        })),
        getBillingCheckout: mock(
          () =>
            new Promise<BillingCheckoutStatus>((resolve) => {
              finish = resolve;
            }),
        ),
      } as CreditCheckoutClient,
      onGranted,
    );
    await enterCode(container, "LAUNCH100");
    await submit(container);
    expect(container.textContent).toContain("Finish in Stripe");

    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Use another code")!
        .click();
    });
    const input = await enterCode(container, "NEWCODE");
    expect(document.activeElement).toBe(input);
    await act(async () =>
      finish({
        checkoutSessionId: "cs_test_credits",
        status: "complete",
        credit: { state: "granted", amountMicros: 100_000_000, currency: "usd", free: true },
        balance: null,
      }),
    );
    expect(onGranted).not.toHaveBeenCalled();
    expect(input.value).toBe("NEWCODE");
  });
});
