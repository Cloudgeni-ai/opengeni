import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { CreditProtectionClient } from "./credit-protection-settings";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { CreditProtectionSettings } = await import("./credit-protection-settings");

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function auto(accountId = "org-a") {
  return {
    accountId,
    enabled: false,
    thresholdMicros: 10_000_000,
    amountMicros: 25_000_000,
    monthlyCapMicros: 100_000_000,
    spentThisMonthMicros: 0,
    status: "off" as const,
    paymentMethod: { brand: "Visa", last4: "4242" },
  };
}

function client(overrides: Partial<CreditProtectionClient> = {}): CreditProtectionClient {
  return {
    getBillingAlertSettings: async ({ accountId }) => ({
      accountId,
      lowBalanceThresholdMicros: 10_000_000,
    }),
    updateBillingAlertSettings: async (value) => value,
    getBillingAutoTopUp: async ({ accountId }) => auto(accountId),
    updateBillingAutoTopUp: async (value) => ({ ...auto(value.accountId), ...value }),
    createBillingAutoTopUpSetupSession: async () => ({ url: "https://checkout.stripe.com/test" }),
    ...overrides,
  };
}

function panel(api: CreditProtectionClient, accountId = "org-a", extra = {}) {
  return (
    <CreditProtectionSettings
      key={accountId}
      client={api}
      accountId={accountId}
      canManageAlerts
      canManageAutoTopUp
      returnUrl="https://app.opengeni.ai/workspaces/a/organization?section=billing"
      {...extra}
    />
  );
}

async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}

async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(Boolean(button)).toBe(true);
  await act(async () => button!.click());
}

async function change(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(Boolean(input)).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function apiFailure(status: number) {
  return Object.assign(new Error(`Opengeni API ${status}: Unavailable.`), { status });
}

test("a disabled auto-top-up endpoint does not hide working alert settings", async () => {
  await mount(
    panel(
      client({
        getBillingAutoTopUp: async () => {
          throw apiFailure(404);
        },
      }),
    ),
  );
  expect(document.body.textContent).toContain("Credit alerts");
  expect(document.body.textContent).not.toContain("Automatic top-up");
  expect(document.body.textContent).not.toContain("Try again");
});

test("failed alert reads retry independently while automatic top-up remains available", async () => {
  let failed = true;
  const getAuto = mock(async ({ accountId }: { accountId: string }) => auto(accountId));
  const getAlerts = mock(async ({ accountId }: { accountId: string }) => {
    if (failed) throw new TypeError("Failed to fetch");
    return { accountId, lowBalanceThresholdMicros: 20_000_000 };
  });
  await mount(panel(client({ getBillingAlertSettings: getAlerts, getBillingAutoTopUp: getAuto })));
  expect(document.body.textContent).toContain("Couldn't load credit alerts");
  expect(document.body.textContent).toContain("Automatic top-up");
  failed = false;
  await click("Try again");
  expect(getAlerts).toHaveBeenCalledTimes(2);
  expect(getAuto).toHaveBeenCalledTimes(1);
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Notify below (USD)"]')?.value,
  ).toBe("20");
});

test("permission denial is not retried and read-only billing does not grant card consent", async () => {
  const update = mock(
    async (value: Parameters<CreditProtectionClient["updateBillingAutoTopUp"]>[0]) => ({
      ...auto(value.accountId),
      ...value,
    }),
  );
  await mount(
    panel(
      client({
        getBillingAlertSettings: async () => {
          throw apiFailure(403);
        },
        updateBillingAutoTopUp: update,
      }),
      "org-a",
      { canManageAutoTopUp: false },
    ),
  );
  expect(document.body.textContent).toContain("Ask an organization owner");
  expect(document.body.textContent).not.toContain("Try again");
  expect(Boolean(document.querySelector("button, input"))).toBe(false);
  expect(update).not.toHaveBeenCalled();
});

test("a read started before a save cannot overwrite the confirmed setting", async () => {
  let resolveRead!: (result: { accountId: string; lowBalanceThresholdMicros: number }) => void;
  let first = true;
  const api = client({
    getBillingAlertSettings: async ({ accountId }) => {
      if (first) {
        first = false;
        return { accountId, lowBalanceThresholdMicros: 10_000_000 };
      }
      return new Promise((resolve) => {
        resolveRead = resolve;
      });
    },
  });
  await mount(panel(api));
  await change("Notify below (USD)", "25");
  await act(async () => window.dispatchEvent(new Event("focus")));
  await click("Save alert threshold");
  await act(async () => resolveRead({ accountId: "org-a", lowBalanceThresholdMicros: 10_000_000 }));
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="Notify below (USD)"]')?.value,
  ).toBe("25");
  expect(document.body.textContent).toContain("Alert threshold saved.");
});

test("successful saves update the controller snapshot before unrelated rerenders", async () => {
  const update = mock(
    async (value: Parameters<CreditProtectionClient["updateBillingAutoTopUp"]>[0]) => ({
      ...auto(value.accountId),
      ...value,
      status: "ready" as const,
    }),
  );
  const api = client({ updateBillingAutoTopUp: update });
  await mount(panel(api));
  await click("Set up");
  await click("Turn on automatic top-up");
  await act(async () => root!.render(panel(api)));
  expect(document.body.textContent).toContain("Turn off automatic top-up");
  expect(update.mock.calls[0]![0]).toMatchObject({ accountId: "org-a", enabled: true });
  expect(update.mock.calls[0]![0].idempotencyKey).toMatch(/^[\da-f-]{36}$/u);
});

