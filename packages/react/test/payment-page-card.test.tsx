import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { BillingCheckoutStatus } from "@opengeni/sdk";
import { defaultToolRegistry, type ToolCallItem } from "../src/timeline";
import {
  ClientPaymentPageActivity,
  nextPaymentCheckDelay,
  PaymentPageActivityProvider,
} from "../src/timeline/payment-page-card";
import { paymentPageOf } from "../src/timeline/payment-page";
import { activityPresentsImage } from "../src/timeline/presented-image";
import { flush, registerDom, renderComponent, withVirtualClock } from "./render-hook";

registerDom();

afterEach(() => window.localStorage.clear());

const url = "https://checkout.stripe.com/c/pay/cs_test_a1#fidkdWxOYHwnPyd1blpxYHZxWjA0";
const accountId = crypto.randomUUID();
const portalUrl = "https://billing.stripe.com/p/session/x";

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

function portalCall(minutesAgo: number, id = "createBillingPortalSession"): ToolCallItem {
  return checkoutCall({
    arguments: { id },
    output: JSON.stringify({ status: 200, body: { url: portalUrl } }),
    occurredAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  });
}

function click(link: HTMLAnchorElement) {
  link.addEventListener("click", (event) => event.preventDefault());
  link.click();
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
    const item = checkoutCall();
    expect(paymentPageOf(item)).toEqual({
      kind: "credits",
      url,
      checkoutSessionId: "cs_test_a1",
      amountUsd: 20,
      accountId,
      createdAt: Date.parse(item.occurredAt),
    });
    // Named by its route, padded, it's the same page, as the history keeps it.
    expect(
      paymentPageOf(
        checkoutCall({
          arguments: { id: " POST /v1/billing/checkout\n", body: { accountId, amountUsd: 20 } },
        }),
      )?.kind,
    ).toBe("credits");
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
    expect(paymentPageOf(portalCall(0))).toMatchObject({ kind: "portal", url: portalUrl });
    expect(paymentPageOf(portalCall(0))?.checkoutSessionId).toBeUndefined();
    // Like a published image, it stays in view instead of folding into the work.
    expect(activityPresentsImage([checkoutCall()])).toBe(true);
    expect(activityPresentsImage([checkoutCall({ name: "evil__admin_action_call" })])).toBe(false);
  });

  test("the card reads nothing until opened, then confirms the credits once they land", async () => {
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
      // Shown is not opened: nothing is read yet, not even on a return to the tab.
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await flush();
      expect(reads).toEqual([]);

      // The person opens the page; the card waits for the payment.
      await act(async () => {
        click(link!);
      });
      expect(rendered.container.textContent).toContain("Waiting for your payment");

      // They pay and come back to this tab.
      next = status("granted", "complete");
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await flush();
      expect(reads).toEqual([`cs_test_a1:${accountId}`]);
      expect(rendered.container.textContent).toContain("You added $20 in credits");
      expect(rendered.container.textContent).toContain("Balance $25.50");
      expect(rendered.container.querySelector("a[href]")).toBeNull();
      expect(credited).toHaveLength(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("checks back off over time, and stop when the person comes back without paying", async () => {
    expect(nextPaymentCheckDelay(0)).toBe(2_000);
    expect(nextPaymentCheckDelay(59_999)).toBe(2_000);
    expect(nextPaymentCheckDelay(60_000)).toBe(15_000);
    expect(nextPaymentCheckDelay(30 * 60_000 - 1)).toBe(15_000);
    expect(nextPaymentCheckDelay(30 * 60_000)).toBeNull();

    await withVirtualClock(async () => {
      let reads = 0;
      let next = status("pending", "open");
      const item = checkoutCall();
      const Renderer = defaultToolRegistry.resolve(item);
      const rendered = await renderComponent(
        <PaymentPageActivityProvider
          readCheckout={async () => {
            reads += 1;
            return next;
          }}
        >
          <Renderer item={item} />
        </PaymentPageActivityProvider>,
      );
      try {
        await act(async () => {
          click(rendered.container.querySelector<HTMLAnchorElement>("a[href]")!);
        });
        await flush(2_100);
        expect(reads).toBe(1);
        await flush(2_000);
        expect(reads).toBe(2);
        // Back in this tab with the page still open: they cancelled or left it.
        await act(async () => {
          window.dispatchEvent(new Event("focus"));
        });
        await flush();
        expect(reads).toBe(3);
        await flush(60_000);
        expect(reads).toBe(3);
        // They go back and pay after all; the next return confirms it.
        next = status("granted", "complete");
        await act(async () => {
          window.dispatchEvent(new Event("focus"));
        });
        await flush();
        expect(reads).toBe(4);
        expect(rendered.container.textContent).toContain("You added $20 in credits");
      } finally {
        await rendered.unmount();
      }
    });
  });

  test("a paid checkout whose credits are still on their way keeps checking", async () => {
    await withVirtualClock(async () => {
      let reads = 0;
      let next = status("pending", "complete");
      const item = checkoutCall();
      const Renderer = defaultToolRegistry.resolve(item);
      const rendered = await renderComponent(
        <PaymentPageActivityProvider
          readCheckout={async () => {
            reads += 1;
            return next;
          }}
        >
          <Renderer item={item} />
        </PaymentPageActivityProvider>,
      );
      try {
        await act(async () => {
          click(rendered.container.querySelector<HTMLAnchorElement>("a[href]")!);
        });
        await act(async () => {
          window.dispatchEvent(new Event("focus"));
        });
        await flush();
        expect(reads).toBe(1);
        next = status("granted", "complete");
        await flush(2_100);
        expect(reads).toBe(2);
        expect(rendered.container.textContent).toContain("Balance $25.50");
      } finally {
        await rendered.unmount();
      }
    });
  });

  test("a card opened before a reload checks once; one never opened doesn't", async () => {
    const reads: string[] = [];
    const item = checkoutCall();
    const Renderer = defaultToolRegistry.resolve(item);
    const view = () => (
      <PaymentPageActivityProvider
        readCheckout={async (input) => {
          reads.push(input.checkoutSessionId);
          return status("pending", "open");
        }}
      >
        <Renderer item={item} />
      </PaymentPageActivityProvider>
    );
    const first = await renderComponent(view());
    await flush();
    expect(reads).toEqual([]);
    await act(async () => {
      click(first.container.querySelector<HTMLAnchorElement>("a[href]")!);
    });
    await first.unmount();

    const reloaded = await renderComponent(view());
    try {
      await flush(2_500);
      expect(reads).toEqual(["cs_test_a1"]);
      expect(reloaded.container.textContent).toContain("Waiting for your payment");
    } finally {
      await reloaded.unmount();
    }
  });

  test("billing links say where they go, and expire unless opened here", async () => {
    const fresh = portalCall(1);
    const FreshRenderer = defaultToolRegistry.resolve(fresh);
    const rendered = await renderComponent(<FreshRenderer item={fresh} />);
    try {
      expect(rendered.container.querySelector("a[href]")?.getAttribute("href")).toBe(portalUrl);
      expect(rendered.container.textContent).toContain("Opens your billing page in a new tab.");
      expect(rendered.container.textContent).not.toContain("payment page");
    } finally {
      await rendered.unmount();
    }
    // From history: a portal link lasts minutes, a checkout a day.
    for (const item of [
      portalCall(6),
      portalCall(6, "createSubscriptionPortalSession"),
      checkoutCall({
        arguments: { id: "createSubscriptionCheckout" },
        output: JSON.stringify({ status: 200, body: { url } }),
        occurredAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
      }),
    ]) {
      const Renderer = defaultToolRegistry.resolve(item);
      const old = await renderComponent(<Renderer item={item} />);
      try {
        expect(old.container.querySelector("a[href]")).toBeNull();
        expect(old.container.textContent).toContain("This link has expired.");
      } finally {
        await old.unmount();
      }
    }
  });

  test("a conversation checks through its own client, and a host can add onCredited", async () => {
    const reads: string[] = [];
    const credited: BillingCheckoutStatus[] = [];
    const client = {
      getBillingCheckout: async (id: string, options: { accountId?: string }) => {
        reads.push(`${id}:${options.accountId}`);
        return status("granted", "complete");
      },
    };
    const item = checkoutCall();
    const Renderer = defaultToolRegistry.resolve(item);
    const rendered = await renderComponent(
      <PaymentPageActivityProvider onCredited={(value) => credited.push(value)}>
        <ClientPaymentPageActivity client={client}>
          <Renderer item={item} />
        </ClientPaymentPageActivity>
      </PaymentPageActivityProvider>,
    );
    try {
      expect(rendered.container.textContent).toContain(
        "Your credits show up here once you've paid",
      );
      await act(async () => {
        click(rendered.container.querySelector<HTMLAnchorElement>("a[href]")!);
      });
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await flush();
      expect(reads).toEqual([`cs_test_a1:${accountId}`]);
      expect(rendered.container.textContent).toContain("You added $20 in credits");
      expect(credited).toHaveLength(1);
    } finally {
      await rendered.unmount();
    }
    // A client without the billing read can't confirm, and doesn't promise to.
    const plain = await renderComponent(
      <ClientPaymentPageActivity client={{}}>
        <Renderer item={item} />
      </ClientPaymentPageActivity>,
    );
    try {
      expect(plain.container.textContent).toContain("Opens a secure payment page in a new tab.");
      expect(plain.container.textContent).not.toContain("show up here");
    } finally {
      await plain.unmount();
    }
  });

  test("a checkout that names no organization is read for the chat's organization", async () => {
    // The agent's checkout omits accountId, so it is for the chat's
    // organization, which needn't be the person's default.
    const chatAccountId = crypto.randomUUID();
    const reads: (string | undefined)[] = [];
    const client = {
      getBillingCheckout: async (_id: string, options: { accountId?: string }) => {
        reads.push(options.accountId);
        return status("granted", "complete");
      },
    };
    const item = checkoutCall({
      arguments: JSON.stringify({ id: "createBillingCheckout", body: { amountUsd: 20 } }),
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const rendered = await renderComponent(
      <ClientPaymentPageActivity client={client} accountId={chatAccountId}>
        <Renderer item={item} />
      </ClientPaymentPageActivity>,
    );
    try {
      await act(async () => {
        click(rendered.container.querySelector<HTMLAnchorElement>("a[href]")!);
      });
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await flush();
      expect(reads).toEqual([chatAccountId]);
      expect(rendered.container.textContent).toContain("You added $20 in credits");
    } finally {
      await rendered.unmount();
    }
  });

  test("after a reload, a card waits for the chat's organization before it checks", async () => {
    // Opened before the reload, and the chat's organization isn't known yet:
    // asking the default organization would fail and flash "Couldn't check".
    const chatAccountId = crypto.randomUUID();
    const reads: (string | undefined)[] = [];
    const client = {
      getBillingCheckout: async (_id: string, options: { accountId?: string }) => {
        reads.push(options.accountId);
        if (options.accountId !== chatAccountId) {
          throw Object.assign(new Error("API 404: checkout not found"), { retryable: false });
        }
        return status("granted", "complete");
      },
    };
    const item = checkoutCall({
      arguments: JSON.stringify({ id: "createBillingCheckout", body: { amountUsd: 20 } }),
    });
    const Renderer = defaultToolRegistry.resolve(item);
    const before = await renderComponent(
      <ClientPaymentPageActivity client={client} accountId={chatAccountId}>
        <Renderer item={item} />
      </ClientPaymentPageActivity>,
    );
    await act(async () => {
      click(before.container.querySelector<HTMLAnchorElement>("a[href]")!);
    });
    await before.unmount();
    reads.length = 0;

    const view = (account: string | undefined) => (
      <ClientPaymentPageActivity
        client={client}
        accountId={account}
        accountPending={account === undefined}
      >
        <Renderer item={item} />
      </ClientPaymentPageActivity>
    );
    const reloaded = await renderComponent(view(undefined));
    try {
      await flush();
      expect(reads).toEqual([]);
      expect(reloaded.container.textContent).toContain("Waiting for your payment");
      expect(reloaded.container.textContent).not.toContain("Couldn't check");
      await reloaded.rerender(view(chatAccountId));
      await flush();
      expect(reads).toEqual([chatAccountId]);
      expect(reloaded.container.textContent).toContain("You added $20 in credits");
    } finally {
      await reloaded.unmount();
    }
  });

  test("after a dropped connection the card keeps checking, for at most 30 minutes", async () => {
    await withVirtualClock(async () => {
      let reads = 0;
      const item = checkoutCall();
      const Renderer = defaultToolRegistry.resolve(item);
      const rendered = await renderComponent(
        <PaymentPageActivityProvider
          readCheckout={async () => {
            reads += 1;
            // No `retryable: false`: the connection dropped, asking again may work.
            throw new TypeError("Failed to fetch");
          }}
        >
          <Renderer item={item} />
        </PaymentPageActivityProvider>,
      );
      try {
        await act(async () => {
          click(rendered.container.querySelector<HTMLAnchorElement>("a[href]")!);
        });
        await flush(2_100);
        expect(reads).toBe(1);
        expect(rendered.container.textContent).toContain("Couldn't check your payment from here.");
        // Every 2 s for the first minute, then every 15 s.
        await flush(60_000);
        const afterFirstMinute = reads;
        expect(afterFirstMinute).toBeGreaterThanOrEqual(29);
        await flush(60_000);
        expect(reads - afterFirstMinute).toBe(4);
        // Thirty minutes after opening the page, the checks stop for good.
        await flush(30 * 60_000);
        const atCap = reads;
        expect(atCap).toBeLessThanOrEqual(afterFirstMinute + 4 * 29);
        await flush(60 * 60_000);
        expect(reads).toBe(atCap);
      } finally {
        await rendered.unmount();
      }
    });
  });

  test("a check still running when the card goes away is cancelled", async () => {
    const signals: AbortSignal[] = [];
    const client = {
      getBillingCheckout: (_id: string, options: { signal?: AbortSignal }) => {
        signals.push(options.signal!);
        return new Promise<BillingCheckoutStatus>(() => undefined);
      },
    };
    const item = checkoutCall();
    const Renderer = defaultToolRegistry.resolve(item);
    const rendered = await renderComponent(
      <ClientPaymentPageActivity client={client}>
        <Renderer item={item} />
      </ClientPaymentPageActivity>,
    );
    await act(async () => {
      click(rendered.container.querySelector<HTMLAnchorElement>("a[href]")!);
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    await rendered.unmount();
    expect(signals[0]!.aborted).toBe(true);
  });

  test("a check that fails says so instead of waiting on", async () => {
    await withVirtualClock(async () => {
      let reads = 0;
      const item = checkoutCall();
      const Renderer = defaultToolRegistry.resolve(item);
      const rendered = await renderComponent(
        <PaymentPageActivityProvider
          readCheckout={async () => {
            reads += 1;
            throw Object.assign(new Error("API 404: checkout not found"), { retryable: false });
          }}
        >
          <Renderer item={item} />
        </PaymentPageActivityProvider>,
      );
      try {
        await act(async () => {
          click(rendered.container.querySelector<HTMLAnchorElement>("a[href]")!);
        });
        await flush(2_100);
        expect(reads).toBe(1);
        expect(rendered.container.textContent).toContain(
          "Couldn't check your payment from here. If you paid, your credits still arrive.",
        );
        expect(rendered.container.textContent).not.toContain("Waiting for your payment");
        // A refusal doesn't change by asking again: no regular checks follow.
        await flush(5 * 60_000);
        expect(reads).toBe(1);
      } finally {
        await rendered.unmount();
      }
    });
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
      await act(async () => {
        click(rendered.container.querySelector<HTMLAnchorElement>("a[href]")!);
      });
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
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
