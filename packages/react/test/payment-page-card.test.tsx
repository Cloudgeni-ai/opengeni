import { describe, expect, test } from "bun:test";
import { act } from "react";
import type { BillingCheckoutStatus } from "@opengeni/sdk";
import { defaultToolRegistry, type ToolCallItem } from "../src/timeline";
import { PaymentPageActivityProvider } from "../src/timeline/payment-page-card";
import { paymentPageOf } from "../src/timeline/payment-page";
import { activityPresentsImage } from "../src/timeline/presented-image";
import { flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const url = "https://checkout.stripe.com/c/pay/cs_test_a1#fidkdWxOYHwnPyd1blpxYHZxWjA0";
const accountId = crypto.randomUUID();

function checkoutCall(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    kind: "tool-call",
    id: "tool",
    turnId: "turn",
    callId: "call",
    name: "opengeni__admin_action_call",
    arguments: JSON.stringify({ id: "createBillingCheckout", body: { accountId, amountUsd: 20 } }),
    output: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: 200,
            body: { checkoutSessionId: "cs_test_a1", url, amountUsd: 20 },
            note: "The chat shows the person this page as a button.",
          }),
        },
      ],
    },
    raw: undefined,
    status: "complete",
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

function status(
  state: "pending" | "granted",
  checkout: "open" | "complete",
): BillingCheckoutStatus {
  return {
    checkoutSessionId: "cs_test_a1",
    status: checkout,
    credit: { state, amountMicros: 20_000_000, currency: "usd", free: false },
    balance:
      state === "granted"
        ? {
            accountId,
            balanceMicros: 25_500_000,
            currency: "usd",
            updatedAt: new Date().toISOString(),
          }
        : null,
  } as BillingCheckoutStatus;
}

describe("payment pages in the chat", () => {
  test("only the first-party app action's successful payment page is one", () => {
    expect(paymentPageOf(checkoutCall())).toEqual({
      kind: "credits",
      url,
      checkoutSessionId: "cs_test_a1",
      amountUsd: 20,
      accountId,
    });
    // Another server's tool of the same name never draws a payment button.
    expect(paymentPageOf(checkoutCall({ name: "evil__admin_action_call" }))).toBeNull();
    // Nor does any other action, a refusal, a page that isn't secure, or a running call.
    expect(
      paymentPageOf(checkoutCall({ arguments: { id: "createOrganizationInvitation" } })),
    ).toBeNull();
    expect(
      paymentPageOf(
        checkoutCall({
          output: { content: [{ type: "text", text: "Nothing was run: …" }], isError: true },
        }),
      ),
    ).toBeNull();
    expect(
      paymentPageOf(
        checkoutCall({
          output: JSON.stringify({ status: 200, body: { url: "javascript:alert(1)" } }),
        }),
      ),
    ).toBeNull();
    expect(paymentPageOf(checkoutCall({ status: "running" }))).toBeNull();
    // The billing portal is a page too, without a payment to confirm.
    expect(
      paymentPageOf(
        checkoutCall({
          arguments: { id: "createBillingPortalSession" },
          output: JSON.stringify({
            status: 200,
            body: { portalSessionId: "bps_1", url: "https://billing.stripe.com/p/session/x" },
          }),
        }),
      ),
    ).toEqual({ kind: "portal", url: "https://billing.stripe.com/p/session/x" });
    // Like a published image, it stays in view instead of folding into the work.
    expect(activityPresentsImage([checkoutCall()])).toBe(true);
    expect(activityPresentsImage([checkoutCall({ name: "evil__admin_action_call" })])).toBe(false);
  });

  test("the card opens the exact page and confirms the credits once they land", async () => {
    const reads: string[] = [];
    const credited: BillingCheckoutStatus[] = [];
    let next = status("pending", "open");
    const item = checkoutCall();
    const Renderer = defaultToolRegistry.resolve(item);
    const rendered = await renderComponent(
      <PaymentPageActivityProvider
        readCheckout={async (input) => {
          reads.push(`${input.checkoutSessionId}:${input.accountId}`);
          return next;
        }}
        onCredited={(value) => credited.push(value)}
      >
        <Renderer item={item} />
      </PaymentPageActivityProvider>,
    );
    try {
      await flush();
      const link = rendered.container.querySelector<HTMLAnchorElement>("a[href]");
      expect(link?.getAttribute("href")).toBe(url);
      expect(link?.target).toBe("_blank");
      expect(link?.rel).toContain("noopener");
      expect(link?.textContent).toContain("Pay $20");
      expect(rendered.container.textContent).toContain(
        "Your credits show up here once you've paid",
      );
      expect(reads).toEqual([`cs_test_a1:${accountId}`]);

      // The person opens the page; the card waits for the payment.
      await act(async () => {
        link!.addEventListener("click", (event) => event.preventDefault());
        link!.click();
      });
      expect(rendered.container.textContent).toContain("Waiting for your payment");

      // They pay and come back to this tab.
      next = status("granted", "complete");
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await flush();
      expect(rendered.container.textContent).toContain("You added $20 in credits");
      expect(rendered.container.textContent).toContain("Balance $25.50");
      expect(rendered.container.querySelector("a[href]")).toBeNull();
      expect(credited).toHaveLength(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("without a way to check, the card still opens the page and promises nothing", async () => {
    const item = checkoutCall();
    const Renderer = defaultToolRegistry.resolve(item);
    const rendered = await renderComponent(<Renderer item={item} />);
    try {
      expect(rendered.container.querySelector("a[href]")?.getAttribute("href")).toBe(url);
      expect(rendered.container.textContent).toContain("Opens a secure payment page in a new tab.");
      expect(rendered.container.textContent).not.toContain("show up here");
    } finally {
      await rendered.unmount();
    }
  });

  test("an expired page says nothing was charged", async () => {
    const item = checkoutCall();
    const Renderer = defaultToolRegistry.resolve(item);
    const rendered = await renderComponent(
      <PaymentPageActivityProvider
        readCheckout={async () => ({ ...status("pending", "open"), status: "expired" })}
      >
        <Renderer item={item} />
      </PaymentPageActivityProvider>,
    );
    try {
      await flush();
      expect(rendered.container.textContent).toContain(
        "This payment page expired. Nothing was charged.",
      );
      expect(rendered.container.querySelector("a[href]")).toBeNull();
    } finally {
      await rendered.unmount();
    }
  });
});
