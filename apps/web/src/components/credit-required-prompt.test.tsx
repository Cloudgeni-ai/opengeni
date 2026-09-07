import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const getBilling = mock(async () => ({
  mode: "stripe" as const,
  balance: { balanceMicros: 0 },
}));

mock.module("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#models">{children}</a>,
}));

mock.module("@/context", () => ({
  useAppContext: () => ({
    client: { getBilling, createBillingCheckout: mock(async () => ({ url: "https://checkout.test" })) },
  }),
}));

const { CreditRequiredPrompt, EmptyCreditsNotice } = await import("./credit-required-prompt");

beforeAll(() => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  getBilling.mockClear();
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
    expect(document.body.textContent).toContain("Add OpenGeni credits to continue");
    expect(document.body.textContent).toContain("Buy credits");
    expect(document.body.textContent).toContain("Connect a model");
  });

  test("empty-credits notice appears only when the organization balance is empty", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <EmptyCreditsNotice workspaceId="workspace-a" accountId="account-a" canBuyCredits />,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).toContain("This model uses OpenGeni credits");
    expect(container.textContent).toContain("Buy credits");
    expect(container.textContent).toContain("Connect a model");

    await act(async () => root!.unmount());
    getBilling.mockResolvedValueOnce({
      mode: "stripe",
      balance: { balanceMicros: 1 },
    });
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <EmptyCreditsNotice workspaceId="workspace-a" accountId="account-a" canBuyCredits />,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.textContent).not.toContain("This model uses OpenGeni credits");
  });
});
