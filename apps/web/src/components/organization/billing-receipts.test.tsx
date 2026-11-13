import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { BillingReceipt, ListBillingReceiptsQuery } from "@opengeni/sdk";
import { OpenGeniApiError } from "@opengeni/sdk";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { BillingReceiptsSection } = await import("./billing-receipts");

const accountId = "7d6c2b1e-4a5f-4e3d-9c8b-1a2b3c4d5e6f";
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
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return container;
}

function receipt(id: string, patch: Partial<BillingReceipt> = {}): BillingReceipt {
  return {
    id,
    createdAt: "2026-11-02T10:00:00.000Z",
    kind: "credits",
    description: "Credits",
    amount: 2500,
    currency: "usd",
    amountRefunded: 0,
    refunded: false,
    receiptUrl: `https://pay.stripe.com/receipts/${id}`,
    invoiceUrl: null,
    invoicePdfUrl: null,
    ...patch,
  };
}

function receiptLinks(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLAnchorElement>("a")].filter(
    (link) => link.textContent?.trim() === "Receipt",
  );
}

test("lists every payment with its receipt, refunds and more pages", async () => {
  const listBillingReceipts = mock(async (query: ListBillingReceiptsQuery) =>
    query.cursor
      ? { receipts: [receipt("ch_old", { description: "Plan", kind: "plan" })], nextCursor: null }
      : {
          receipts: [
            receipt("ch_auto", { kind: "auto_top_up", description: "Automatic top-up" }),
            receipt("ch_plan", {
              kind: "plan",
              description: "Plan",
              invoicePdfUrl: "https://pay.stripe.com/invoice/in_plan/pdf",
              invoiceUrl: "https://invoice.stripe.com/i/in_plan",
            }),
            receipt("ch_partly", { amountRefunded: 1000 }),
            receipt("ch_refunded", { amountRefunded: 2500, refunded: true }),
          ],
          nextCursor: "ch_refunded",
        },
  );
  const container = await mount(
    <BillingReceiptsSection client={{ listBillingReceipts }} accountId={accountId} />,
  );

  expect(listBillingReceipts).toHaveBeenCalledWith({ accountId, limit: 10 });
  expect(container.textContent).toContain("Automatic top-up");
  expect(container.textContent).toContain("$25.00");
  expect(container.textContent).toContain("$10.00 refunded");
  expect(container.textContent).toContain("Refunded");
  expect(receiptLinks(container).map((link) => link.href)).toEqual([
    "https://pay.stripe.com/receipts/ch_auto",
    "https://pay.stripe.com/invoice/in_plan/pdf",
    "https://pay.stripe.com/receipts/ch_partly",
    "https://pay.stripe.com/receipts/ch_refunded",
  ]);
  expect(receiptLinks(container).every((link) => link.target === "_blank")).toBe(true);

  const more = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Show more",
  );
  await act(async () => more!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(listBillingReceipts).toHaveBeenLastCalledWith({
    accountId,
    cursor: "ch_refunded",
    limit: 10,
  });
  expect(receiptLinks(container)).toHaveLength(5);
  expect(container.textContent).not.toContain("Show more");
});

test("says when there are no payments yet", async () => {
  const container = await mount(
    <BillingReceiptsSection
      client={{ listBillingReceipts: async () => ({ receipts: [], nextCursor: null }) }}
      accountId={accountId}
    />,
  );
  expect(container.textContent).toContain("No payments yet");
});

test("a failed read offers Try again", async () => {
  let fail = true;
  const listBillingReceipts = mock(async () => {
    if (fail) throw new OpenGeniApiError(502, JSON.stringify({ error: "Stripe is unavailable" }));
    return { receipts: [receipt("ch_auto")], nextCursor: null };
  });
  const container = await mount(
    <BillingReceiptsSection client={{ listBillingReceipts }} accountId={accountId} />,
  );
  expect(container.textContent).toContain("Couldn't load receipts");
  fail = false;
  const retry = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  );
  await act(async () => retry!.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(receiptLinks(container)).toHaveLength(1);
});
