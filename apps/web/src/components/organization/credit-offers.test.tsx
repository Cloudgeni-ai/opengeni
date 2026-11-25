import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CreditOffer } from "@opengeni/contracts";
import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { CreditOffers, creditOfferDescription } = await import("./credit-offers");
const { OrganizationCreditBalance } = await import("@/components/organization-credit-balance");

const accountId = "11111111-1111-4111-8111-111111111111";
const offer: CreditOffer = {
  id: "22222222-2222-4222-8222-222222222222",
  accountId,
  label: "Design partner credits",
  amountMicros: 2_000_000_000,
  eligibleModelIds: ["gpt-6-luna"],
  validDays: 56,
  activateBy: "2027-01-31T12:00:00.000Z",
  status: "available",
  activatedAt: null,
  expiresAt: null,
};

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});
async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}
function withClient(client: Record<string, unknown>, node: ReactNode) {
  const context = { client } as unknown as AppContextValue;
  // oxlint-disable-next-line react/jsx-no-constructed-context-values -- one stable test fixture
  return <AppContext.Provider value={context}>{node}</AppContext.Provider>;
}

test("describes the amount, models, validity and deadline", () => {
  const text = creditOfferDescription(offer);
  expect(text).toContain("$2,000.00");
  expect(text).toContain("Lasts 56 days from activation");
  expect(text).toContain("Activate by Jan 31, 2027");
});

test("a billing manager activates an available offer; others only see it", async () => {
  const activateCreditOffer = mock(async () => ({ ...offer, status: "active" }));
  const client = {
    listCreditOffers: mock(async () => ({
      offers: [offer, { ...offer, id: "33333333-3333-4333-8333-333333333333", status: "active" }],
      selfServeActivation: true,
    })),
    activateCreditOffer,
  };
  const container = await mount(
    withClient(client, <CreditOffers accountId={accountId} canManage />),
  );
  expect(container.textContent).toContain("Design partner credits");
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Activate"]);
  await act(async () => buttons[0]!.click());
  expect(activateCreditOffer).toHaveBeenCalledWith(offer.id, { accountId });

  await act(async () => root?.unmount());
  const readOnly = await mount(
    withClient(client, <CreditOffers accountId={accountId} canManage={false} />),
  );
  expect(readOnly.querySelector("button")).toBeNull();
  expect(readOnly.textContent).toContain("An owner can activate it");
});

test("while self-serve activation is off, managers are pointed to support", async () => {
  const client = {
    listCreditOffers: mock(async () => ({ offers: [offer], selfServeActivation: false })),
    activateCreditOffer: mock(async () => offer),
  };
  const container = await mount(
    withClient(client, <CreditOffers accountId={accountId} canManage />),
  );
  expect(container.textContent).toContain("Design partner credits");
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("Contact Opengeni support to activate it");
});

test("an active offer shows its expiry in the balance", async () => {
  const container = await mount(
    <OrganizationCreditBalance
      canReadBilling
      hasAccount
      loading={false}
      hasError={false}
      billing={{
        mode: "stripe",
        balance: {
          accountId,
          balanceMicros: 2_000_000_000,
          generalBalanceMicros: 0,
          currency: "usd",
          updatedAt: new Date().toISOString(),
          promotionalCredits: [
            {
              grantId: "44444444-4444-4444-8444-444444444444",
              label: "Design partner credits",
              remainingMicros: 2_000_000_000,
              eligibleModelIds: ["gpt-6-luna"],
              expiresAt: "2027-01-19T12:00:00.000Z",
            },
          ],
        },
      }}
    />,
  );
  expect(container.textContent).toContain("Expires Jan 19, 2027");
});