test("setup retries keep their request key and never imply enrollment", async () => {
  let failed = true;
  const setup = mock(
    async (
      _request: Parameters<CreditProtectionClient["createBillingAutoTopUpSetupSession"]>[0],
    ) => {
      if (failed) throw new TypeError("Failed to fetch");
      return { url: "https://checkout.stripe.com/test" };
    },
  );
  const navigate = mock((_url: string) => {});
  const update = mock(
    async (value: Parameters<CreditProtectionClient["updateBillingAutoTopUp"]>[0]) => ({
      ...auto(value.accountId),
      ...value,
    }),
  );
  await mount(
    panel(
      client({
        getBillingAutoTopUp: async () => ({ ...auto(), paymentMethod: null }),
        createBillingAutoTopUpSetupSession: setup,
        updateBillingAutoTopUp: update,
      }),
      "org-a",
      { onNavigate: navigate },
    ),
  );
  await click("Set up");
  await click("Set up card");
  failed = false;
  await click("Set up card");
  expect(setup).toHaveBeenCalledTimes(2);
  expect(setup.mock.calls[0]![0]).toEqual(setup.mock.calls[1]![0]);
  expect(setup.mock.calls[0]![0]).toMatchObject({
    accountId: "org-a",
    successUrl: "https://app.opengeni.ai/workspaces/a/organization?section=billing",
    cancelUrl: "https://app.opengeni.ai/workspaces/a/organization?section=billing",
  });
  expect(navigate).toHaveBeenCalledWith("https://checkout.stripe.com/test");
  expect(update).not.toHaveBeenCalled();
});

test("a previous identity's setup response cannot navigate the new organization's page", async () => {
  let resolveSetup!: (value: { url: string }) => void;
  const navigate = mock((_url: string) => {});
  const api = client({
    getBillingAutoTopUp: async ({ accountId }) => ({ ...auto(accountId), paymentMethod: null }),
    createBillingAutoTopUpSetupSession: async () =>
      new Promise((resolve) => {
        resolveSetup = resolve;
      }),
  });
  await mount(panel(api, "org-a", { onNavigate: navigate }));
  await click("Set up");
  await click("Set up card");
  await act(async () => root!.render(panel(api, "org-b", { onNavigate: navigate })));
  await act(async () => resolveSetup({ url: "https://checkout.stripe.com/old-account" }));
  expect(navigate).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Opening Stripe");
});

test("a mismatched organization's response is rejected before it becomes visible", async () => {
  await mount(
    panel(
      client({
        getBillingAutoTopUp: async () => ({ ...auto("wrong-org"), monthlyCapMicros: 123_000_000 }),
      }),
    ),
  );
  expect(document.body.textContent).toContain("Couldn't load automatic top-up");
  expect(document.body.textContent).not.toContain("$123");
  expect(document.body.textContent).toContain("Credit alerts");
});

test("card setup does not redirect after the current viewer loses owner permission", async () => {
  let resolveSetup!: (value: { url: string }) => void;
  const navigate = mock((_url: string) => {});
  const api = client({
    getBillingAutoTopUp: async () => ({ ...auto(), paymentMethod: null }),
    createBillingAutoTopUpSetupSession: async () =>
      new Promise((resolve) => {
        resolveSetup = resolve;
      }),
  });
  await mount(panel(api, "org-a", { onNavigate: navigate }));
  await click("Set up");
  await click("Set up card");
  await act(async () =>
    root!.render(panel(api, "org-a", { onNavigate: navigate, canManageAutoTopUp: false })),
  );
  await act(async () => resolveSetup({ url: "https://checkout.stripe.com/no-longer-owner" }));
  expect(navigate).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Set up card");
});

for (const status of [401, 403, 404]) {
  test(`card setup cannot redirect after a refresh returns HTTP ${status}`, async () => {
    let resolveSetup!: (value: { url: string }) => void;
    let refused = false;
    const navigate = mock((_url: string) => {});
    const api = client({
      getBillingAutoTopUp: async () => {
        if (refused) throw apiFailure(status);
        return { ...auto(), paymentMethod: null };
      },
      createBillingAutoTopUpSetupSession: async () =>
        new Promise((resolve) => {
          resolveSetup = resolve;
        }),
    });
    await mount(panel(api, "org-a", { onNavigate: navigate }));
    await click("Set up");
    await click("Set up card");
    refused = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(document.body.textContent).not.toContain("Set up card");
    await act(async () => resolveSetup({ url: "https://checkout.stripe.com/refused" }));
    expect(navigate).not.toHaveBeenCalled();
  });

  test(`HTTP ${status} blocks setup before React renders the refusal`, async () => {
    let rejectRefresh!: (failure: Error) => void;
    let resolveSetup!: (value: { url: string }) => void;
    let refreshing = false;
    const navigate = mock((_url: string) => {});
    const api = client({
      getBillingAutoTopUp: async () => {
        if (!refreshing) return { ...auto(), paymentMethod: null };
        return new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        });
      },
      createBillingAutoTopUpSetupSession: async () =>
        new Promise((resolve) => {
          resolveSetup = resolve;
        }),
    });
    await mount(panel(api, "org-a", { onNavigate: navigate }));
    await click("Set up");
    await click("Set up card");
    refreshing = true;
    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => {
      rejectRefresh(apiFailure(status));
      // Both responses settle in one React batch. The refusal's catch runs, but
      // the component has not rerendered its state-derived navigation guard.
      await Promise.resolve();
      await Promise.resolve();
      resolveSetup({ url: "https://checkout.stripe.com/refused-before-render" });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(navigate).not.toHaveBeenCalled();
  });
}
