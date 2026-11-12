import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import type Stripe from "stripe";
import { listStripeReceipts } from "../src/billing-receipts";
import { registerBillingRoutes } from "../src/routes/billing";

const accountId = "7d6c2b1e-4a5f-4e3d-9c8b-1a2b3c4d5e6f";
const created = 1_790_000_000;

function charge(id: string, patch: Partial<Stripe.Charge> = {}): Stripe.Charge {
  return {
    id,
    object: "charge",
    created,
    amount: 2500,
    amount_refunded: 0,
    currency: "usd",
    paid: true,
    status: "succeeded",
    refunded: false,
    description: null,
    metadata: {},
    payment_intent: null,
    receipt_url: `https://pay.stripe.com/receipts/${id}`,
    ...patch,
  } as Stripe.Charge;
}

function invoice(id: string, paidBy: string, patch: Partial<Stripe.Invoice> = {}): Stripe.Invoice {
  return {
    id,
    object: "invoice",
    billing_reason: "manual",
    parent: null,
    metadata: {},
    hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
    invoice_pdf: `https://pay.stripe.com/invoice/${id}/pdf`,
    payments: {
      object: "list",
      data: [{ payment: { type: "payment_intent", payment_intent: paidBy } }],
      has_more: false,
      url: "",
    },
    ...patch,
  } as unknown as Stripe.Invoice;
}

function fakeStripe(charges: Stripe.Charge[], invoices: Stripe.Invoice[], hasMore = false) {
  const calls: { charges: unknown[]; invoices: unknown[] } = { charges: [], invoices: [] };
  const stripe = {
    charges: {
      list: async (params: unknown) => {
        calls.charges.push(params);
        return { object: "list", data: charges, has_more: hasMore, url: "" };
      },
    },
    invoices: {
      list: async (params: unknown) => {
        calls.invoices.push(params);
        return { object: "list", data: invoices, has_more: false, url: "" };
      },
    },
  } as unknown as Pick<Stripe, "charges" | "invoices">;
  return { stripe, calls };
}

describe("receipts from Stripe", () => {
  test("lists plan, credit and automatic top-up payments with their receipts", async () => {
    const autoTopUp = charge("ch_auto", {
      amount: 2750,
      payment_intent: {
        id: "pi_auto",
        metadata: { opengeni_auto_top_up_v1: "1", opengeni_account_id: accountId },
      } as unknown as Stripe.PaymentIntent,
    });
    const plan = charge("ch_plan", { payment_intent: "pi_plan", amount: 2000 });
    const credits = charge("ch_credits", {
      payment_intent: "pi_credits",
      amount: 5000,
      amount_refunded: 1000,
    });
    const refunded = charge("ch_refunded", {
      amount_refunded: 2500,
      refunded: true,
      metadata: { opengeni_credit_coupon_v1: "1" },
    });
    const failed = charge("ch_failed", { paid: false, status: "failed" });
    const other = charge("ch_other", { description: "  Setup fee " });
    const { stripe, calls } = fakeStripe(
      [autoTopUp, plan, credits, refunded, failed, other],
      [
        invoice("in_plan", "pi_plan", {
          billing_reason: "subscription_cycle",
          parent: { type: "subscription_details" } as Stripe.Invoice.Parent,
        }),
        invoice("in_credits", "pi_credits", { metadata: { opengeni_credit_coupon_v1: "1" } }),
      ],
    );

    const page = await listStripeReceipts(stripe, "cus_org", { limit: 10 });

    expect(calls.charges).toEqual([
      { customer: "cus_org", limit: 10, expand: ["data.payment_intent"] },
    ]);
    expect(calls.invoices).toHaveLength(1);
    expect(calls.invoices[0]).toMatchObject({ customer: "cus_org", expand: ["data.payments"] });
    expect(page.nextCursor).toBeNull();
    expect(page.receipts.map((receipt) => [receipt.id, receipt.kind, receipt.description])).toEqual(
      [
        ["ch_auto", "auto_top_up", "Automatic top-up"],
        ["ch_plan", "plan", "Plan"],
        ["ch_credits", "credits", "Credits"],
        ["ch_refunded", "credits", "Credits"],
        ["ch_other", "other", "Setup fee"],
      ],
    );
    expect(page.receipts[0]).toEqual({
      id: "ch_auto",
      createdAt: new Date(created * 1000).toISOString(),
      kind: "auto_top_up",
      description: "Automatic top-up",
      amount: 2750,
      currency: "usd",
      amountRefunded: 0,
      refunded: false,
      receiptUrl: "https://pay.stripe.com/receipts/ch_auto",
      invoiceUrl: null,
      invoicePdfUrl: null,
    });
    expect(page.receipts[1]).toMatchObject({
      invoiceUrl: "https://invoice.stripe.com/i/in_plan",
      invoicePdfUrl: "https://pay.stripe.com/invoice/in_plan/pdf",
    });
    expect(page.receipts[2]).toMatchObject({ amountRefunded: 1000, refunded: false });
    expect(page.receipts[3]).toMatchObject({ amountRefunded: 2500, refunded: true });
  });

  test("pages with the last charge Stripe returned and skips invoices for empty pages", async () => {
    const { stripe, calls } = fakeStripe([charge("ch_new"), charge("ch_old")], [], true);
    const page = await listStripeReceipts(stripe, "cus_org", { cursor: "ch_prev", limit: 2 });
    expect(calls.charges[0]).toMatchObject({ starting_after: "ch_prev", limit: 2 });
    expect(page.nextCursor).toBe("ch_old");

    const empty = fakeStripe([charge("ch_failed", { paid: false, status: "failed" })], []);
    expect(await listStripeReceipts(empty.stripe, "cus_org", { limit: 10 })).toEqual({
      receipts: [],
      nextCursor: null,
    });
    expect(empty.calls.invoices).toHaveLength(0);
  });
});

