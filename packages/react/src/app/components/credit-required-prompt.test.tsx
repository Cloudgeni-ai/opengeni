import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BillingPlanBalance } from "@opengeni/sdk";

type TestBillingSummary = {
  mode: "stripe" | "disabled";
  balance: { balanceMicros: number; plan?: BillingPlanBalance | undefined };
};

const getBilling = mock(
  async (_options?: { accountId?: string | undefined }): Promise<TestBillingSummary> => ({
    mode: "stripe",
    balance: { balanceMicros: 0 },
  }),
);
const createBillingCheckout = mock(async () => ({ url: "https://checkout.test" }));
const client = { getBilling, createBillingCheckout };
// What the page did, in order: the draft saved, then the checkout opened.
const pageSteps: string[] = [];

mock.module("../lib/navigation", () => ({
  usePage: () => ({
    origin: () => window.location.origin,
    href: () => window.location.href,
    assign: (url: string) => void pageSteps.push(`assign ${url}`),
  }),
  Link: ({
    children,
    to,
    params,
    search,
  }: {
    children: ReactNode;
    to: string;
    params: { workspaceId: string };
    search: { section: string; workspace?: string | undefined };
  }) => (
    <a
      href={`${to.replace("$workspaceId", params.workspaceId)}?section=${search.section}${
        search.workspace ? `&workspace=${search.workspace}` : ""
      }`}
    >
      {children}
    </a>
  ),
}));

mock.module("../app-context", () => ({
  useAppContext: () => ({
    client,
  }),
}));

