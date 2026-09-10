import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

type TestBillingSummary = {
  mode: "stripe" | "disabled";
  balance: { balanceMicros: number };
};

const getBilling = mock(
  async (_options?: { accountId?: string }): Promise<TestBillingSummary> => ({
    mode: "stripe",
    balance: { balanceMicros: 0 },
  }),
);
const createBillingCheckout = mock(async () => ({ url: "https://checkout.test" }));
const client = { getBilling, createBillingCheckout };

mock.module("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
  }: {
    children: ReactNode;
    to: string;
    params: { workspaceId: string };
    search: { section: string };
  }) => (
    <a href={`${to.replace("$workspaceId", params.workspaceId)}?section=${search.section}`}>
      {children}
    </a>
  ),
}));

mock.module("@/context", () => ({
  useAppContext: () => ({
    client,
  }),
}));

mock.module("@/components/ui/dialog", () => ({
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
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
    expect(container.textContent).toContain("Add OpenGeni credits to continue");
    expect(container.textContent).toContain("Buy credits");
    expect(container.textContent).toContain("Connect a model");
    expect(
      container.querySelector('a[href="/workspaces/workspace-a/settings?section=models"]'),
    ).not.toBeNull();
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
    expect(container.textContent).toContain("This model uses OpenGeni credits");
    expect(container.textContent).toContain("Buy credits");
    expect(container.textContent).toContain("Connect a model");
    expect(
      container.querySelector('a[href="/workspaces/workspace-a/settings?section=models"]'),
    ).not.toBeNull();
    const connect = [...container.querySelectorAll("a")].find((node) =>
      node.textContent?.includes("Connect a model"),
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
    expect(container.textContent).not.toContain("This model uses OpenGeni credits");
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
    expect(container.textContent).not.toContain("This model uses OpenGeni credits");
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
        (button) => button.textContent?.trim() === "Buy credits",
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
      (button) => button.textContent?.trim() === "Buy credits",
    )!;
    expect(buy.disabled).toBeTrue();
    expect(createBillingCheckout).not.toHaveBeenCalled();
  });

  test("clears an empty notice while a new account balance is loading", async () => {
    let resolveSecond!: (value: TestBillingSummary) => void;
    getBilling.mockImplementation(async (options?: { accountId?: string }) => {
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
    expect(container.textContent).toContain("This model uses OpenGeni credits");
    await act(async () => render("account-b"));
    expect(container.textContent).not.toContain("This model uses OpenGeni credits");
    await act(async () => resolveSecond({ mode: "stripe", balance: { balanceMicros: 1 } }));
  });
});