describe("GET /v1/billing/receipts", () => {
  const restore: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of restore.splice(0)) spy.mockRestore();
  });

  function app(billingMode: "stripe" | "disabled" = "stripe") {
    const routes = new Hono();
    registerBillingRoutes(routes, {
      settings: testSettings({ billingMode, stripeSecretKey: "sk_test_receipts" }),
      db: {} as db.Database,
    } as ApiRouteDeps);
    return routes;
  }

  function signedIn(permissions: string[]) {
    restore.push(
      spyOn(core, "requireAccessContext").mockResolvedValue({
        subjectId: "user:reader",
        defaultAccountId: accountId,
        accountGrants: [{ accountId, permissions }],
        workspaceGrants: [],
      } as never),
    );
  }

  test("is not served without Stripe billing", async () => {
    expect((await app("disabled").request("/v1/billing/receipts")).status).toBe(404);
  });

  test("requires billing:read on the organization", async () => {
    signedIn(["workspace:read"]);
    const lookup = spyOn(db, "withRlsContext");
    restore.push(lookup);
    const response = await app().request(`/v1/billing/receipts?accountId=${accountId}`);
    expect(response.status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
  });

  test("an organization without a Stripe customer has no receipts and gets none created", async () => {
    signedIn(["billing:read"]);
    restore.push(
      spyOn(db, "withRlsContext").mockImplementation(
        (async (_db: unknown, _scope: unknown, run: (tx: unknown) => Promise<unknown>) =>
          await run({})) as never,
      ),
      spyOn(db, "getBillingCustomer").mockResolvedValue(null as never),
    );
    const upsert = spyOn(db, "upsertBillingCustomer");
    restore.push(upsert);
    const response = await app().request(`/v1/billing/receipts?accountId=${accountId}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receipts: [], nextCursor: null });
    expect(upsert).not.toHaveBeenCalled();
  });

  test("rejects a malformed cursor or page size", async () => {
    signedIn(["billing:read"]);
    for (const query of ["cursor=in_123", "limit=0", "limit=51"]) {
      const response = await app().request(`/v1/billing/receipts?accountId=${accountId}&${query}`);
      expect(response.status).toBe(400);
    }
  });
});