mock.module("../../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

const { CreditRequiredPrompt, CreditRequiredPromptView, EmptyCreditsNotice } =
  await import("./credit-required-prompt");

beforeAll(() => {
  try {
    GlobalRegistrator.register();
  } catch {
    // Another web test in this process already installed Happy DOM.
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  getBilling.mockClear();
  getBilling.mockImplementation(async () => ({
    mode: "stripe" as const,
    balance: { balanceMicros: 0 },
  }));
  createBillingCheckout.mockClear();
});

describe("credit required prompt", () => {
  test("an enrolled Free account offers plans while a disabled catalog preserves the legacy action", async () => {
    const plan: BillingPlanBalance = {
      key: "free",
      label: "Free",
      status: "active",
      creditGrantedMicros: 10_000_000,
      creditRemainingMicros: 0,
      periodResetAt: null,
      seatsUsed: 1,
      seatLimit: 5,
      cancelAtPeriodEnd: false,
    };
    getBilling.mockResolvedValue({ mode: "stripe", balance: { balanceMicros: 0, plan } });
    const getBillingSubscriptionPlans = mock(async () => ({
      accountId: "account-a",
      revision: 1,
      plan,
      plans: [
        {
          key: "pro",
          label: "Pro",
          monthlyPriceMicros: 20_000_000,
          monthlyCreditMicros: 200_000_000,
          seatLimit: 10,
          freeCredit: false,
          stripePriceId: "price_pro",
          selfService: true,
        },
      ],
    }));
    const custom = { ...client, getBillingSubscriptionPlans } as unknown as Parameters<
      typeof CreditRequiredPromptView
    >[0]["client"];
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = async (open: boolean) =>
      act(async () =>
        root!.render(
          <CreditRequiredPromptView
            client={custom}
            open={open}
            workspaceId="workspace-a"
            accountId="account-a"
            canBuyCredits
            onOpenChange={() => undefined}
          />,
        ),
      );
    await render(true);
    expect(container.textContent).toContain("View upgrade options");
    expect(container.textContent).toContain("Add credits");
    expect(
      container.querySelector('a[href="/workspaces/workspace-a/organization?section=billing"]'),
    ).not.toBeNull();
    await render(false);
    getBillingSubscriptionPlans.mockImplementation(async () => {
      throw Object.assign(new Error("disabled"), { status: 404 });
    });
    await render(true);
    expect(container.textContent).not.toContain("View upgrade options");
    expect(container.textContent).toContain("Use your own provider account");
  });

  test("the notice follows selected-model funding rather than the total credit balance", async () => {
    getBilling.mockResolvedValue({ mode: "stripe", balance: { balanceMicros: 100_000_000 } });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = async (creditFunding: "unavailable" | "promotional" | "general") =>
      act(async () =>
        root!.render(
          <EmptyCreditsNotice
            workspaceId="workspace-a"
            accountId="account-a"
            canBuyCredits
            canReadBilling
            creditFunding={creditFunding}
          />,
        ),
      );
    await render("unavailable");
    // Credit is left, only not for this model: say that, never "you don't have any".
    expect(container.textContent).toContain("This model can't use the Opengeni credits you have");
    expect(container.textContent).not.toContain("you don't have any");
    await render("promotional");
    expect(container.textContent).toBe("");
    await render("general");
    expect(container.textContent).toBe("");
  });

  test("usable free credits do not show a warning when general charges made the total negative", async () => {
    getBilling.mockResolvedValue({ mode: "stripe", balance: { balanceMicros: -1_000_000 } });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <EmptyCreditsNotice
          workspaceId="workspace-a"
          accountId="account-a"
          canBuyCredits
          canReadBilling
          creditFunding="promotional"
        />,
      ),
    );
    expect(container.textContent).toBe("");
  });
  test("create-session dialog names buy credits and connect a model", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <CreditRequiredPrompt
          open
          workspaceId="workspace-a"
          accountId="account-a"
          canBuyCredits
          onOpenChange={() => undefined}
        />,
      ),
    );
    expect(container.textContent).toContain("Add Opengeni credits to continue");
    expect(container.textContent).toContain("Add credits");
    expect(container.textContent).toContain("Use your own provider account");
    expect(
      container.querySelector(
        'a[href="/workspaces/workspace-a/organization?section=models&workspace=workspace-a"]',
      ),
    ).not.toBeNull();
  });

  test("workspace top-up accepts a $10 gift package and returns to the page it started on", async () => {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
      "https://app.example.test/workspaces/workspace-a/sessions?draft=1#composer",
    );
    createBillingCheckout.mockImplementationOnce(async () => {
      throw new Error("checkout test");
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <CreditRequiredPromptView
          client={client as never}
          purpose="topup"
          open
          workspaceId="workspace-a"
          accountId="account-a"
          canBuyCredits
          onOpenChange={() => undefined}
        />,
      ),
    );
    expect(container.textContent).toContain("Add Opengeni credits");
    expect(container.textContent).toContain("Have a code?");
    expect(container.textContent).not.toContain("Use your own provider account");
    const preset = container.querySelector<HTMLSelectElement>("#credit-preset")!;
    await act(async () => {
      preset.value = "10.00";
      preset.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const checkout = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Continue to Stripe",
    )!;
    await act(async () => checkout.click());
    expect(createBillingCheckout).toHaveBeenCalledWith({
      amountUsd: 10,
      accountId: "account-a",
      successUrl:
        "https://app.example.test/workspaces/workspace-a/sessions?draft=1&checkoutReturn=success&checkoutAccount=account-a&checkoutSession={CHECKOUT_SESSION_ID}",
      cancelUrl:
        "https://app.example.test/workspaces/workspace-a/sessions?draft=1&checkoutReturn=cancelled&checkoutAccount=account-a",
    });
  });

  test("the draft is saved before the page leaves for checkout, and a failed save doesn't block it", async () => {
    for (const saves of [true, false]) {
      pageSteps.length = 0;
      const beforeLeave = mock(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        pageSteps.push("draft saved");
        if (!saves) throw new Error("conflict");
      });
      const container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () =>
        root!.render(
          <CreditRequiredPromptView
            client={client as never}
            purpose="topup"
            open
            workspaceId="workspace-a"
            accountId="account-a"
            canBuyCredits
            onOpenChange={() => undefined}
            beforeLeave={beforeLeave}
          />,
        ),
      );
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
      await act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === "Continue to Stripe")!
          .click(),
      );
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));
      expect(beforeLeave).toHaveBeenCalledTimes(1);
      expect(pageSteps).toEqual(["draft saved", "assign https://checkout.test"]);
      await act(async () => root!.unmount());
      root = undefined;
      container.remove();
    }
  });

  test("empty-credits notice appears only when the organization balance is empty", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <EmptyCreditsNotice
          workspaceId="workspace-a"
          accountId="account-a"
          canBuyCredits
          canReadBilling
        />,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toContain("Add credits to start chatting");
    expect(container.textContent).toContain("you don't have any right now");
    // Without an in-page prompt, Add credits opens billing.
    expect(
      [...container.querySelectorAll("a")].some(
        (node) =>
          node.textContent?.includes("Add credits") &&
          node.getAttribute("href") === "/workspaces/workspace-a/organization?section=billing",
      ),
    ).toBeTrue();
    expect(container.textContent).toContain("Use your own provider account");
    expect(
      container.querySelector(
        'a[href="/workspaces/workspace-a/organization?section=models&workspace=workspace-a"]',
      ),
    ).not.toBeNull();
    const connect = [...container.querySelectorAll("a")].find((node) =>
      node.textContent?.includes("Use your own provider account"),
    );
    expect(connect?.closest(".min-w-0")).not.toBeNull();

    await act(async () => root!.unmount());
    getBilling.mockResolvedValueOnce({
      mode: "stripe",
      balance: { balanceMicros: 1 },
    });
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <EmptyCreditsNotice
          workspaceId="workspace-a"
          accountId="account-a"
          canBuyCredits
          canReadBilling
        />,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).not.toContain("Add credits to start chatting");
  });

  test("negative balance uses honest funding copy without claiming this is the first chat", async () => {
    getBilling.mockImplementation(async () => ({
      mode: "stripe",
      balance: { balanceMicros: -2_000_000 },
    }));
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <EmptyCreditsNotice
          workspaceId="workspace-a"
          accountId="account-a"
          canBuyCredits
          canReadBilling
        />,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toContain("you don't have any right now");
    expect(container.textContent).not.toContain("first chat");
  });

  test("Add credits opens the page's own prompt when one is given", async () => {
    getBilling.mockResolvedValue({ mode: "stripe", balance: { balanceMicros: 0 } });
    const onAddCredits = mock(() => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <EmptyCreditsNotice
          workspaceId="workspace-a"
          accountId="account-a"
          canBuyCredits
          canReadBilling
          creditFunding="unavailable"
          onAddCredits={onAddCredits}
        />,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    const add = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Add credits",
    );
    expect(add).toBeDefined();
    expect(
      container.querySelector('a[href="/workspaces/workspace-a/organization?section=billing"]'),
    ).toBeNull();
    await act(async () => add!.click());
    expect(onAddCredits).toHaveBeenCalledTimes(1);
  });

  test("without billing permission it says who can add credits", async () => {
    getBilling.mockResolvedValue({ mode: "stripe", balance: { balanceMicros: 0 } });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <EmptyCreditsNotice
          workspaceId="workspace-a"
          accountId="account-a"
          canBuyCredits={false}
          canReadBilling
          creditFunding="unavailable"
        />,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toContain("No credits left");
    expect(container.textContent).toContain("Ask an organization owner");
    expect(container.textContent).not.toContain("Add credits");
  });

  test("disabled billing never shows an empty-credits notice", async () => {
    getBilling.mockResolvedValue({ mode: "disabled", balance: { balanceMicros: 0 } });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <EmptyCreditsNotice
          workspaceId="workspace-a"
          accountId="account-a"
          canBuyCredits
          canReadBilling
        />,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toBe("");
  });

  test("empty-credits notice does not probe billing without read permission", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <EmptyCreditsNotice
          workspaceId="workspace-a"
          accountId="account-a"
          canBuyCredits
          canReadBilling={false}
        />,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(getBilling).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Add credits to start chatting");
  });

  test("hides purchase actions when billing is disabled", async () => {
    getBilling.mockResolvedValue({ mode: "disabled", balance: { balanceMicros: 0 } });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <CreditRequiredPrompt
          open
          workspaceId="workspace-a"
          accountId="account-a"
          canBuyCredits
          onOpenChange={() => undefined}
        />,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Add credits",
      ),
    ).toBeFalse();
  });

  test("rejects checkout amounts with sub-cent precision", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <CreditRequiredPromptView
          client={client as never}
          open
          workspaceId="workspace-a"
          accountId="account-a"
          canBuyCredits
          onOpenChange={() => undefined}
        />,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    const preset = container.querySelector<HTMLSelectElement>("#credit-preset")!;
    await act(async () => {
      preset.value = "custom";
      preset.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Custom credit amount in USD"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "5.001",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const buy = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Add credits",
    )!;
    expect(buy.disabled).toBeTrue();
    expect(createBillingCheckout).not.toHaveBeenCalled();
  });

  test("clears an empty notice while a new account balance is loading", async () => {
    let resolveSecond!: (value: TestBillingSummary) => void;
    getBilling.mockImplementation(async (options?: { accountId?: string | undefined }) => {
      const accountId = options?.accountId;
      if (accountId === "account-a") {
        return { mode: "stripe" as const, balance: { balanceMicros: 0 } };
      }
      return await new Promise((resolve) => {
        resolveSecond = resolve;
      });
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = (accountId: string) =>
      root!.render(
        <EmptyCreditsNotice
          workspaceId="workspace-a"
          accountId={accountId}
          canBuyCredits
          canReadBilling
        />,
      );
    await act(async () => render("account-a"));
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toContain("Add credits to start chatting");
    await act(async () => render("account-b"));
    expect(container.textContent).not.toContain("Add credits to start chatting");
    await act(async () => resolveSecond({ mode: "stripe", balance: { balanceMicros: 1 } }));
  });
});
